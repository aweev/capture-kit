import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Docs site builder (M5 reach).
 *
 * Turns `docs/*.md` plus a generated CLI/config reference into a small static
 * site with an index — shippable anywhere static files go. The Markdown
 * renderer is intentionally tiny (headings, code, lists, tables, links);
 * anything fancier belongs in a real SSG, which is out of scope.
 */

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function inline(s: string): string {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\s)\*([^*\n]+)\*/g, '$1<em>$2</em>');
}

/** Minimal Markdown → HTML for the docs subset (headings, lists, tables, code). */
export function renderMarkdown(md: string): string {
  const lines = md.split('\n');
  const html: string[] = [];
  let i = 0;
  let inCode = false;
  let inList = false;

  const closeList = () => {
    if (inList) {
      html.push('</ul>');
      inList = false;
    }
  };

  const renderTable = (): void => {
    const rows: string[][] = [];
    while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i] as string)) {
      const cells = (lines[i] as string)
        .trim()
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((c) => c.trim());
      if (!cells.every((c) => /^:?-+:?$/.test(c))) rows.push(cells);
      i++;
    }
    if (rows.length === 0) return;
    const header = rows[0] as string[];
    const body = rows.slice(1);
    html.push('<table><thead><tr>');
    for (const cell of header) html.push(`<th>${inline(cell)}</th>`);
    html.push('</tr></thead><tbody>');
    for (const row of body) {
      html.push(`<tr>${row.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`);
    }
    html.push('</tbody></table>');
  };

  while (i < lines.length) {
    const line = lines[i] as string;
    if (/^```/.test(line)) {
      if (inCode) html.push('</code></pre>');
      else {
        closeList();
        html.push('<pre><code>');
      }
      inCode = !inCode;
      i++;
      continue;
    }
    if (inCode) {
      html.push(esc(line));
      i++;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      closeList();
      renderTable();
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      const level = heading[1]!.length;
      html.push(`<h${level}>${inline(heading[2]!)}</h${level}>`);
      i++;
      continue;
    }
    if (/^\s*---+\s*$/.test(line)) {
      closeList();
      html.push('<hr />');
      i++;
      continue;
    }
    const bullet = /^\s*(?:[-*]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) {
      if (!inList) {
        html.push('<ul>');
        inList = true;
      }
      html.push(`<li>${inline(bullet[1]!)}</li>`);
      i++;
      continue;
    }
    if (line.trim() === '') {
      closeList();
      i++;
      continue;
    }
    closeList();
    html.push(`<p>${inline(line)}</p>`);
    i++;
  }
  closeList();
  if (inCode) html.push('</code></pre>');
  return html.join('\n');
}

const STYLE = `body{font-family:system-ui,sans-serif;max-width:760px;margin:0 auto;padding:24px;line-height:1.6}pre{background:#f4f4f5;padding:12px;border-radius:8px;overflow-x:auto}code{font-family:ui-monospace,monospace;font-size:.9em}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:6px 10px;text-align:left}nav{margin-bottom:24px;color:#555}nav a{margin-right:12px}`;

function page(title: string, nav: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><title>${esc(title)}</title><style>${STYLE}</style></head><body><nav>${nav}</nav>${body}</body></html>\n`;
}

/** Build the site from a docs directory into an output directory. */
export async function buildDocsSite(options: {
  docsDir?: string;
  outDir: string;
  title?: string;
}): Promise<{ pages: string[]; outDir: string }> {
  const docsDir = options.docsDir ?? path.join(process.cwd(), 'docs');
  const outDir = path.resolve(options.outDir);
  let files: string[];
  try {
    files = (await readdir(docsDir)).filter((f) => f.endsWith('.md')).sort();
  } catch {
    throw new Error(`Docs directory not found: ${docsDir}.`);
  }
  await mkdir(outDir, { recursive: true });
  const nav = files.map((f) => `<a href="./${f.replace(/\.md$/, '.html')}">${esc(f.replace(/\.md$/, ''))}</a>`).join('');
  const pages: string[] = [];
  for (const file of files) {
    const md = await readFile(path.join(docsDir, file), 'utf8');
    const name = file.replace(/\.md$/, '');
    await writeFile(
      path.join(outDir, `${name}.html`),
      page(`${options.title ?? 'Capturekit docs'} — ${name}`, `<a href="./index.html">index</a>${nav}`, renderMarkdown(md)),
      'utf8',
    );
    pages.push(`${name}.html`);
  }
  const index = `<h1>${esc(options.title ?? 'Capturekit docs')}</h1><ul>${files.map((f) => `<li><a href="./${f.replace(/\.md$/, '.html')}">${esc(f.replace(/\.md$/, ''))}</a></li>`).join('')}</ul>`;
  await writeFile(path.join(outDir, 'index.html'), page(options.title ?? 'Capturekit docs', '', index), 'utf8');
  pages.push('index.html');
  return { pages, outDir };
}
