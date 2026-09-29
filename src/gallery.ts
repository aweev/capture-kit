import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { resolveBrand, themedShell } from './branding.ts';
import { frameCss, frameFor, frameHtml } from './frames.ts';
import type { Manifest, ManifestAsset, ManifestVideo } from './manifest.ts';

/**
 * Self-contained gallery generator (FR-30).
 *
 * Reads `manifest.json` from a run directory and writes `index.html` — a
 * single-file, zero-dependency gallery with:
 *   - viewport tabs (mobile, tablet, desktop, …)
 *   - responsive grid of screenshots with optional device frames (FR-9)
 *   - lightbox for full-size inspection
 *   - video playback for walkthrough/flow clips (FR-19/20/22)
 *   - copy-link per asset (FR-30)
 *   - dark/light theme toggle
 *
 * All CSS and JS is inline so the file opens from any origin, including
 * `file://`. The manifest is embedded as JSON in a `<script>` tag so the
 * gallery is fully functional offline.
 */
export type GalleryOptions = {
  /** Run directory containing manifest.json (absolute or relative). */
  runDir: string;
  /** Branding config (resolved lazily from manifest's gallery field). */
  brand?: GalleryBranding;
  /** Output path; defaults to `index.html` inside runDir. */
  outFile?: string;
  /** Alt-text map: { "screenshots/home/mobile.webp": { alt: "...", caption: "..." } }. */
  altText?: Record<string, { alt?: string; caption?: string }>;
};

type GalleryBranding = {
  title?: string;
  client?: string;
  logo?: string;
  accent?: string;
  footer?: string;
};

/** Asset grouped for gallery rendering. */
type GroupedAsset = {
  page: string;
  viewport: string;
  scheme: string;
  flow?: string;
  screenshots: ManifestAsset[];
  videos: ManifestVideo[];
};

/** Escape for HTML text/attribute interpolation. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escape for use inside a JSON string literal. */
function escJson(s: string): string {
  return JSON.stringify(s).slice(1, -1);
}

/** Collect every viewport name across assets, sorted for tab ordering. */
function collectViewports(entries: (ManifestAsset | ManifestVideo)[]): string[] {
  const set = new Set<string>();
  for (const entry of entries) {
    set.add(entry.viewport);
  }
  return [...set].sort();
}

/** Collect every scheme across assets, sorted (light first). */
function collectSchemes(entries: (ManifestAsset | ManifestVideo)[]): string[] {
  const set = new Set<string>();
  for (const entry of entries) {
    set.add(entry.scheme ?? 'light');
  }
  return [...set].sort((a, b) => (a === 'light' ? -1 : b === 'light' ? 1 : a.localeCompare(b)));
}

/** Build a stable key for grouping assets. */
function assetKey(entry: ManifestAsset | ManifestVideo): string {
  const scheme = entry.scheme ?? 'light';
  return `${entry.page}\0${entry.viewport}\0${scheme}`;
}

/**
 * Group assets by (page, viewport, scheme) so each cell can show its
 * screenshot and any associated videos side by side.
 */
function groupAssets(manifest: Manifest): GroupedAsset[] {
  const map = new Map<string, GroupedAsset>();
  const push = (key: string, page: string, viewport: string, scheme: string): GroupedAsset => {
    let existing = map.get(key);
    if (!existing) {
      existing = { page, viewport, scheme, screenshots: [], videos: [] };
      map.set(key, existing);
    }
    return existing;
  };

  for (const entry of manifest.assets) {
    const scheme = 'scheme' in entry ? (entry.scheme ?? 'light') : (entry.scheme ?? 'light');
    const key = assetKey(entry);
    const group = push(key, entry.page, entry.viewport, scheme);
    if (entry.type === 'screenshot') {
      group.screenshots.push(entry);
    } else {
      group.videos.push(entry);
    }
  }

  const sorted = [...map.values()].sort((a, b) => {
    if (a.page !== b.page) return a.page < b.page ? -1 : 1;
    if (a.viewport !== b.viewport) return a.viewport < b.viewport ? -1 : 1;
    return a.scheme < b.scheme ? -1 : 1;
  });
  return sorted;
}

/**
 * Render the gallery body: a page selector, viewport tabs, and a grid
 * of assets within each tab.
 */
function renderBody(
  manifest: Manifest,
  grouped: GroupedAsset[],
  viewports: string[],
  schemes: string[],
  altText: Record<string, { alt?: string; caption?: string }>,
): string {
  const pages = [...new Set(grouped.map((g) => g.page))].sort();
  const frameCSS = frameCss();

  // Viewport tabs
  const tabs = viewports
    .map(
      (vp, i) =>
        `<button class="ck-tab" data-viewport="${esc(vp)}" data-tab-index="${i}" type="button">${esc(vp)}</button>`,
    )
    .join('');

  // Scheme selector (only show if there are multiple schemes)
  const schemeSelector =
    schemes.length > 1
      ? `<div class="ck-scheme-selector">
${schemes
    .map(
      (s) =>
        `<button class="ck-scheme-tab" data-scheme="${esc(s)}" type="button">${s === 'dark' ? '🌙' : '☀️'} ${s}</button>`,
    )
    .join('')}
</div>`
      : '';

  // For each viewport tab, render the grid of assets
  const panels = viewports
    .map((vp, i) => {
      const assetsForVp = grouped.filter((g) => g.viewport === vp);
      if (assetsForVp.length === 0) {
        return `<div class="ck-panel" data-viewport="${esc(vp)}" data-tab-index="${i}" hidden><p class="ck-empty">No captures for ${esc(vp)}.</p></div>`;
      }

      // Further group by scheme within this viewport
      const byScheme = new Map<string, GroupedAsset[]>();
      for (const a of assetsForVp) {
        const s = a.scheme;
        const arr = byScheme.get(s) ?? [];
        arr.push(a);
        byScheme.set(s, arr);
      }

      const sections = schemes
        .map((scheme) => {
          const assets = byScheme.get(scheme);
          if (!assets || assets.length === 0) {
            return `<section class="ck-scheme-section" data-scheme="${esc(scheme)}" hidden><p class="ck-empty">No ${scheme} captures for ${esc(vp)}.</p></section>`;
          }
          const items = assets
            .map((g) => renderAssetCard(g, altText))
            .join('');
          return `<section class="ck-scheme-section" data-scheme="${esc(scheme)}"><div class="ck-grid">${items}</div></section>`;
        })
        .join('');

      return `<div class="ck-panel" data-viewport="${esc(vp)}" data-tab-index="${i}"${i === 0 ? '' : ' hidden'}>${schemeSelector}${sections}</div>`;
    })
    .join('');

  // Failures panel
  const failures = manifest.failures;
  const failuresHtml = failures.length
    ? `<section class="ck-failures"><h2>Failed captures (${failures.length})</h2><ul>${failures
      .map(
        (f) =>
          `<li><strong>${esc(f.page)}</strong> on ${esc(f.viewport)}: ${esc(f.reason)}</li>`,
      )
      .join('')}</ul></section>`
    : '';

  // Page selector (for navigating between pages within the same viewport)
  const pageSelector =
    pages.length > 1
      ? `<select id="ck-page-select" class="ck-page-select">${pages
        .map(
          (p) =>
            `<option value="${esc(p)}">${esc(p)}</option>`,
        )
        .join('')}</select>`
      : '';

  return `<div class="ck-gallery">
  <div class="ck-header-bar">
    ${pageSelector}
    <div class="ck-tabs">${tabs}</div>
  </div>
  <div id="ck-panels">${panels}</div>
  ${failuresHtml}
</div>

<style>
${frameCSS}
</style>`;
}

/**
 * Render a single asset card: screenshot (with optional device frame)
 * plus any associated videos.
 */
function renderAssetCard(g: GroupedAsset, altText: Record<string, { alt?: string; caption?: string }>): string {
  const screenshot = g.screenshots[0];
  const videos = g.videos;
  // Groups always carry a screenshot (videos only accompany successful
  // captures), but guard anyway so a videos-only group still renders.
  if (!screenshot) {
    const videoHtml = videos
      .map((v) => {
        const isGif = v.format === 'gif';
        const ctrl = isGif
          ? `<img src="${esc(v.path)}" alt="${esc(`Walkthrough of ${g.page} on ${g.viewport}`)}" style="max-width:100%;border-radius:8px;border:1px solid #ddd" />`
          : `<video src="${esc(v.path)}" controls preload="metadata" style="max-width:100%;border-radius:8px;border:1px solid #ddd"></video>`;
        return `<div class="ck-video">${ctrl}</div>`;
      })
      .join('');
    return `<figure class="ck-asset" data-page="${esc(g.page)}" data-viewport="${esc(g.viewport)}">
  <div class="ck-thumb">${videoHtml}</div>
</figure>`;
  }
  const frame = screenshot.frame;
  const frameSpec = frame ? frameFor(screenshot.viewport, frame) : { kind: 'none' as const, radius: 0, bezel: 0, urlBar: false };

  const altEntry = altText[screenshot.path] ?? {};
  const alt = altEntry.alt ?? `Screenshot of ${g.page} on ${g.viewport}`;
  const caption = altEntry.caption;

  // Screenshot
  const imgTag = `<img src="${esc(screenshot.path)}" alt="${esc(alt)}" loading="lazy" data-copy="${esc(screenshot.path)}" />`;
  const framed = frame && frame !== 'none' ? frameHtml(frameSpec, imgTag, screenshot.path) : imgTag;

  // Videos
  const videoHtml = videos
    .map((v) => {
      const isGif = v.format === 'gif';
      const ctrl = isGif
        ? `<img src="${esc(v.path)}" alt="${esc(`Walkthrough of ${g.page} on ${g.viewport}`)}" style="max-width:100%;border-radius:8px;border:1px solid #ddd" />`
        : `<video src="${esc(v.path)}" controls preload="metadata" style="max-width:100%;border-radius:8px;border:1px solid #ddd"></video>`;
      return `<div class="ck-video">${ctrl}</div>`;
    })
    .join('');

  // Copy-link button
  const copyBtn = `<button class="ck-copy" type="button" data-copy="${esc(screenshot.path)}" aria-label="Copy link to ${esc(alt)}">🔗</button>`;

  // Caption / metadata
  const metaHtml = caption
    ? `<figcaption class="ck-caption">${esc(caption)}</figcaption>`
    : '';
  const statsHtml = `<div class="ck-stats">${g.viewport} · ${g.scheme}</div>`;

  return `<figure class="ck-asset" data-page="${esc(g.page)}" data-viewport="${esc(g.viewport)}">
  <div class="ck-thumb">${framed}${copyBtn}${metaHtml}</div>
  ${statsHtml}
  ${videoHtml}
</figure>`;
}

/**
 * The full inline CSS for the gallery. No external stylesheets (FR-30).
 */
function galleryStyles(): string {
  return `@media (prefers-color-scheme: dark){
:root[data-theme=dark]{
--ck-bg:#0d0d0e;--ck-fg:#e4e4e7;--ck-muted:#a1a1aa;
--ck-card:#18181b;--ck-border:#27272a;--ck-accent:#3b82f6
}}
:root{
--ck-bg:#ffffff;--ck-fg:#111827;--ck-muted:#6b7280;
--ck-card:#f9fafb;--ck-border:#e5e7eb;--ck-accent:#0F62FE
}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;background:var(--ck-bg);color:var(--ck-fg);padding:24px;max-width:1200px;margin:0 auto;line-height:1.5}
.ck-gallery{padding:16px}
.ck-header-bar{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:16px}
.ck-page-select{font:14px system-ui;padding:6px 10px;border-radius:6px;border:1px solid var(--ck-border);background:var(--ck-card);color:var(--ck-fg)}
.ck-tabs{display:flex;gap:2px;background:var(--ck-border);border-radius:8px;padding:2px}
.ck-tab{background:none;border:none;padding:8px 16px;border-radius:6px;font:14px/1 system-ui;cursor:pointer;color:var(--ck-muted);transition:all .15s}
.ck-tab:hover{color:var(--ck-fg)}
.ck-tab.active{color:var(--ck-accent);background:#fff}
[data-theme=dark] .ck-tab.active{background:var(--ck-card)}
.ck-panel{animation:fade-in .2s ease-out}
@keyframes fade-in{from{opacity:0}to{opacity:1}}
.ck-scheme-section{display:none}
.ck-scheme-section.active{display:block}
.ck-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px}
.ck-asset{margin:0}
.ck-thumb{position:relative;display:inline-block;width:100%}
.ck-thumb img{display:block;width:100%;border-radius:8px;border:1px solid var(--ck-border);box-shadow:0 1px 3px rgba(0,0,0,.08)}
.ck-copy{position:absolute;top:8px;right:8px;background:rgba(255,255,255,.9);border:none;border-radius:6px;padding:4px 8px;font-size:16px;cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,.12)}
[data-theme=dark] .ck-copy{background:rgba(13,13,14,.9)}
.ck-copy:hover{background:#fff}
[data-theme=dark] .ck-copy:hover{background:var(--ck-card)}
.ck-caption{font-size:12px;color:var(--ck-muted);margin-top:4px}
.ck-statstable{width:100%;border-collapse:collapse;font:12px system-ui}
.ck-statstable td{padding:2px 6px;border-bottom:1px solid var(--ck-border)}
.ck-statstable td:first-child{color:var(--ck-muted);width:40%}
.ck-failures{margin-top:24px;padding-top:16px;border-top:1px solid var(--ck-border)}
.ck-failures h2{font-size:1.1em;margin-bottom:8px}
.ck-failures ul{list-style:none;padding:0}
.ck-failures li{padding:6px 0;border-bottom:1px solid var(--ck-border)}
.ck-failures li strong{color:var(--ck-fg)}
.ck-empty{color:var(--ck-muted);padding:24px;text-align:center}
.ck-video{margin-top:8px}
.dark\\:block{display:none}
[data-theme=dark] .dark\\:block{display:block}
[data-theme=dark] .light\\:block{display:none}
@media print{.ck-copy,.ck-header-bar,.ck-failures,.ck-video,.dark\\:block{display:none}}`;
}

/**
 * The full inline JavaScript for the gallery: lightbox, copy-link,
 * tab switching, scheme toggle, theme toggle.
 */
function galleryScript(): string {
  return `
(function(){
var root=document.documentElement;
var getTheme=function(){return localStorage.getItem('ck-theme')||(window.matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light')};
var applyTheme=function(t){root.setAttribute('data-theme',t);localStorage.setItem('ck-theme',t)};
applyTheme(getTheme());
window.ckSetTheme=applyTheme;

document.addEventListener('click',function(e){
  var target=e.target;
  if(target.classList.contains('ck-tab')){
    e.preventDefault();
    var panels=document.querySelectorAll('.ck-panel');
    var tabs=document.querySelectorAll('.ck-tab');
    var idx=target.getAttribute('data-tab-index');
    panels.forEach(function(p){p.hidden=p.getAttribute('data-tab-index')!==idx});
    tabs.forEach(function(t){t.classList.toggle('active',t===target)});
    window.location.hash='#vp='+encodeURIComponent(target.getAttribute('data-viewport'));
    return;
  }
  if(target.classList.contains('ck-scheme-tab')){
    e.preventDefault();
    var sections=document.querySelectorAll('.ck-scheme-section');
    var tabs=document.querySelectorAll('.ck-scheme-tab');
    var scheme=target.getAttribute('data-scheme');
    sections.forEach(function(s){s.classList.toggle('active',s.getAttribute('data-scheme')===scheme)});
    tabs.forEach(function(t){t.classList.toggle('active',t===target)});
    return;
  }
  if(target.classList.contains('ck-copy')){
    e.preventDefault();
    var path=target.getAttribute('data-copy');
    var page=target.closest('.ck-asset').getAttribute('data-page');
    var vp=target.closest('.ck-asset').getAttribute('data-viewport');
    var url=page+'?viewport='+vp;
    navigator.clipboard.writeText(url).then(function(){
      var orig=target.textContent;
      target.textContent='✓';
      setTimeout(function(){target.textContent=orig},1500);
    });
    return;
  }
  if(target.tagName==='IMG'&&target.classList.contains('ck-gallery-img')){
    e.preventDefault();
    openLightbox(target.src,target.alt);
    return;
  }
  if(target.classList.contains('ck-theme-toggle')){
    e.preventDefault();
    applyTheme(root.getAttribute('data-theme')==='dark'?'light':'dark');
    return;
  }
});

function openLightbox(src,alt){
  var overlay=document.createElement('div');
  overlay.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.8);display:flex;align-items:center;justify-content:center;z-index:2147483647';
  var img=document.createElement('img');
  img.src=src;
  if(alt){img.alt=alt}
  img.style.maxWidth='90vw';
  img.style.maxHeight='90vh';
  overlay.appendChild(img);
  document.body.appendChild(overlay);
  overlay.addEventListener('click',function(){document.body.removeChild(overlay)});
}
})();
`;
}

/**
 * Build the full gallery HTML for a manifest.
 * The returned HTML is a complete `index.html` — self-contained with inline CSS/JS.
 */
export function buildGalleryHtml(
  manifest: Manifest,
  options: {
    brand?: GalleryBranding;
    altText?: Record<string, { alt?: string; caption?: string }>;
  } = {},
): string {
  const brand = resolveBrand(
    options.brand
      ? {
        title: options.brand.title ?? 'Capturekit gallery',
        ...(options.brand.client ? { client: options.brand.client } : {}),
        brand: {
          ...(options.brand.logo ? { logo: options.brand.logo } : {}),
          ...(options.brand.accent ? { accent: options.brand.accent } : {}),
        },
        ...(options.brand.footer ? { footer: options.brand.footer } : {}),
      }
      : undefined,
  );

  const altText = options.altText ?? {};
  const grouped = groupAssets(manifest);
  const viewports = collectViewports(manifest.assets);
  const schemes = collectSchemes(manifest.assets);
  const body = renderBody(manifest, grouped, viewports, schemes, altText);
  const pageCss = galleryStyles();
  const pageJs = galleryScript();

  const fullHtml = themedShell(brand, body)
    .replace('</head>', `<style>${pageCss}\n${frameCss()}</style><script type="application/json" id="ck-manifest">${escJson(JSON.stringify(manifest))}</script></head>`)
    .replace('</body>', `<script>${pageJs}</script></body>`);

  return fullHtml;
}

/**
 * Read a manifest from a run directory and write the gallery.
 * Returns the path to the written file.
 */
export async function buildGallery(options: GalleryOptions): Promise<string> {
  const manifestPath = path.join(options.runDir, 'manifest.json');
  const raw = await readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(raw) as Manifest;

  const html = buildGalleryHtml(manifest, {
    brand: options.brand,
    altText: options.altText,
  });

  const outFile = options.outFile ?? path.join(options.runDir, 'index.html');
  await writeFile(outFile, html, 'utf8');
  return outFile;
}
