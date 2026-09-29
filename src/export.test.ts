import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createZip, exportZip, summaryHtml } from './export.ts';

describe('export.ts', () => {
  it('createZip emits a readable stored archive', () => {
    const zip = createZip([{ name: 'a.txt', data: Buffer.from('hello') }]);
    expect(zip.subarray(0, 4).toString('hex')).toBe('504b0304');
    expect(zip.includes(Buffer.from('hello'))).toBe(true);
    expect(zip.includes(Buffer.from('a.txt'))).toBe(true);
  });

  it('exportZip writes only existing files', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ck-export-'));
    try {
      const { writeFile, mkdir } = await import('node:fs/promises');
      await mkdir(path.join(dir, 'screenshots', 'home'), { recursive: true });
      await writeFile(path.join(dir, 'manifest.json'), '{}');
      await writeFile(path.join(dir, 'screenshots', 'home', 'mobile.png'), Buffer.from([1, 2, 3]));
      const dest = await exportZip(
        { assets: [{ path: 'screenshots/home/mobile.png' }, { path: 'missing.png' }] },
        dir,
      );
      const data = await readFile(dest);
      expect(data.subarray(0, 2).toString()).toBe('PK');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('summaryHtml lists assets and print hint', () => {
    const html = summaryHtml({
      title: 'T',
      target: 'http://x',
      startedAt: '2026-01-01',
      summary: { planned: 2, succeeded: 1, failed: 1 },
      assets: [{ page: '/', viewport: 'mobile', path: 's/a.png' }],
    });
    expect(html).toContain('1/2 succeeded');
    expect(html).toContain('Print this page to PDF');
  });
});
