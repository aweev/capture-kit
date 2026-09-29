import { z } from 'zod';

/**
 * Gallery theming (FR-31) + export content (FR-32).
 *
 * The full static gallery (`index.html`) lands in M1; this module owns the
 * client-delivery layer on top of it so M1 stays unblocked: brand resolution,
 * the themed page shell (logo, accent, title, client, footer), and the
 * README/PR-comment Markdown snippet. Zero external dependencies (FR-30).
 */

export const gallerySchema = z
  .object({
    title: z.string().min(1).max(120).default('Capturekit gallery'),
    client: z.string().min(1).max(120).optional(),
    brand: z
      .object({
        logo: z.string().min(1).optional(),
        accent: z
          .string()
          .regex(/^#[0-9a-fA-F]{3,8}$/, 'accent must be a hex color like #0F62FE')
          .optional(),
      })
      .strict()
      .default({}),
    footer: z.string().max(300).optional(),
  })
  .strict();

export type GalleryConfig = z.infer<typeof gallerySchema>;

export type ResolvedBrand = {
  title: string;
  client?: string;
  logo?: string;
  accent: string;
  footer?: string;
};

export function resolveBrand(raw: GalleryConfig | undefined): ResolvedBrand {
  if (!raw) return { title: 'Capturekit gallery', accent: '#0F62FE' };
  return {
    title: raw.title,
    ...(raw.client ? { client: raw.client } : {}),
    ...(raw.brand.logo ? { logo: raw.brand.logo } : {}),
    accent: raw.brand.accent ?? '#0F62FE',
    ...(raw.footer ? { footer: raw.footer } : {}),
  };
}

/** Escape for HTML text/attribute interpolation. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Themed shell for a gallery page. `bodyHtml` is the M1 gallery grid; this
 * wraps it with header/footer/brand so white-label delivery works regardless
 * of who renders the grid.
 */
export function themedShell(brand: ResolvedBrand, bodyHtml: string): string {
  const header = `<header class="ck-brand" style="border-top:4px solid ${esc(brand.accent)}"><div class="ck-brand-row">${brand.logo ? `<img class="ck-brand-logo" src="${esc(brand.logo)}" alt="Client logo" />` : ''}<div><h1 class="ck-title">${esc(brand.title)}</h1>${brand.client ? `<p class="ck-client">${esc(brand.client)}</p>` : ''}</div></div></header>`;
  const footer = brand.footer ? `<footer class="ck-footer">${esc(brand.footer)}</footer>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><title>${esc(brand.title)}</title><style>:root{--ck-accent:${esc(brand.accent)}}body{font-family:system-ui,sans-serif;margin:0 auto;max-width:1100px;padding:24px}.ck-brand-row{display:flex;gap:16px;align-items:center}.ck-brand-logo{height:40px}.ck-title{margin:8px 0 0;font-size:1.4em}.ck-client{color:#666;margin:2px 0 12px}.ck-footer{margin-top:24px;color:#666;font-size:.85em;border-top:1px solid #ddd;padding-top:12px}</style></head><body>${header}<main>${bodyHtml}</main>${footer}</body></html>\n`;
}

/** Accessible grid fragment used by exports and previewable before M1 lands. */
export function assetGrid(assets: { path: string; page: string; viewport: string }[]): string {
  return `<div class="ck-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:16px">${assets
    .map(
      (a) =>
        `<figure style="margin:0"><img src="${esc(a.path)}" alt="Screenshot of ${esc(a.page)} on ${esc(a.viewport)}" loading="lazy" style="width:100%;border-radius:8px;border:1px solid #ddd" /><figcaption style="font-size:.8em;color:#555">${esc(a.page)} · ${esc(a.viewport)}</figcaption></figure>`,
    )
    .join('')}</div>`;
}

export type MarkdownOptions = {
  target: string;
  runDirName: string;
  maxThumbs?: number;
};

/** Markdown snippet for READMEs and PR comments (FR-32). */
export function markdownSnippet(
  assets: { path: string; page: string; viewport: string }[],
  options: MarkdownOptions,
): string {
  const shown = assets.slice(0, options.maxThumbs ?? 6);
  const lines = [
    `### Visual capture — ${options.target}`,
    '',
    ...shown.map((a) => `- **${a.page}** (${a.viewport}): \`${a.path}\``),
  ];
  if (assets.length > shown.length)
    lines.push(`- …and ${assets.length - shown.length} more in \`${options.runDirName}/\``);
  lines.push('', `Run: \`${options.runDirName}\` · ${assets.length} assets`);
  return lines.join('\n') + '\n';
}
