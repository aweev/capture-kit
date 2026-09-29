import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

/**
 * Framework route adapters (FR-2, FR-4).
 *
 * When a project path is supplied, routes are read from build manifests or
 * file-system routing instead of crawling: Next.js (app/ + pages/ +
 * routes-manifest), Nuxt (pages/), SvelteKit (src/routes), Astro (src/pages),
 * and React Router (route-config scan). Parameterized routes collapse to one
 * concrete sample (FR-3 spirit); `rankPages` orders home, nav destinations,
 * and high-inbound pages first so a page cap keeps the important ones (FR-4).
 *
 * Standalone on purpose: M1's discovery calls `detectRoutes()` as one source
 * among sitemap/robots/crawl, and `rankPages()` orders whatever it finds.
 */

export const routesSchema = z
  .object({
    /** Project root to scan. Absent means no route-adapter source. */
    projectPath: z.string().min(1).optional(),
    /** Cap on adapter-contributed routes. */
    maxRoutes: z.number().int().min(1).max(200).default(20),
  })
  .strict();

export type RoutesConfig = z.infer<typeof routesSchema>;

export type Framework = 'nextjs' | 'nuxt' | 'sveltekit' | 'astro' | 'react-router' | 'unknown';

export type DetectedRoute = {
  path: string;
  framework: Framework;
  /** 'filesystem' | 'manifest' | 'config-scan' */
  source: string;
  /** True when a dynamic segment was replaced by a sample value. */
  sampled: boolean;
};

const PAGE_EXTS = new Set(['.tsx', '.ts', '.jsx', '.js', '.mdx', '.md', '.vue', '.svelte', '.astro']);

/** Identify the framework from package.json deps plus landmark directories. */
export async function detectFramework(root: string): Promise<Framework> {
  let deps = '';
  try {
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    deps = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})].join(' ');
  } catch {
    /* no package.json — fall through to directory landmarks */
  }
  const has = async (dir: string) => {
    try {
      return (await stat(path.join(root, dir))).isDirectory();
    } catch {
      return false;
    }
  };
  if (/\bnext\b/.test(deps) || (await has('.next'))) return 'nextjs';
  if (/\bnuxt\b/.test(deps) || (await has('.nuxt'))) return 'nuxt';
  if (/@sveltejs\/kit\b/.test(deps)) return 'sveltekit';
  if (/\bastro\b/.test(deps)) return 'astro';
  if (/\breact-router\b/.test(deps) || /\b@remix-run\/router\b/.test(deps)) return 'react-router';
  // Directory-only fallbacks for dependency-free fixtures.
  if (await has('src/routes')) return 'sveltekit';
  if (await has('src/pages')) return 'astro';
  if (await has('pages')) return 'nextjs';
  return 'unknown';
}

async function walkFiles(dir: string, out: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walkFiles(full, out);
    else if (PAGE_EXTS.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

function sampleDynamic(segment: string): { value: string; sampled: boolean } {
  // Next [...slug], [slug], (group); Nuxt [slug]; SvelteKit [slug]/[...rest];
  // Astro [slug]/[...rest]; React Router :id and *.
  if (/^\(.*\)$/.test(segment)) return { value: '', sampled: false }; // route group: invisible
  if (/^\[\[\.\.\..+\]\]$/.test(segment)) return { value: '', sampled: true }; // optional catch-all
  if (/^\[\.\.\..+\]$/.test(segment) || segment === '*') return { value: '1', sampled: true };
  if (/^\[.+\]$/.test(segment)) return { value: '1', sampled: true };
  if (segment.startsWith(':')) return { value: '1', sampled: true };
  return { value: segment, sampled: false };
}

/** Convert file-system route segments to a URL path, sampling dynamics. */
export function segmentsToPath(segments: string[]): { path: string; sampled: boolean } {
  let sampled = false;
  const parts: string[] = [];
  for (const segment of segments) {
    const { value, sampled: s } = sampleDynamic(segment);
    sampled = sampled || s;
    if (value) parts.push(value);
  }
  return { path: `/${parts.join('/')}`, sampled };
}

function fileToRoute(
  file: string,
  baseDir: string,
  style: 'app' | 'pages',
): { path: string; sampled: boolean } | null {
  const rel = path.relative(baseDir, file);
  const segments = rel.split(path.sep);
  const leaf = segments.pop() as string;
  const name = leaf.replace(/\.[^.]+$/, '');
  // Skip layouts, components, tests, and API routes (not visual pages).
  if (
    /^(layout|template|loading|error|not-found|global-error|default|_.*|.*\.(test|spec|stories)|route|server|middleware)$/.test(
      name,
    )
  ) {
    return null;
  }
  if (style === 'app') {
    // App-router style: the directory is the route; only route files count,
    // so colocated components never become phantom pages.
    if (name !== 'page' && name !== '+page' && name !== 'index') return null;
  } else if (name === 'index') {
    // Pages style: the file is the route; index files collapse to the dir.
  } else {
    segments.push(name);
  }
  return segmentsToPath(segments);
}

async function routesFromDir(
  root: string,
  dir: string,
  framework: Framework,
  source: string,
  style: 'app' | 'pages' = 'app',
): Promise<DetectedRoute[]> {
  const base = path.join(root, dir);
  const files = await walkFiles(base);
  const routes: DetectedRoute[] = [];
  for (const file of files) {
    const route = fileToRoute(file, base, style);
    if (route) routes.push({ ...route, framework, source });
  }
  return routes;
}

/** Next.js `.next/routes-manifest.json` static routes (dynamic collapsed). */
async function routesFromNextManifest(root: string): Promise<DetectedRoute[]> {
  const candidates = ['.next/routes-manifest.json', '.next/required-server-files.json'];
  for (const candidate of candidates) {
    try {
      const manifest = JSON.parse(await readFile(path.join(root, candidate), 'utf8')) as {
        staticRoutes?: { page: string }[];
        pages?: Record<string, string[]>;
      };
      const pages =
        manifest.staticRoutes?.map((r) => r.page) ?? Object.keys(manifest.pages ?? {});
      return pages
        .filter((p) => !p.startsWith('/api/') && !p.startsWith('/_'))
        .map((p) => ({ path: p === '/index' ? '/' : p, framework: 'nextjs' as Framework, source: 'manifest', sampled: false }));
    } catch {
      /* try next candidate */
    }
  }
  return [];
}

/** React Router config scan: `<Route path="…">` and `path: "…"` occurrences. */
async function routesFromRouterScan(root: string): Promise<DetectedRoute[]> {
  const files = await walkFiles(root);
  const found = new Map<string, boolean>();
  const pattern = /(?:<Route[^>]*\bpath\s*=\s*["']([^"']+)["']|\bpath\s*:\s*["']([^"']+)["'])/g;
  for (const file of files) {
    if (!/\.(tsx|ts|jsx|js)$/.test(file)) continue;
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    for (const match of text.matchAll(pattern)) {
      const raw = (match[1] ?? match[2] ?? '').split('?')[0] as string;
      if (!raw || raw === '*') continue;
      const { path: routePath, sampled } = segmentsToPath(
        raw.split('/').filter(Boolean),
      );
      if (!found.has(routePath)) found.set(routePath, sampled);
    }
  }
  return [...found.entries()].map(([routePath, sampled]) => ({
    path: routePath,
    framework: 'react-router' as Framework,
    source: 'config-scan',
    sampled,
  }));
}

/**
 * Detect routes for a project root. Never throws: an unscannable project
 * yields an empty list and discovery falls back to sitemap/crawl.
 */
export async function detectRoutes(
  projectPath: string,
  options: { maxRoutes?: number } = {},
): Promise<{ framework: Framework; routes: DetectedRoute[] }> {
  const root = path.resolve(projectPath);
  try {
    const framework = await detectFramework(root);
    let routes: DetectedRoute[] = [];
    if (framework === 'nextjs') {
      routes = [
        ...(await routesFromNextManifest(root)),
        ...(await routesFromDir(root, 'app', framework, 'filesystem', 'app')),
        ...(await routesFromDir(root, 'pages', framework, 'filesystem', 'pages')),
        ...(await routesFromDir(root, 'src/app', framework, 'filesystem', 'app')),
        ...(await routesFromDir(root, 'src/pages', framework, 'filesystem', 'pages')),
      ];
    } else if (framework === 'nuxt') {
      routes = await routesFromDir(root, 'pages', framework, 'filesystem', 'pages');
    } else if (framework === 'sveltekit') {
      routes = await routesFromDir(root, 'src/routes', framework, 'filesystem', 'app');
    } else if (framework === 'astro') {
      routes = [
        ...(await routesFromDir(root, 'src/pages', framework, 'filesystem', 'pages')),
        ...(await routesFromDir(root, 'pages', framework, 'filesystem', 'pages')),
      ];
    } else if (framework === 'react-router') {
      routes = await routesFromRouterScan(root);
    } else {
      return { framework, routes: [] };
    }
    // Deduplicate: one representative per concrete path (FR-3).
    const seen = new Map<string, DetectedRoute>();
    for (const route of routes) {
      if (!seen.has(route.path)) seen.set(route.path, route);
    }
    return {
      framework,
      routes: [...seen.values()].sort((a, b) => (a.path < b.path ? -1 : 1)).slice(0, options.maxRoutes ?? 20),
    };
  } catch {
    return { framework: 'unknown', routes: [] };
  }
}

export type RankSignals = {
  /** Hrefs from the top nav (prioritized destinations). */
  navLinks?: string[];
  /** Inbound link counts by path. */
  inbound?: Record<string, number>;
};

/**
 * Page ranking (FR-4): home first, then nav destinations, then pages by
 * inbound link count, then short stable paths. Pure and total — M1's
 * discovery applies it when a page cap is hit.
 */
export function rankPages(pages: string[], signals: RankSignals = {}): string[] {
  const nav = new Set((signals.navLinks ?? []).map((n) => (n.startsWith('/') ? n : `/${n}`)));
  const inbound = signals.inbound ?? {};
  const scored = pages.map((page) => {
    let score = 0;
    if (page === '/') score += 10_000;
    if (nav.has(page)) score += 1_000;
    score += Math.min(inbound[page] ?? 0, 100) * 10;
    score -= Math.min(page.length, 60);
    return { page, score };
  });
  scored.sort((a, b) => b.score - a.score || (a.page < b.page ? -1 : 1));
  return scored.map((s) => s.page);
}
