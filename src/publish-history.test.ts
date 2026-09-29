import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { publishRun } from './publish.ts';
import { listRuns, matchAssets, sliderHtml } from './history.ts';
import type { Manifest } from './manifest.ts';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ck-pub-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function manifest(runId: string, assets: { page: string; viewport: string; path: string }[]): Manifest {
  return {
    schemaVersion: 1,
    runId,
    startedAt: '2026-01-01T00:00:00Z',
    finishedAt: '2026-01-01T00:00:01Z',
    durationMs: 1000,
    target: 'http://x',
    tool: { name: 'capturekit', version: '0', chromium: 'c' },
    config: { source: 't', concurrency: 1, viewports: ['mobile'] },
    summary: {
      planned: assets.length,
      succeeded: assets.length,
      failed: 0,
      retried: 0,
      durationMs: 1000,
    },
    assets: assets.map((a) => ({
      ...a,
      type: 'screenshot' as const,
      width: 10,
      height: 10,
      deviceScaleFactor: 1,
      fullPage: true,
      format: 'png' as const,
      bytes: 3,
      contentHeight: 10,
      attempts: 1,
      durationMs: 1,
      strategy: 's',
    })),
    failures: [],
  };
}

async function runDir(name: string, assets: { page: string; viewport: string; path: string }[]): Promise<string> {
  const run = path.join(dir, name);
  await mkdir(path.join(run, 'screenshots/home'), { recursive: true });
  await writeFile(path.join(run, 'manifest.json'), JSON.stringify(manifest(name.slice(-6), assets)));
  await writeFile(path.join(run, assets[0]!.path), 'img');
  return run;
}

describe('publish.ts + history.ts', () => {
  it('folder copies the run; github-pages adds .nojekyll', async () => {
    const run = await runDir('2026-01-01T00-00-00_aaaaaa', [
      { page: '/', viewport: 'mobile', path: 'screenshots/home/mobile.png' },
    ]);
    const receipt = await publishRun(run, { type: 'folder', dest: path.join(dir, 'out') }, { cwd: dir });
    expect(receipt.type).toBe('folder');
    await expect(stat(path.join(dir, 'out', 'manifest.json'))).resolves.toBeDefined();
    await publishRun(run, { type: 'github-pages', dest: path.join(dir, 'site') }, { cwd: dir });
    await expect(stat(path.join(dir, 'site', '.nojekyll'))).resolves.toBeDefined();
  });

  it('netlify/vercel stage a folder with deploy instructions', async () => {
    const run = await runDir('2026-01-01T00-00-00_bbbbbb', [
      { page: '/', viewport: 'mobile', path: 'screenshots/home/mobile.png' },
    ]);
    const receipt = await publishRun(run, { type: 'netlify', dest: path.join(dir, 'dist') }, { cwd: dir });
    expect(receipt.detail).toContain('netlify deploy');
    expect(await readFile(path.join(dir, 'dist', 'DEPLOY.txt'), 'utf8')).toContain('netlify deploy');
  });

  it('s3 without the AWS CLI fails with install instructions', async () => {
    const run = await runDir('2026-01-01T00-00-00_cccccc', [
      { page: '/', viewport: 'mobile', path: 'screenshots/home/mobile.png' },
    ]);
    const withPath = { ...process.env, PATH: '' };
    const realEnv = process.env;
    process.env = withPath as NodeJS.ProcessEnv;
    try {
      await expect(publishRun(run, { type: 's3', bucket: 'b', prefix: '' })).rejects.toThrow(
        /AWS CLI|aws s3 sync failed/,
      );
    } finally {
      process.env = realEnv;
    }
  });

  it('listRuns skips partial folders; matchAssets pairs by page+viewport', async () => {
    await runDir('2026-01-01T00-00-00_aaaaaa', [
      { page: '/', viewport: 'mobile', path: 'screenshots/home/mobile.png' },
    ]);
    await mkdir(path.join(dir, '2026-01-01T00-00-01_bbbbbb'));
    const runs = await listRuns(dir);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.runId).toBe('aaaaaa');
    await expect(listRuns(path.join(dir, 'missing'))).resolves.toEqual([]);

    const a = manifest('a', [{ page: '/', viewport: 'mobile', path: 's/a.png' }]);
    const b = manifest('b', [
      { page: '/', viewport: 'mobile', path: 's/a2.png' },
      { page: '/new', viewport: 'mobile', path: 's/n.png' },
    ]);
    expect(matchAssets(a, b)).toEqual([
      { page: '/', viewport: 'mobile', before: 's/a.png', after: 's/a2.png' },
    ]);
  });

  it('sliderHtml renders an accessible slider per pair', () => {
    const html = sliderHtml({
      title: 'Compare',
      beforeLabel: 'old',
      afterLabel: 'new',
      pairs: [{ page: '/', viewport: 'mobile', before: 'b.png', after: 'a.png', beforeUrl: 'b.png', afterUrl: 'a.png' }],
    });
    expect(html).toContain('type="range"');
    expect(html).toContain('clip-path');
    expect(html).toContain('Before: / on mobile');
    expect(sliderHtml({ title: 't', beforeLabel: 'a', afterLabel: 'b', pairs: [] })).toContain(
      'No matching captures',
    );
  });
});
