import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { waitForHealth, spawnApp, teardownApp, startAndCapture } from './start.ts';
import { startSchema } from './start-config.ts';
import { CaptureKitError } from './exit.ts';

function serve(status = 200): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(status).end('ok');
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/health`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

describe('start.ts', () => {
  describe('startSchema', () => {
    it('accepts a minimal boot config with defaults', () => {
      const parsed = startSchema.parse({
        command: 'npm run dev',
        waitOn: 'http://localhost:3000/health',
      });
      expect(parsed.timeoutMs).toBe(60000);
      expect(parsed.intervalMs).toBe(500);
    });

    it('rejects empty commands and non-URLs', () => {
      expect(() =>
        startSchema.parse({ command: '', waitOn: 'http://localhost:3000/health' }),
      ).toThrow();
      expect(() => startSchema.parse({ command: 'npm run dev', waitOn: 'not-a-url' })).toThrow();
    });
  });

  describe('waitForHealth', () => {
    it('resolves once the server answers', async () => {
      const { url, close } = await serve();
      try {
        await expect(
          waitForHealth(url, { timeoutMs: 5000, intervalMs: 50 }),
        ).resolves.toBeUndefined();
      } finally {
        await close();
      }
    });

    it('treats error statuses as up (the server is listening)', async () => {
      const { url, close } = await serve(500);
      try {
        await expect(
          waitForHealth(url, { timeoutMs: 5000, intervalMs: 50 }),
        ).resolves.toBeUndefined();
      } finally {
        await close();
      }
    });

    it('fails with a CaptureKitError past the timeout', async () => {
      await expect(
        waitForHealth('http://127.0.0.1:1/health', { timeoutMs: 300, intervalMs: 50 }),
      ).rejects.toBeInstanceOf(CaptureKitError);
    });
  });

  describe('spawnApp + teardownApp', () => {
    it('tears down a long-running child', async () => {
      const child = spawnApp(process.execPath, { env: {} });
      // Replace with a sleeper: kill the placeholder first.
      await teardownApp(child);
      const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore',
      });
      expect(sleeper.exitCode).toBeNull();
      await teardownApp(sleeper);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(sleeper.signalCode ?? sleeper.exitCode).not.toBeNull();
    });

    it('teardown of an exited child is a no-op', async () => {
      const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
      await new Promise((resolve) => child.once('exit', () => resolve(undefined)));
      await expect(teardownApp(child)).resolves.toBeUndefined();
      await expect(teardownApp(undefined)).resolves.toBeUndefined();
    });

    it('teardown kills the whole tree spawned via a shell', async () => {
      // A temp server file avoids cmd.exe quoting pitfalls and mirrors real
      // usage (`start.command` is a shell command like `node server.mjs`).
      const { writeFile, rm } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const serverFile = join(tmpdir(), `ck-tree-test-${process.pid}.mjs`);
      await writeFile(
        serverFile,
        `import http from 'node:http';\nhttp.createServer((q, r) => r.end('ok')).listen(Number(process.argv[2]));\n`,
        'utf8',
      );
      const port = 42331;
      const child = spawnApp(`node "${serverFile}" ${port}`);
      try {
        try {
          await waitForHealth(`http://127.0.0.1:${port}/`, { timeoutMs: 10000, intervalMs: 100 });
        } catch {
          throw new Error('shell-spawned server never came up');
        }
        await teardownApp(child);
        await new Promise((resolve) => setTimeout(resolve, 500));
        await expect(
          waitForHealth(`http://127.0.0.1:${port}/`, { timeoutMs: 500, intervalMs: 100 }),
        ).rejects.toBeInstanceOf(CaptureKitError);
      } finally {
        await teardownApp(child);
        await rm(serverFile, { force: true });
      }
    });
  });

  describe('startAndCapture', () => {
    it('waits, captures, and tears down (deps injected)', async () => {
      const events: string[] = [];
      const fakeChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore',
      });
      const result = await startAndCapture(
        { command: 'x', waitOn: 'http://x/health', timeoutMs: 5000, intervalMs: 50, env: {} },
        { url: 'http://example.test' },
        {
          spawn: () => {
            events.push('spawn');
            return fakeChild;
          },
          wait: async () => {
            events.push('wait');
          },
          teardown: async () => {
            events.push('teardown');
            await teardownApp(fakeChild);
          },
          capture: (async () => {
            events.push('capture');
            return { exitCode: 0 } as never;
          }) as never,
        },
      );
      expect(result.exitCode).toBe(0);
      expect(events).toEqual(['spawn', 'wait', 'capture', 'teardown']);
    });

    it('tears down even when the capture throws', async () => {
      let tornDown = false;
      const fakeChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore',
      });
      try {
        await expect(
          startAndCapture(
            { command: 'x', waitOn: 'http://x/health', timeoutMs: 5000, intervalMs: 50, env: {} },
            {},
            {
              spawn: () => fakeChild,
              wait: async () => undefined,
              teardown: async () => {
                tornDown = true;
                await teardownApp(fakeChild);
              },
              capture: (async () => {
                throw new Error('capture blew up');
              }) as never,
            },
          ),
        ).rejects.toThrow('capture blew up');
        expect(tornDown).toBe(true);
      } finally {
        await teardownApp(fakeChild);
      }
    });

    it('fails fast when the app exits immediately', async () => {
      await expect(
        startAndCapture(
          { command: 'x', waitOn: 'http://x/health', timeoutMs: 5000, intervalMs: 50, env: {} },
          {},
          {
            spawn: () => spawn(process.execPath, ['-e', 'process.exit(3)'], { stdio: 'ignore' }),
            wait: async () => undefined,
            capture: (async () => ({ exitCode: 0 }) as never) as never,
          },
        ),
      ).rejects.toBeInstanceOf(CaptureKitError);
    });
  });
});
