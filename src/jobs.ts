import path from 'node:path';

import { matchesAny } from './glob.ts';
import type { Device } from './devices.ts';

/**
 * Job planner (PRD section 8: "Job Planner — page x viewport x mode").
 *
 * Every capture is an idempotent job keyed by (page, viewport, mode). Making the
 * job the unit of work is what allows parallelism, partial reruns, and per-job
 * retry state without any two jobs touching the same file.
 *
 * FR-8 modes: `viewport` (the visible box), `fullPage` (the whole document),
 * `element` (one selector's box), and `aboveTheFold` (the first screen of a tall
 * page, clipped at the fold rather than scrolled).
 */
export type CaptureMode = 'viewport' | 'fullPage' | 'element' | 'aboveTheFold';

export type Scheme = 'light' | 'dark';

/** FR-11: per-page and per-viewport override of any capture-time setting. */
export type CaptureOverride = {
  /** Path globs this override applies to; empty means every page. */
  pages?: string[];
  /** Viewport names this override applies to; empty means every viewport. */
  viewports?: string[];
  mode?: CaptureMode;
  /** Selector for `element` mode. */
  selector?: string;
  /** Scroll offset for `aboveTheFold`, in CSS px (defaults to the viewport top). */
  foldOffset?: number;
  fullPage?: boolean;
  format?: 'png' | 'webp' | 'jpeg';
  quality?: number;
  frame?: 'none' | 'browser' | 'phone' | 'auto';
  schemes?: Scheme[];
  /** Overrides for the stabilization budget on this page/viewport only. */
  timeoutMs?: number;
  attempts?: number;
  /** Skip this page x viewport entirely. */
  skip?: boolean;
};

export type Job = {
  /** Stable identity across runs: `pagePath@viewport` (plus `@scheme` when dark). */
  id: string;
  /** Path relative to the target origin, e.g. `/pricing`. */
  pagePath: string;
  /** Folder name under `screenshots/`, e.g. `pricing`. */
  pageSlug: string;
  /** Fully resolved URL for this job. */
  url: string;
  device: Device;
  mode: CaptureMode;
  /** Selector captured in `element` mode. */
  selector?: string;
  /** Fold offset in CSS px for `aboveTheFold`. */
  foldOffset?: number;
  /** Color scheme for this job (FR-10). Defaults to light. */
  scheme?: Scheme;
  /** Flow that drives the page before capture, if any (FR-21). */
  flowName?: string;
  /** Image format extension for this job (FR-9). Defaults to png. */
  format?: 'png' | 'webp' | 'jpeg';
  /** Image quality for webp/jpeg (FR-9). */
  quality?: number;
  /** Device frame for gallery rendering (FR-9, overridable per page). */
  frame?: 'none' | 'browser' | 'phone' | 'auto';
  /** Per-job stabilization budget, from an FR-11 override. */
  timeoutMs?: number;
  attempts?: number;
  /** Where the image lands, relative to the run directory. */
  relPath: string;
};


export type JobFailure = {
  job: Job;
  /** Human-readable reason; always accompanied by a log line (Principle 2). */
  reason: string;
  /** 1-based attempt number that produced this failure. */
  attempts: number;
  /** Per-attempt diagnostics, newest last. */
  attemptsDetail: AttemptRecord[];
  /** Relative path of the retained Playwright trace, when one was written. */
  tracePath?: string;
};

export type AttemptRecord = {
  attempt: number;
  strategy: string;
  durationMs: number;
  status: number | null;
  error?: string;
};

/**
 * Folder name for a page. `/` becomes `home`, `/blog/hello` becomes
 * `blog-hello`. Trailing slashes and query strings are dropped so two URLs that
 * render the same page cannot collide.
 */
export function pageSlug(pagePath: string): string {
  const clean = pagePath.split('?')[0]?.split('#')[0] ?? '';
  const trimmed = clean.replace(/\/+$/, '');
  if (trimmed === '' || trimmed === '/') return 'home';
  const slug = trimmed
    .replace(/^\/+/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'home';
}

/**
 * Expand pages x viewports (x schemes) into jobs, de-duplicating slugs so a
 * collision (e.g. `/a-b` vs `/a_b`) cannot silently overwrite an image.
 *
 * M0 callers pass only `{ base, pages, devices, fullPage }` and get exactly the
 * historical behavior: light scheme, png paths, `page@viewport` ids. M2 passes
 * `schemes` and `format` to fan out dark mode and webp/jpeg. M5 adds `mode`,
 * `selector`, and `overrides` (FR-8, FR-11).
 */
export function planJobs(options: {
  base: URL;
  pages: string[];
  devices: Device[];
  fullPage: boolean;
  schemes?: Scheme[];
  format?: 'png' | 'webp' | 'jpeg';
  /** Global capture mode (FR-8). `fullPage` stays the shorthand for it. */
  mode?: CaptureMode;
  /** Global selector for `element` mode. */
  selector?: string;
  /** Per-page / per-viewport overrides (FR-11); later entries win ties. */
  overrides?: CaptureOverride[];
}): { jobs: Job[]; collisions: string[]; skipped: { id: string; reason: string }[] } {
  const defaultMode: CaptureMode = options.mode ?? (options.fullPage ? 'fullPage' : 'viewport');
  const defaultFormat = options.format ?? 'png';
  const used = new Map<string, number>();
  const collisions: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  const jobs: Job[] = [];

  for (const pagePath of options.pages) {
    let slug = pageSlug(pagePath);
    const seen = used.get(slug);
    if (seen !== undefined) {
      used.set(slug, seen + 1);
      slug = `${slug}-${seen + 1}`;
      collisions.push(`${pagePath} -> ${slug}`);
    } else {
      used.set(slug, 1);
    }

    for (const device of options.devices) {
      const resolved = resolveOverride(options.overrides ?? [], pagePath, device.name);
      if (resolved.skip === true) {
        skipped.push({ id: `${pagePath}@${device.name}`, reason: 'skipped by override' });
        continue;
      }
      const mode = resolved.mode ?? defaultMode;
      const format = resolved.format ?? defaultFormat;
      const schemes = resolved.schemes?.length
        ? resolved.schemes
        : (options.schemes?.length ? options.schemes : (['light'] as Scheme[]));
      const ext = format === 'jpeg' ? 'jpg' : format;

      for (const scheme of schemes) {
        const url = new URL(path.posix.join('/', pagePath), options.base).toString();
        const modeSuffix = mode === 'element' ? '-element' : mode === 'aboveTheFold' ? '-fold' : '';
        // Light + png + the default mode keeps the historical `device.png` path
        // so existing runs, galleries, and tests are unaffected. Non-png
        // formats need no suffix — the extension already distinguishes them.
        const historical = scheme === 'light' && format === 'png' && modeSuffix === '';
        const qualifiers = [
          ...(scheme === 'light' ? [] : [scheme]),
          ...(modeSuffix === '' ? [] : [modeSuffix.replace(/^-/, '')]),
        ];
        const fileName = historical
          ? `${device.name}.png`
          : `${device.name}${qualifiers.length > 0 ? `-${qualifiers.join('-')}` : ''}.${ext}`;
        // The id carries the format too, so two formats of one page x viewport
        // stay distinct even though their filenames differ only by extension.
        const idQualifiers = [...qualifiers, ...(format === 'png' ? [] : [format])];
        jobs.push({
          id: historical
            ? `${pagePath}@${device.name}`
            : `${pagePath}@${device.name}@${idQualifiers.join('@')}`,
          pagePath,
          pageSlug: slug,
          url,
          device,
          mode,
          ...(resolved.selector ? { selector: resolved.selector } : {}),
          ...(resolved.foldOffset !== undefined ? { foldOffset: resolved.foldOffset } : {}),
          scheme,
          format,
          ...(resolved.quality !== undefined ? { quality: resolved.quality } : {}),
          ...(resolved.frame !== undefined ? { frame: resolved.frame } : {}),
          ...(resolved.timeoutMs !== undefined ? { timeoutMs: resolved.timeoutMs } : {}),
          ...(resolved.attempts !== undefined ? { attempts: resolved.attempts } : {}),
          relPath: `screenshots/${slug}/${fileName}`,
        });
      }
    }
  }

  return { jobs, collisions, skipped };
}

/**
 * Merge every override that applies to one (page, viewport) pair (FR-11).
 *
 * Matches are additive and later entries win, so a broad viewport rule can be
 * refined by a narrow page rule further down the list.
 */
export function resolveOverride(
  overrides: CaptureOverride[],
  pagePath: string,
  viewportName: string,
): CaptureOverride {
  const merged: CaptureOverride = {};
  for (const override of overrides) {
    if (!matchesAny(pagePath, override.pages ?? [])) continue;
    if (!matchesAny(viewportName, override.viewports ?? [])) continue;
    Object.assign(merged, override);
    // `fullPage` is the long-standing shorthand for the mode, so it is folded
    // into `mode` here rather than duplicated downstream.
    if (override.fullPage !== undefined && override.mode === undefined) {
      merged.mode = override.fullPage ? 'fullPage' : 'viewport';
    }
  }
  return merged;
}

