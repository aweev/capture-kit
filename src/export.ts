import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Exports (FR-32): ZIP of assets, single PDF summary, Markdown snippet.
 *
 * - ZIP is a dependency-free stored (uncompressed) writer: Node has no built-in
 *   zip, and pulling in `archiver` for M2 would burden every install. Stored
 *   entries open everywhere; screenshots are already compressed so the size
 *   difference is negligible.
 * - PDF summary is a print-ready HTML file (`summary.html`, print-to-PDF).
 *   Generating real PDFs needs a native dependency; the HTML prints identically
 *   and stays portable + testable.
 * - Markdown snippet lives in `branding.ts`; this module writes the files.
 */

function crc32(buf: Buffer): number {
  let table = (crc32 as unknown as { t?: Int32Array }).t;
  if (!table) {
    table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
    (crc32 as unknown as { t: Int32Array }).t = table;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Minimal stored-ZIP writer (no compression, UTF-8 names). */
export function createZip(files: { name: string; data: Buffer }[]): Buffer {
  const encoder = new TextEncoder();
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(encoder.encode(f.name));
    const crc = crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(f.data.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, f.data);
    const cent = Buffer.alloc(46);
    cent.writeUInt32LE(0x02014b50, 0);
    cent.writeUInt16LE(20, 4);
    cent.writeUInt16LE(20, 6);
    cent.writeUInt16LE(0x0800, 8);
    cent.writeUInt16LE(0, 10);
    cent.writeUInt16LE(0, 12);
    cent.writeUInt16LE(0, 14);
    cent.writeUInt32LE(crc, 16);
    cent.writeUInt32LE(f.data.length, 20);
    cent.writeUInt32LE(f.data.length, 24);
    cent.writeUInt16LE(name.length, 28);
    for (let i = 30; i < 46; i++) cent[i] = 0;
    cent.writeUInt32LE(offset, 42);
    central.push(cent, name);
    offset += local.length + name.length + f.data.length;
  }
  const centralStart = offset;
  const centralSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralStart, 16);
  return Buffer.concat([...chunks, ...central, end]);
}

export type ExportInput = {
  runDir: string;
  outFile?: string;
  include?: string[];
};

/** Collect run files (manifest + screenshots + snippet) and write a ZIP. */
export async function exportZip(
  manifest: { assets: { path: string }[] },
  runDir: string,
  outFile?: string,
): Promise<string> {
  const files: { name: string; data: Buffer }[] = [];
  const queue = ['manifest.json', ...manifest.assets.map((a) => a.path)];
  for (const rel of queue) {
    try {
      const data = await readFile(path.join(runDir, rel));
      files.push({ name: rel, data });
    } catch {
      /* a missing asset must not fail the export */
    }
  }
  const zip = createZip(files);
  const dest = outFile ?? path.join(runDir, 'assets.zip');
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, zip);
  return dest;
}

/** Print-ready summary (open in a browser, print to PDF). */
export function summaryHtml(options: {
  title: string;
  target: string;
  startedAt: string;
  summary: { planned: number; succeeded: number; failed: number };
  assets: { page: string; viewport: string; path: string }[];
}): string {
  const rows = options.assets
    .map((a) => `<tr><td>${a.page}</td><td>${a.viewport}</td><td>${a.path}</td></tr>`)
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf8" /><title>${options.title} — capture summary</title><style>body{font-family:system-ui,sans-serif;max-width:800px;margin:24px auto;padding:0 16px}@media print{.no-print{display:none}}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:6px 8px;text-align:left;font-size:13px}</style></head><body><h1>${options.title}</h1><p>Target: ${options.target}<br />Captured: ${options.startedAt}<br />${options.summary.succeeded}/${options.summary.planned} succeeded, ${options.summary.failed} failed</p><table><thead><tr><th>Page</th><th>Viewport</th><th>Asset</th></tr></thead><tbody>${rows}</tbody></table><p class="no-print">Print this page to PDF for client delivery.</p></body></html>\n`;
}

export async function writeSummary(runDir: string, html: string): Promise<string> {
  const dest = path.join(runDir, 'summary.html');
  await writeFile(dest, html, 'utf8');
  return dest;
}
