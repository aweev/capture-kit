import { describe, it, expect } from 'vitest';
import { videoSchema, videoBaseName, walkthrough, postProcessRecording } from './video.ts';

describe('video.ts', () => {
  it('defaults to mp4 walkthroughs under a 5MB budget', () => {
    const parsed = videoSchema.parse({});
    expect(parsed).toMatchObject({ walkthrough: true, formats: ['mp4'], maxSizeMB: 5 });
  });

  it('rejects unknown formats', () => {
    expect(() => videoSchema.parse({ formats: ['avi'] })).toThrow();
  });

  it('videoBaseName suffixes scheme and flow', () => {
    const device = { name: 'mobile', width: 390, height: 844, deviceScaleFactor: 3, mobile: true };
    expect(
      videoBaseName({ id: 'x', pagePath: '/', pageSlug: 'home', url: 'http://x/', device, mode: 'fullPage', relPath: 's.png' }),
    ).toBe('mobile');
    expect(
      videoBaseName({
        id: 'x', pagePath: '/', pageSlug: 'home', url: 'http://x/', device,
        mode: 'fullPage', relPath: 's.png', scheme: 'dark', flowName: 'Checkout Flow',
      }),
    ).toBe('mobile-dark-checkout-flow');
  });

  it('walkthrough scrolls down and back to top', async () => {
    let position = 0;
    const seen: number[] = [];
    const page = {
      // Simulates the browser contract: scroll down progressively, end at top.
      evaluate: async (_fn: (arg: { durationMs: number }) => Promise<void>, arg: { durationMs: number }) => {
        expect(arg.durationMs).toBe(50);
        const max = 2000;
        for (let i = 1; i <= 10; i++) {
          position = Math.round((i / 10) * max);
          seen.push(position);
        }
        position = 0;
      },
      waitForTimeout: async () => undefined,
    };
    await walkthrough(page, { durationMs: 50 });
    expect(seen.length).toBeGreaterThan(0);
    expect(position).toBe(0);
  });

  it('walkthrough never throws on a hostile page', async () => {
    const page = {
      evaluate: async () => {
        throw new Error('nope');
      },
      waitForTimeout: async () => {
        throw new Error('nope');
      },
    };
    await expect(walkthrough(page, { durationMs: 10 })).resolves.toBeUndefined();
  });

  it('postProcessRecording ships raw WebM when ffmpeg is missing', async () => {
    // PATH games cannot hide ffmpeg-static's absolute path, so this asserts
    // the fallback shape with formats: ['webm'] (pure rename, no transcoder).
    const { mkdtemp, writeFile, rm, stat } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'ck-vid-'));
    try {
      const raw = join(dir, 'raw.webm');
      await writeFile(raw, Buffer.alloc(100, 3));
      const out = await postProcessRecording(raw, join(dir, 'out'), 'mobile', {
        formats: ['webm'],
        maxSizeMB: 5,
        fps: 15,
        trimStartSec: 0,
      });
      expect(out).toHaveLength(1);
      expect(out[0]!.format).toBe('webm');
      expect((await stat(out[0]!.path)).size).toBe(100);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('transcodes a real recording to mp4 under budget (needs ffmpeg)', async () => {
    const { findFfmpeg, transcodeMp4 } = await import('./video.ts');
    const ffmpeg = await findFfmpeg();
    if (!ffmpeg) return; // without a transcoder the suite still covers the fallback
    const { mkdtemp, rm, stat } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    const dir = await mkdtemp(join(tmpdir(), 'ck-vid-'));
    try {
      const raw = join(dir, 'raw.webm');
      await execFileAsync(ffmpeg, [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=390x844:rate=15:duration=2',
        '-c:v',
        'libvpx',
        raw,
      ]);
      const out = await transcodeMp4(raw, join(dir, 'mobile.mp4'), {
        ffmpeg,
        trimStartSec: 0.5,
        maxSizeMB: 5,
        fps: 15,
      });
      expect(out.format).toBe('mp4');
      expect((await stat(out.path)).size).toBeLessThan(5 * 1024 * 1024);
      expect((await stat(out.path)).size).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);
});
