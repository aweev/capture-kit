import { URL } from 'node:url';

import { matchGlob } from './glob.ts';
import { rankPages } from './routes.ts';

/**
 * Discovery engine (FR-1, FR-3, FR-4, FR-5).
 *
 * Finds pages via: sitemap.xml -> robots hints -> same-origin link crawl.
 * Deduplicates parameterized routes, ranks what is left so a page cap keeps the
 * important ones, and honours robots Disallow plus a politeness delay.
 */

export type DiscoveredPage = {
  path: string;
  source: 'sitemap' | 'robots' | 'crawl' | 'config';
  priority: number;
  /** Route pattern when this page stands in for parameterized siblings (FR-3). */
  pattern?: string;
  /** Sibling paths collapsed into this representative. */
  siblings?: number;
};

export type DiscoveryOptions = {
  base: URL;
  configPages: string[];
  include: string[];
  exclude: string[];
  maxDepth: number;
  maxPages: number;
  /** Minimum gap between crawl requests; robots Crawl-delay can only raise it. */
  politenessMs?: number;
};

export type DiscoveryResult = {
  pages: string[];
  discovered: DiscoveredPage[];
  skipped: { path: string; reason: string }[];
  /** Inbound same-origin link counts by path, for FR-4 ranking. */
  inbound: Record<string, number>;
  /** Distinct hrefs found inside top-level <nav> elements on seed pages. */
  navLinks: string[];
  /** robots.txt prefixes the crawl refused to enter. */
  disallow: string[];
};

/**
 * Main discovery entry point.
 */
export async function discoverPages(
  options: DiscoveryOptions,
  fetchImpl: (url: string) => Promise<Response | null> = defaultFetch,
): Promise<DiscoveryResult> {
  const { base, configPages, include, exclude, maxDepth, maxPages } = options;
  const discovered: DiscoveredPage[] = [];
  const skipped: { path: string; reason: string }[] = [];

  // 1. Start with explicit config pages (highest priority)
  for (const page of configPages) {
    if (shouldInclude(page, include, exclude)) {
      discovered.push({ path: normalizePath(page, base), source: 'config', priority: 100 });
    } else {
      skipped.push({ path: page, reason: 'excluded by glob' });
    }
  }

  // Robots is read first: it declares the disallowed prefixes the crawl must
  // honour (PRD risk table: "crawl abuse") and may list sitemaps the site keeps
  // somewhere other than /sitemap.xml.
  const robots = await fetchRobotsTxt(base, fetchImpl);

  // 2. Try sitemap.xml
  const sitemapPages = await fetchSitemap(base, fetchImpl);
  for (const page of sitemapPages) {
    const normalized = normalizePath(page, base);
    if (shouldInclude(normalized, include, exclude)) {
      if (!discovered.some((d) => d.path === normalized)) {
        discovered.push({ path: normalized, source: 'sitemap', priority: 80 });
      }
    } else {
      skipped.push({ path: normalized, reason: 'excluded by glob' });
    }
  }

  // 3. Sitemaps referenced only from robots.txt.
  for (const sitemapUrl of robots.sitemaps) {
    if (/\/sitemap\.xml$/i.test(sitemapUrl)) continue; // already fetched above
    for (const found of await fetchSitemapAt(sitemapUrl, base, fetchImpl)) {
      const normalized = normalizePath(found, base);
      if (shouldInclude(normalized, include, exclude)) {
        if (!discovered.some((d) => d.path === normalized)) {
          discovered.push({ path: normalized, source: 'robots', priority: 60 });
        }
      } else {
        skipped.push({ path: normalized, reason: 'excluded by glob' });
      }
    }
  }

  // 4. Crawl for additional pages (same-origin only).
  //
  // The crawl always visits the seeds even when the sitemap already filled the
  // page cap: those pages carry the <nav> hrefs and the inbound-link counts the
  // ranker needs (FR-4). Only *newly discovered* pages are capped.
  const {
    discovered: crawlDiscovered,
    skipped: crawlSkipped,
    inbound,
    navLinks,
  } = await crawlLinks(
    base,
    discovered.map((d) => d.path),
    {
      maxDepth,
      maxPages,
      alreadyFound: discovered.map((d) => d.path),
      include,
      exclude,
      fetchImpl,
      disallow: robots.disallow,
      crawlDelayMs: robots.crawlDelayMs,
      politenessMs: options.politenessMs,
    },
  );
  for (const page of crawlDiscovered) {
    if (!discovered.some((d) => d.path === page.path)) {
      discovered.push(page);
    }
  }
  skipped.push(...crawlSkipped);

  // 5. Deduplicate parameterized routes (FR-3)
  const deduplicated = deduplicateRoutes(discovered);

  // 6. Rank (FR-4), then apply the cap. The order matters: PRD FR-4 says
  // ranking decides *which* pages survive a cap, so a top-nav destination can
  // never be dropped in favour of an arbitrary deeper page.
  const byPath = new Map(deduplicated.map((page) => [page.path, page]));
  const configPaths = [...new Set(configPages.map((p) => normalizePath(p, base)))].filter((p) =>
    shouldInclude(p, include, exclude),
  );
  // Explicit pages are an answer, not a candidate: they always survive.
  const ranked = [
    ...configPaths,
    ...rankPages(
      [...byPath.keys()].filter((p) => !configPaths.includes(p)),
      { navLinks, inbound },
    ),
  ];
  const finalPages = ranked.slice(0, maxPages);
  if (ranked.length > finalPages.length) {
    for (const dropped of ranked.slice(maxPages)) {
      skipped.push({ path: dropped, reason: `page cap (${maxPages}) reached` });
    }
  }

  return {
    pages: finalPages,
    discovered: finalPages.map((p) => byPath.get(p)).filter((d): d is DiscoveredPage => !!d),
    skipped: [
      ...new Map(
        skipped.map((entry) => [`${entry.path}\0${entry.reason}`, entry]),
      ).values(),
    ],
    inbound,
    navLinks,
    disallow: robots.disallow,
  };
}

/**
 * Fetch and parse sitemap.xml, following sitemap-index entries one level deep.
 */
async function fetchSitemap(
  base: URL,
  fetchImpl: (url: string) => Promise<Response | null>,
): Promise<string[]> {
  return fetchSitemapAt(new URL('/sitemap.xml', base).toString(), base, fetchImpl);
}

/** Fetch a sitemap (or sitemap index) at an absolute URL and return page paths. */
async function fetchSitemapAt(
  sitemapUrl: string,
  base: URL,
  fetchImpl: (url: string) => Promise<Response | null>,
  depth = 0,
): Promise<string[]> {
  const response = await fetchImpl(sitemapUrl);
  if (!response || !response.ok) return [];
  const text = await response.text();
  const { pages, indexes } = parseSitemap(text, base);

  const out = [...pages];
  // A sitemapindex is a list of sitemaps, not of pages: descend into it rather
  // than offering an .xml file up as something to screenshot.
  if (depth < 1) {
    for (const child of indexes) out.push(...(await fetchSitemapAt(child, base, fetchImpl, depth + 1)));
  }
  return out;
}

/**
 * Parse sitemap XML (supports sitemap index and URL set)
 */
function parseSitemap(
  xml: string,
  base: URL,
): { pages: string[]; indexes: string[] } {
  const pages: string[] = [];
  const indexes: string[] = [];
  const sameOrigin = (loc: string): string | null => {
    try {
      const url = new URL(loc, base);
      return url.origin === base.origin ? url.pathname + url.search : null;
    } catch {
      return null;
    }
  };

  // Sitemap-index entries live inside <sitemap>; page URLs inside <url>. The
  // two must not be conflated or a .xml feed becomes a "page" to capture.
  for (const match of xml.matchAll(/<sitemap>[\s\S]*?<loc>([^<]+)<\/loc>[\s\S]*?<\/sitemap>/gi)) {
    const loc = match[1]?.trim();
    if (!loc) continue;
    const path = sameOrigin(loc);
    if (path) indexes.push(path);
  }
  for (const match of xml.matchAll(/<url>[\s\S]*?<loc>([^<]+)<\/loc>[\s\S]*?<\/url>/gi)) {
    const loc = match[1]?.trim();
    if (!loc) continue;
    const path = sameOrigin(loc);
    if (path) pages.push(path);
  }

  return { pages, indexes };
}

/**
 * Fetch robots.txt: the sitemap references, the disallow prefixes, and the
 * requested crawl delay.
 */
async function fetchRobotsTxt(
  base: URL,
  fetchImpl: (url: string) => Promise<Response | null>,
): Promise<{ sitemaps: string[]; disallow: string[]; crawlDelayMs: number }> {
  const robotsUrl = new URL('/robots.txt', base).toString();
  const response = await fetchImpl(robotsUrl);
  if (!response || !response.ok) return { sitemaps: [], disallow: [], crawlDelayMs: 0 };

  const text = await response.text();
  const sitemaps: string[] = [];

  // Extract Sitemap: directives
  const sitemapMatches = text.matchAll(/^Sitemap:\s*(.+)$/gim);
  for (const match of sitemapMatches) {
    const loc = match[1]?.trim();
    if (!loc) continue;
    try {
      const url = new URL(loc, base);
      if (url.origin === base.origin) {
        sitemaps.push(url.pathname + url.search);
      }
    } catch {
      // ignore
    }
  }

  // Disallow lines that apply to us: the `User-agent: *` group, plus any group
  // naming this crawler explicitly.
  const disallow: string[] = [];
  let crawlDelaySeconds = 0;
  let groupApplies = false;
  let sawOurGroup = false;
  for (const line of text.split(/\r?\n/)) {
    const rule = /^\s*([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!rule) continue;
    const field = rule[1]!.toLowerCase();
    const value = rule[2]!.trim();
    if (field === 'user-agent') {
      const agent = value.toLowerCase();
      groupApplies = agent === '*' || agent.includes('capturekit');
      sawOurGroup = sawOurGroup || groupApplies;
      continue;
    }
    if (field === 'crawl-delay' && groupApplies) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        crawlDelaySeconds = Math.max(crawlDelaySeconds, parsed);
      }
      continue;
    }
    if (field === 'disallow' && groupApplies && value && value !== '/') {
      disallow.push(value.startsWith('/') ? value : `/${value}`);
    }
  }
  // No group matched us, so the file says nothing about this crawler: treat the
  // `*` rules as absent rather than assuming the whole site is off-limits.
  if (!sawOurGroup) disallow.length = 0;

  return {
    sitemaps,
    disallow,
    crawlDelayMs: Math.min(crawlDelaySeconds * 1000, 30_000),
  };
}

/** True when a path falls under one of the robots Disallow prefixes. */
function isDisallowed(path: string, disallow: string[]): boolean {
  const clean = path.split('?')[0] ?? path;
  return disallow.some((prefix) => clean === prefix || clean.startsWith(prefix));
}

/**
 * Crawl same-origin links up to maxDepth.
 *
 * Bounded and polite by construction (PRD risk table, "crawl abuse / hitting
 * production hard"): a hard page cap, depth and count limits from config,
 * robots Disallow prefixes respected, and a delay between requests taken from
 * the site's own Crawl-delay (or `politenessMs`, whichever is larger).
 */
async function crawlLinks(
  base: URL,
  seedPaths: string[],
  options: {
    maxDepth: number;
    maxPages: number;
    alreadyFound: string[];
    include: string[];
    exclude: string[];
    fetchImpl: (url: string) => Promise<Response | null>;
    disallow: string[];
    crawlDelayMs: number;
    politenessMs?: number;
  },
): Promise<{
  discovered: DiscoveredPage[];
  skipped: { path: string; reason: string }[];
  inbound: Record<string, number>;
  navLinks: string[];
}> {
  const { maxDepth, maxPages, include, exclude, fetchImpl, alreadyFound, disallow } = options;
  const delayMs = Math.max(options.crawlDelayMs, options.politenessMs ?? 0);
  // How many pages the crawl may *add*. The cap counts every page handed to the
  // planner, so the crawl fills only what the sitemap and config left room for.
  const roomLeft = Math.max(0, maxPages - new Set(alreadyFound).size);
  // Visits are bounded separately from additions: the pages already found still
  // have to be fetched, because their links are the ranking signals (FR-4) that
  // decide which of them survives the cap. Without this, a full sitemap would
  // silently disable ranking.
  const maxFetches = Math.max(maxPages, 1) * 3;
  const visited = new Set(seedPaths);
  const queue: { path: string; depth: number }[] = seedPaths.map((p) => ({ path: p, depth: 0 }));
  const discovered: DiscoveredPage[] = [];
  const skipped: { path: string; reason: string }[] = [];
  // FR-4 ranking signals: every same-origin link occurrence counts as an
  // inbound vote, and <nav> hrefs on seed pages mark priority destinations.
  const inbound: Record<string, number> = {};
  const navLinks: string[] = [];
  let fetches = 0;

  while (queue.length > 0 && fetches < maxFetches) {
    const { path: currentPath, depth } = queue.shift()!;

    if (depth >= maxDepth) continue;
    // Never request something robots.txt forbids, not even to read its links.
    if (isDisallowed(currentPath, disallow)) {
      skipped.push({ path: currentPath, reason: 'disallowed by robots.txt' });
      continue;
    }

    if (fetches > 0 && delayMs > 0) await sleep(delayMs);
    fetches++;

    const url = new URL(currentPath, base).toString();
    const response = await fetchImpl(url);
    if (!response || !response.ok) continue;

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) continue;

    const html = await response.text();
    const links = extractLinks(html);
    if (depth === 0) {
      for (const nav of extractNavLinks(html)) {
        try {
          const navUrl = new URL(nav, base);
          if (navUrl.origin !== base.origin) continue;
          const normalized = normalizePath(nav, base);
          if (!navLinks.includes(normalized)) navLinks.push(normalized);
        } catch {
          /* ignore */
        }
      }
    }

    for (const link of links) {
      const normalized = normalizePath(link, base);

      // Only same-origin
      try {
        const linkUrl = new URL(link, base);
        if (linkUrl.origin !== base.origin) continue;
      } catch {
        continue;
      }
      inbound[normalized] = (inbound[normalized] ?? 0) + 1;

      if (visited.has(normalized)) continue;
      if (isDisallowed(normalized, disallow)) {
        visited.add(normalized);
        skipped.push({ path: normalized, reason: 'disallowed by robots.txt' });
        continue;
      }
      if (!shouldInclude(normalized, include, exclude)) {
        skipped.push({ path: normalized, reason: 'excluded by glob' });
        continue;
      }
      if (discovered.length >= roomLeft) {
        skipped.push({ path: normalized, reason: 'page cap reached' });
        continue;
      }

      visited.add(normalized);
      discovered.push({ path: normalized, source: 'crawl', priority: 40 - depth * 10 });
      queue.push({ path: normalized, depth: depth + 1 });
    }
  }

  const uniqueSkipped = [
    ...new Map(skipped.map((entry) => [`${entry.path}\0${entry.reason}`, entry])).values(),
  ];
  return { discovered, skipped: uniqueSkipped, inbound, navLinks };
}

/** Await a politeness gap between crawl requests. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extract all href links from HTML
 */
function extractLinks(html: string): string[] {
  const links: string[] = [];
  const hrefRegex = /href\s*=\s*["']([^"']+)["']/gi;
  let match;
  while ((match = hrefRegex.exec(html)) !== null) {
    const href = match[1]?.trim();
    if (!href) continue;
    // Skip anchors, javascript:, mailto:, tel:, etc.
    if (
      href.startsWith('#') ||
      href.startsWith('javascript:') ||
      href.startsWith('mailto:') ||
      href.startsWith('tel:')
    ) {
      continue;
    }
    links.push(href);
  }
  return links;
}

/**
 * Hrefs inside top-level <nav> elements (FR-4: priority destinations).
 * Regex-scoped, not a parser: good enough for ranking signals.
 */
function extractNavLinks(html: string): string[] {
  const links: string[] = [];
  const navRegex = /<nav[\s>][\s\S]*?<\/nav>/gi;
  let nav;
  while ((nav = navRegex.exec(html)) !== null) {
    const hrefRegex = /href\s*=\s*["']([^"']+)["']/gi;
    let match;
    while ((match = hrefRegex.exec(nav[0] as string)) !== null) {
      const href = match[1]?.trim();
      if (
        !href ||
        href.startsWith('#') ||
        href.startsWith('javascript:') ||
        href.startsWith('mailto:') ||
        href.startsWith('tel:')
      ) {
        continue;
      }
      links.push(href);
    }
  }
  return links;
}

/**
 * Normalize a path relative to base URL.
 *
 * Query strings survive (they can change what renders); a trailing slash does
 * not, because `/pricing/` and `/pricing` are the same page for every host
 * tested, and keeping both would produce two captures of one screen.
 */
function normalizePath(input: string, base: URL): string {
  let path: string;
  try {
    const url = new URL(input, base);
    if (url.origin !== base.origin) return input; // Return as-is if cross-origin
    path = url.pathname + url.search;
  } catch {
    // If it's already a path, ensure it starts with /
    path = input.startsWith('/') ? input : `/${input}`;
  }
  if (!path.startsWith('/')) path = '/' + path;
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return path;
}

/**
 * Check if a path matches include/exclude globs
 */
function shouldInclude(path: string, include: string[], exclude: string[]): boolean {
  // If include patterns exist, path must match at least one
  if (include.length > 0) {
    const matched = include.some((pattern) => matchGlob(path, pattern));
    if (!matched) return false;
  }
  // Path must not match any exclude pattern
  for (const pattern of exclude) {
    if (matchGlob(path, pattern)) return false;
  }
  return true;
}

/**
 * Deduplicate parameterized routes (FR-3).
 *
 * `/post/1` and `/post/2` are one route, so only one representative is
 * captured. The representative must stay a *real* path: rewriting the result to
 * `/post/:id` would hand the planner a URL that cannot be fetched. The pattern
 * is recorded alongside the page so the manifest and `discover --json` can show
 * why its siblings were dropped.
 */
function deduplicateRoutes(pages: DiscoveredPage[]): DiscoveredPage[] {
  const patternMap = new Map<string, DiscoveredPage[]>();

  for (const page of pages) {
    const pattern = toRoutePattern(page.path);
    const existing = patternMap.get(pattern) || [];
    existing.push(page);
    patternMap.set(pattern, existing);
  }

  const result: DiscoveredPage[] = [];
  for (const [pattern, group] of patternMap) {
    // Stable ordering: priority first, then the path, so the same site always
    // yields the same representative across runs (G4).
    group.sort((a, b) => b.priority - a.priority || (a.path < b.path ? -1 : 1));
    const best = group[0];
    if (!best) continue;
    result.push(
      hasParameters(pattern) ? { ...best, pattern, siblings: group.length - 1 } : best,
    );
  }

  return result;
}

/**
 * Convert a path to a route pattern (e.g., /post/123 -> /post/:id)
 */
function toRoutePattern(path: string): string {
  // Split by / and replace numeric segments with :param
  return path
    .split('/')
    .map((segment) => {
      if (!segment) return segment;
      // Replace UUIDs
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) {
        return ':uuid';
      }
      // Replace numeric IDs
      if (/^\d+$/.test(segment)) {
        return ':id';
      }
      // Replace hash-like IDs
      if (/^[a-f0-9]{8,}$/i.test(segment)) {
        return ':hash';
      }
      return segment;
    })
    .join('/');
}

/**
 * Check if a pattern has parameter placeholders
 */
function hasParameters(pattern: string): boolean {
  return (
    pattern.includes(':') &&
    (pattern.includes(':id') || pattern.includes(':uuid') || pattern.includes(':hash'))
  );
}

/**
 * Default fetch implementation
 */
async function defaultFetch(url: string): Promise<Response | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'capturekit-discovery/0.0.1' },
    });
    clearTimeout(timeout);
    return response;
  } catch {
    return null;
  }
}
