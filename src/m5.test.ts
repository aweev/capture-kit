import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadPlugins, applyPostprocessors, applyDiscoverers } from './plugins.ts';
import { renderMarkdown, buildDocsSite } from './docs-site.ts';
import { watchAndRerun } from './watch.ts';
import { parseConfig } from './config.ts';
import { handleHook } from './commands/serve.ts';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ck-m5-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('plugins.ts', () => {
  it('loads hook modules and runs postprocessors per file', async () => {
    const pluginFile = path.join(dir, 'plugin.mjs');
    await writeFile(
      pluginFile,
      `export const name = "test-plugin";\nexport async function postprocessor(file) { globalThis.__ckSeen = [...(globalThis.__ckSeen ?? []), file]; }\n`,
      'utf8',
    );
    const plugins = await loadPlugins([pluginFile], dir);
    expect(plugins).toHaveLength(1);
    expect(plugins[0]!.name).toBe('test-plugin');
    (globalThis as Record<string, unknown>).__ckSeen = [];
    await applyPostprocessors(plugins, ['a.png', 'b.png']);
    expect((globalThis as Record<string, unknown>).__ckSeen).toEqual(['a.png', 'b.png']);
    delete (globalThis as Record<string, unknown>).__ckSeen;
  });

  it('a failing postprocessor warns instead of throwing', async () => {
    const pluginFile = path.join(dir, 'bad.mjs');
    await writeFile(pluginFile, `export async function postprocessor() { throw new Error("boom"); }\n`, 'utf8');
    const plugins = await loadPlugins([pluginFile], dir);
    const warnings: string[] = [];
    await expect(
      applyPostprocessors(plugins, ['a.png'], (message) => warnings.push(message)),
    ).resolves.toBeUndefined();
    expect(warnings.join(' ')).toContain('test-plugin'.slice(0, 0) + 'bad.mjs');
  });

  it('rejects missing modules and non-function hooks', async () => {
    await expect(loadPlugins(['./missing.mjs'], dir)).rejects.toThrow('Could not load plugin');
    const bad = path.join(dir, 'bad2.mjs');
    await writeFile(bad, `export const postprocessor = 42;\n`, 'utf8');
    await expect(loadPlugins([bad], dir)).rejects.toThrow('must be a function');
  });

  it('applyDiscoverers merges sources and tolerates failures', async () => {
    const good = path.join(dir, 'good.mjs');
    const bad = path.join(dir, 'bad3.mjs');
    await writeFile(good, `export async function discoverer() { return ["/extra"]; }\n`, 'utf8');
    await writeFile(bad, `export async function discoverer() { throw new Error("x"); }\n`, 'utf8');
    const plugins = await loadPlugins([good, bad], dir);
    const pages = await applyDiscoverers(
      plugins,
      { target: 'http://x', base: new URL('http://x'), pages: ['/'] },
      () => undefined,
    );
    expect(pages).toEqual(['/extra']);
  });
});

describe('docs-site.ts', () => {
  it('renders headings, code, lists, tables, and links', () => {
    const html = renderMarkdown(
      '# Title\n\nSome **bold** and `code` and [link](./a).\n\n- one\n- two\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```js\nconst x = 1;\n```',
    );
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<a href="./a">link</a>');
    expect(html).toContain('<th>A</th>');
    expect(html).toContain('<td>1</td>');
    expect(html).toContain('<pre><code>');
  });

  it('builds a site with an index', async () => {
    const docs = path.join(dir, 'docs');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(docs, { recursive: true });
    await writeFile(path.join(docs, 'GUIDE.md'), '# Guide\n\nHello.\n', 'utf8');
    const result = await buildDocsSite({ docsDir: docs, outDir: path.join(dir, 'site') });
    expect(result.pages).toContain('index.html');
    expect(result.pages).toContain('GUIDE.html');
  });

  it('fails clearly for a missing docs dir', async () => {
    await expect(buildDocsSite({ docsDir: path.join(dir, 'nope'), outDir: path.join(dir, 's') })).rejects.toThrow(
      'not found',
    );
  });
});

describe('M5 config', () => {
  it('routes/publish/plugins default to empty', () => {
    const config = parseConfig({ target: 'http://localhost:3000' }, 'test');
    expect(config.routes.projectPath).toBeUndefined();
    expect(config.publish).toEqual([]);
    expect(config.plugins).toEqual([]);
  });

  it('accepts routes + publish + plugins', () => {
    const config = parseConfig(
      {
        target: 'http://localhost:3000',
        routes: { projectPath: './app' },
        publish: [{ type: 'folder', dest: './out' }],
        plugins: ['./plugin.mjs'],
      },
      'test',
    );
    expect(config.routes.projectPath).toBe('./app');
    expect(config.publish).toHaveLength(1);
    expect(config.plugins).toEqual(['./plugin.mjs']);
  });
});

describe('watch.ts', () => {
  it('reruns on file change, debounced, and stops', async () => {
    const watchDir = await mkdtemp(path.join(tmpdir(), 'ck-watch-'));
    try {
      let calls = 0;
      const handle = watchAndRerun(
        { watchPath: watchDir, outDir: path.join(watchDir, 'captures'), debounceMs: 100 },
        async () => {
          calls++;
          return { exitCode: 0 };
        },
      );
      await writeFile(path.join(watchDir, 'a.txt'), '1', 'utf8');
      await writeFile(path.join(watchDir, 'b.txt'), '2', 'utf8');
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(calls).toBe(1);
      handle.stop();
      await writeFile(path.join(watchDir, 'c.txt'), '3', 'utf8');
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(calls).toBe(1);
    } finally {
      await rm(watchDir, { recursive: true, force: true });
    }
  });
});

describe('serve handleHook', () => {
  function req(url: string, method = 'GET', headers: Record<string, string> = {}) {
    return { url, method, headers };
  }
  function res() {
    const chunks: string[] = [];
    return {
      headersSent: false as boolean,
      status: 0,
      body: '',
      writeHead(code: number) {
        this.status = code;
        return this;
      },
      end(data = '') {
        chunks.push(data);
        this.body = chunks.join('');
      },
    };
  }

  it('answers health and 404s unknown paths', async () => {
    const r1 = res();
    await handleHook(req('/health') as never, r1 as never, {
      busy: () => false,
      capture: async () => 0,
      log: () => undefined,
    });
    expect(r1.status).toBe(200);
    const r2 = res();
    await handleHook(req('/nope') as never, r2 as never, {
      busy: () => false,
      capture: async () => 0,
      log: () => undefined,
    });
    expect(r2.status).toBe(404);
  });

  it('enforces the secret and the busy gate', async () => {
    const deps = { secret: 's3cret', busy: () => false, capture: async () => 0, log: () => undefined };
    const r1 = res();
    await handleHook(req('/hook', 'POST') as never, r1 as never, deps);
    expect(r1.status).toBe(401);
    const r2 = res();
    await handleHook(req('/hook?secret=s3cret', 'POST') as never, r2 as never, deps);
    expect(r2.status).toBe(200);
    expect(r2.body).toBe('captured');
    const r3 = res();
    await handleHook(req('/hook?secret=s3cret', 'POST') as never, r3 as never, {
      ...deps,
      busy: () => true,
    });
    expect(r3.status).toBe(409);
  });

  it('reports capture failures as 500', async () => {
    const r = res();
    await handleHook(req('/hook', 'POST') as never, r as never, {
      busy: () => false,
      capture: async () => 1,
      log: () => undefined,
    });
    expect(r.status).toBe(500);
  });
});
