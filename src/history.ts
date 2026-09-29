import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { Manifest } from './manifest.ts';

/**
 * Run history and before/after comparison (FR-33).
 *
 * Every run folder is self-describing, so history is just a tolerant listing:
 * folders matching the run shape with a readable manifest. The before/after
 * slider is a zero-dependency HTML fragment comparing two runs' matching
 * assets (same page + viewport), written to `compare.html` on demand.
 */

const RUN_DIR_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}_[0-9a-f]{6}$/;

export type HistoryEntry = {
  dirName: string;
  runId: string;
  target: string;
  startedAt: string;
  planned: number;
  succeeded: number;
  failed: number;
};

/** Newest last. Unreadable folders are skipped, never fatal. */
export async function listRuns(outDir: string): Promise<HistoryEntry[]> {
  let entries: string[];
  try {
    entries = await readdir(outDir);
  } catch {
    return [];
  }
  const runs = entries.filter((e) => RUN_DIR_PATTERN.test(e)).sort();
  const history: HistoryEntry[] = [];
  for (const dirName of runs) {
    try {
      const manifest = JSON.parse(
        await readFile(path.join(outDir, dirName, 'manifest.json'), 'utf8'),
      ) as Manifest;
      history.push({
        dirName,
        runId: manifest.runId,
        target: manifest.target,
        startedAt: manifest.startedAt,
        planned: manifest.summary.planned,
        succeeded: manifest.summary.succeeded,
        failed: manifest.summary.failed,
      });
    } catch {
      /* a partial run is not history yet */
    }
  }
  return history;
}

export type ComparePair = {
  page: string;
  viewport: string;
  before: string;
  after: string;
};

/** Match assets across two manifests by page + viewport (+ scheme). */
export function matchAssets(before: Manifest, after: Manifest): ComparePair[] {
  const key = (a: { page: string; viewport: string; scheme?: string }) =>
    `${a.page}\0${a.viewport}\0${a.scheme ?? 'light'}`;
  const afterByKey = new Map(after.assets.map((a) => [key(a), a.path]));
  const pairs: ComparePair[] = [];
  for (const asset of before.assets) {
    const match = afterByKey.get(key(asset));
    if (match) {
      pairs.push({ page: asset.page, viewport: asset.viewport, before: asset.path, after: match });
    }
  }
  pairs.sort((a, b) => (a.page < b.page ? -1 : 1) || (a.viewport < b.viewport ? -1 : 1));
  return pairs;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Before/after slider page. Callers resolve each pair to absolute `beforeUrl`
 * / `afterUrl` values (hosted gallery URLs, file paths, or data URLs) —
 * this fragment only renders the comparison UI around them.
 */
export function sliderHtml(options: {
  title: string;
  beforeLabel: string;
  afterLabel: string;
  pairs: (ComparePair & { beforeUrl: string; afterUrl: string })[];
}): string {
  const figures = options.pairs
    .map(
      (p) => `<figure style="margin:0 0 24px">
  <figcaption style="font:13px system-ui;color:#555;margin-bottom:6px">${esc(p.page)} · ${esc(p.viewport)}</figcaption>
  <div class="ck-compare" style="position:relative;overflow:hidden;border:1px solid #ddd;border-radius:8px">
    <img src="${esc(p.afterUrl)}" alt="After: ${esc(p.page)} on ${esc(p.viewport)}" style="display:block;width:100%" />
    <img class="ck-before" src="${esc(p.beforeUrl)}" alt="Before: ${esc(p.page)} on ${esc(p.viewport)}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;clip-path:inset(0 50% 0 0)" />
    <input type="range" min="0" max="100" value="50" aria-label="Before/after slider for ${esc(p.page)}" style="position:absolute;inset:0;width:100%;opacity:0;cursor:ew-resize;margin:0" oninput="this.parentNode.querySelector('.ck-before').style.clipPath='inset(0 '+(100-this.value)+'% 0 0)'" />
    <span aria-hidden="true" style="position:absolute;top:8px;left:8px;background:#000;color:#fff;font:11px system-ui;padding:2px 8px;border-radius:4px">${esc(options.beforeLabel)}</span>
    <span aria-hidden="true" style="position:absolute;top:8px;right:8px;background:#0F62FE;color:#fff;font:11px system-ui;padding:2px 8px;border-radius:4px">${esc(options.afterLabel)}</span>
  </div>
</figure>`,
    )
    .join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><title>${esc(options.title)}</title></head><body style="font-family:system-ui,sans-serif;max-width:1000px;margin:0 auto;padding:24px"><h1>${esc(options.title)}</h1><p style="color:#555">Drag the slider on any capture to compare ${esc(options.beforeLabel)} (left) with ${esc(options.afterLabel)} (right).</p>${figures || '<p>No matching captures between the two runs.</p>'}</body></html>\n`;
}
