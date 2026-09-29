import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Browser, BrowserContext, BrowserContextOptions, Page, Video } from 'playwright';

import type { ResolvedConfig } from './config.ts';
import { applyDeterminism, applyMask } from './determinism.ts';
import { runFlowSteps, flowSlug } from './flows.ts';
import { qaPageFrom, runQaChecks, type QaFinding } from './qa.ts';
import type { AttemptRecord, Job } from './jobs.ts';
import { assetFromJob, type ManifestAsset, type ManifestVideo } from './manifest.ts';
import { dismissOverlays, hideSelectors, OVERLAY_HOSTS } from './overlays.ts';
import {
  detectBrokenPage,
  isNearUniform,
  STRATEGY_LABEL,
  stabilize,
  type WaitStrategy,
} from './stabilize.ts';
import { postProcessRecording, videoBaseName, walkthrough } from './video.ts';

/**
 * Capture one job (FR-7, FR-8, FR-17, plus M2: FR-10 schemes, FR-9 formats,
 * FR-15 overlays, FR-16 determinism, FR-21 flows, FR-28 env; M1: FR-19/20/22
 * walkthrough video recorded in the same visit, then transcoded).
 *
 * FR-7 is followed literally: one shared `Browser`, a fresh isolated
 * `BrowserContext` per viewport, created and closed inside the job. Concurrency
 * is therefore bounded by the worker pool, not by luck.
 */

/** PRD section 8: every rung of the ladder escalates the wait strategy. */
const LADDER: WaitStrategy[] = ['standard', 'patient', 'fallback'];

export type CaptureOutcome =
  | { ok: true; asset: ManifestAsset; videos: ManifestVideo[]; attempts: AttemptRecord[] }
  | { ok: false; reason: string; attempts: AttemptRecord[]; tracePath?: string };

/** Signals "this attempt failed, climb the ladder" rather than "abort the run". */
class AttemptFailed extends Error {}

export async function captureJob(
  browser: Browser,
  job: Job,
  config: ResolvedConfig,
  runDir: string,
  log: (message: string, fields?: Record<string, unknown>) => void,
  hooks: { onQa?: (job: Job, findings: QaFinding[]) => void } = {},
): Promise<CaptureOutcome> {
  const maxAttempts = effectiveAttempts(job, config);
  const attemptLog: AttemptRecord[] = [];
  let lastReason = 'unknown failure';
  let tracePath: string | undefined;
  // Raw WebM recordings land here; finalized clips move to videos/, and the
  // staging dir is removed when the job ends (success or failure).
  //
  // The dir is per *job*, not per run. Playwright keeps writing the WebM until
  // its context closes, and jobs run concurrently: one shared folder meant a
  // finishing job could `rm` the directory out from under a job still recording
  // into it, which produced silently truncated (sometimes zero-byte) clips.
  const recordVideo = config.video?.walkthrough === true;
  const stagingDir = path.join(runDir, '.recording', stagingName(job));

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const strategy = (LADDER[Math.min(attempt - 1, LADDER.length - 1)] ??
        'standard') as WaitStrategy;
      const started = Date.now();
      const isFinalAttempt = attempt === maxAttempts;

      if (recordVideo) await mkdir(stagingDir, { recursive: true });
      const context = await browser.newContext(
        contextOptions(job, config, recordVideo ? stagingDir : undefined),
      );

      // FR-15: block widget hosts before the first request, so the page never
      // pays for a chat iframe it will only be told to hide.
      const blockedHosts = [
        ...new Set([
          ...(config.stabilize.blockHosts ?? []),
          ...(config.stabilize.blockKnownHosts === true ? [...OVERLAY_HOSTS] : []),
        ]),
      ];
      if (blockedHosts.length > 0) {
        await blockHosts(context, blockedHosts, (message, fields) =>
          log(`${job.id} (attempt ${attempt}): ${message}`, fields),
        );
      }

      // FR-28: configured cookies ride on the context, so a capture can see the
      // same session a real visitor would without a full login recipe.
      const configuredCookies = (config as { authResolved?: { cookies?: unknown[] } }).authResolved
        ?.cookies;
      if (Array.isArray(configuredCookies) && configuredCookies.length > 0) {
        await context
          .addCookies(configuredCookies as Parameters<BrowserContext['addCookies']>[0])
          .catch((err: Error) =>
            log(`${job.id} (attempt ${attempt}): could not set cookies: ${err.message}`),
          );
      }
      let page: Page | undefined;
      // The trace must be written while the context is alive, and stopping it twice
      // is an error, so exactly one path owns it per attempt.
      let traceOwned = false;

      try {
        await context.tracing.start({ snapshots: true, screenshots: false, sources: false });
        traceOwned = true;

        page = await context.newPage();
        // The recording (when enabled) starts with the context; everything
        // before the walkthrough is trimmed as dead time (FR-22).
        const clip: Video | null = recordVideo ? page.video() : null;
        // FR-16: determinism globals must exist before page scripts run where
        // possible; re-applied here as well for navigations.
        await applyDeterminism(page, {
          ...(config.stabilize.freezeTime ? { freezeTime: config.stabilize.freezeTime } : {}),
          ...(config.stabilize.seedRandom ? { seedRandom: true } : {}),
        });
        const response = await page.goto(job.url, {
          waitUntil: strategy === 'fallback' ? 'domcontentloaded' : 'load',
          timeout: config.stabilize.timeoutMs,
        });

        const status = response?.status() ?? null;
        if (status !== null && status >= 400)
          throw new AttemptFailed(`HTTP ${status} for ${job.url}`);

        // FR-21: scripted flow drives the page before stabilization. Flows run
        // after navigation so `goto` steps resolve against the live base URL.
        const flow = config.flows?.find((f) => f.name === job.flowName);
        if (flow) {
          try {
            await runFlowSteps(
              page,
              flow,
              { base: config.base, showCursor: config.cursor === true, defaultTimeoutMs: 10000 },
              (message, fields) => log(`${job.id} (attempt ${attempt}): ${message}`, fields),
            );
          } catch (err) {
            throw new AttemptFailed((err as Error).message);
          }
        }

        await stabilize(
          page,
          config,
          strategy,
          (message, fields) => log(`${job.id} (attempt ${attempt}): ${message}`, fields),
          job.timeoutMs !== undefined ? { timeoutMs: job.timeoutMs } : {},
        );

        // FR-15: dismiss overlays after stabilization (banners often mount late),
        // then mask dynamic regions (FR-16) so the frame is pixel-stable.
        if (config.stabilize.dismissOverlays !== false) {
          const dismissed = await dismissOverlays(
            page,
            config.stabilize.dismissSelectors ?? [],
            (message, fields) => log(`${job.id} (attempt ${attempt}): ${message}`, fields),
          );
          if (dismissed.dismissed + dismissed.hidden > 0) {
            log(`${job.id} (attempt ${attempt}): dismissed overlays`, {
              dismissed: dismissed.dismissed,
              hidden: dismissed.hidden,
            });
          }
        }
        if (config.stabilize.mask?.length) {
          await applyMask(page, config.stabilize.mask, config.stabilize.maskMode ?? 'black');
        }
        // FR-15 fallback: when the built-in library is switched off the user's
        // own selectors still have to be honoured, or `dismissSelectors` would
        // silently mean "hide only if we also auto-dismiss".
        if (config.stabilize.dismissOverlays === false && config.stabilize.dismissSelectors?.length) {
          const hidden = await hideSelectors(page, config.stabilize.dismissSelectors);
          if (hidden > 0) {
            log(`${job.id} (attempt ${attempt}): hid ${hidden} configured selector(s)`);
          }
        }

        // FR-42: visual QA pass on the settled DOM. Advisory only — findings
        // are reported, never fail the capture.
        if (config.qa?.enabled === true) {
          try {
            const findings = await runQaChecks(qaPageFrom(page), {
              maxPerRule: config.qa.maxPerRule ?? 10,
            });
            if (findings.length > 0) {
              log(`${job.id}: qa flagged ${findings.length} issue(s)`, {
                rules: [...new Set(findings.map((f) => f.rule))],
              });
              hooks.onQa?.(job, findings);
            }
          } catch {
          /* QA must never fail a capture */
          }
        }

        const broken = await detectBrokenPage(page);
        if (broken !== null) throw new AttemptFailed(broken);

        // FR-17: a frame that is still moving is not a frame. Measured on the
        // live page right before the shot, so a page that settled 4 s ago but
        // shifted because of a late hydration is caught rather than shipped.
        const layoutShift = await measureLayoutShift(page);
        const shiftBudget = config.stabilize.maxLayoutShift ?? 0;
        if (shiftBudget > 0 && layoutShift > shiftBudget) {
          throw new AttemptFailed(
            `layout shift ${layoutShift.toFixed(3)} exceeds ${shiftBudget} (page still moving)`,
          );
        }

        const format = job.format ?? config.capture?.format ?? 'png';
        const quality = job.quality ?? config.capture?.quality ?? 80;
        const screenshotType = format === 'jpeg' ? 'jpeg' : format;
        const shot = await captureShot(page, job, {
          type: screenshotType,
          quality,
          timeout: Math.round(effectiveTimeoutMs(job, config) * 1.5),
        });
        const buffer = shot.buffer;

        // FR-18: a near-uniform frame is a failure with a reason, never a blank
        // tile in someone's gallery. Judged on decoded pixels, because compressed
        // byte counts misjudge clean, mostly-white pages.
        if (await isNearUniform(page, buffer)) {
          throw new AttemptFailed(
            `blank frame (${buffer.length} bytes for ${job.device.width}x${job.device.height})`,
          );
        }

        const absolute = path.join(runDir, job.relPath);
        await mkdir(path.dirname(absolute), { recursive: true });
        await writeFile(absolute, buffer);

        const contentHeight = await measureContentHeight(page, job);
        const durationMs = Date.now() - started;
        attemptLog.push({ attempt, strategy: STRATEGY_LABEL[strategy], durationMs, status });
        await context.tracing.stop();
        traceOwned = false;

        // FR-20/24: walkthrough while recording, then close the page and context
        // so the clip file is final before post-processing touches it.
        let videos: ManifestVideo[] = [];
        if (clip) {
          const walkthroughStart = Date.now();
          await walkthrough(page, { durationMs: config.video?.durationMs ?? 5000 });
          await page.close().catch(() => undefined);
          page = undefined;
          await context.close().catch(() => undefined);
          try {
            videos = await finalizeClip(job, config, runDir, clip, {
              trimStartSec: Math.max(0, (walkthroughStart - started) / 1000),
              attempts: attempt,
              durationMs: Date.now() - walkthroughStart,
              strategy: STRATEGY_LABEL[strategy],
            });
            log(`recorded ${videos.map((v) => v.path).join(', ')}`, {
              attempt,
              bytes: videos.reduce((n, v) => n + v.bytes, 0),
            });
          } catch (err) {
          // A failed transcode must not sink the screenshot (Principle 2).
            log(`video post-processing failed for ${job.id}; keeping screenshot`, {
              error: (err as Error).message,
            });
          }
        }

        log(`captured ${job.relPath}`, { attempt, ms: durationMs, bytes: buffer.length });
        return {
          ok: true,
          asset: assetFromJob(job, {
            bytes: buffer.length,
            contentHeight,
            attempts: attempt,
            durationMs,
            strategy: STRATEGY_LABEL[strategy],
            ...(config.capture?.frame && config.capture.frame !== 'none'
              ? { frame: config.capture.frame }
              : {}),
            ...(shot.clip ? { clip: shot.clip } : {}),
          }),
          videos,
          attempts: attemptLog,
        };
      } catch (err) {
        lastReason = err instanceof AttemptFailed ? err.message : (err as Error).message;
        attemptLog.push({
          attempt,
          strategy: STRATEGY_LABEL[strategy],
          durationMs: Date.now() - started,
          status: null,
          error: lastReason,
        });

        if (isFinalAttempt) {
          // FR-17: keep the trace of the last failed attempt only.
          const saved = await saveTrace(context, runDir, job).catch(() => undefined);
          if (saved !== undefined) tracePath = saved;
          traceOwned = false;
        } else {
          log(`retrying ${job.id}: ${lastReason}`, { attempt, next: attempt + 1 });
        }
        continue;
      } finally {
        if (traceOwned) await context.tracing.stop().catch(() => undefined);
        // FR-24: contexts are closed before the run finalizes any output.
        await page?.close().catch(() => undefined);
        await context.close().catch(() => undefined);
      }
    }
  } finally {
    // Raw recordings of failed attempts never leave the staging dir.
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
  }

  return {
    ok: false,
    reason: lastReason,
    attempts: attemptLog,
    ...(tracePath ? { tracePath } : {}),
  };
}

/**
 * Filesystem-safe, collision-free name for one job's recording staging folder.
 * Derived from the job identity so two concurrent jobs never share a directory.
 */
export function stagingName(job: Job): string {
  const scheme = job.scheme && job.scheme !== 'light' ? `-${job.scheme}` : '';
  const flow = job.flowName ? `-${flowSlug(job.flowName)}` : '';
  return `${job.pageSlug}-${job.device.name}${scheme}${flow}`.replace(/[^A-Za-z0-9._-]+/g, '_');
}

/**
 * Effective ready budget for one job (FR-11 lets a page override the run's).
 */
function effectiveTimeoutMs(job: Job, config: ResolvedConfig): number {
  return job.timeoutMs ?? config.stabilize.timeoutMs;
}

/** Effective attempt ceiling for one job (FR-11 override, clamped to the ladder). */
function effectiveAttempts(job: Job, config: ResolvedConfig): number {
  return Math.min(job.attempts ?? config.stabilize.attempts, LADDER.length);
}

export type ShotResult = {
  buffer: Buffer;
  /** Measured element box in CSS px, for `element` mode. */
  clip?: { x: number; y: number; width: number; height: number };
};

/**
 * Take the screenshot for a job's mode (FR-8).
 *
 * - `viewport` — the visible box, exactly what fits on screen.
 * - `fullPage` — the whole scrollable document.
 * - `element` — the bounding box of `job.selector`, which is how a chart, a
 *   card, or a form gets a clean shot without hand-cropping.
 * - `aboveTheFold` — the first screen only, clipped at `foldOffset + viewport
 *   height`. Distinct from `viewport` because it is anchored to the page, not
 *   to wherever the stabilizer left the scroll position.
 */
async function captureShot(
  page: Page,
  job: Job,
  options: { type: 'png' | 'webp' | 'jpeg'; quality: number; timeout: number },
): Promise<ShotResult> {
  const qualityOption = options.type === 'png' ? {} : { quality: options.quality };

  if (job.mode === 'element') {
    if (!job.selector) {
      throw new AttemptFailed('element mode needs `capture.selector` (or an override selector)');
    }
    const target = page.locator(job.selector).first();
    const found = await target.count().catch(() => 0);
    if (found === 0) {
      throw new AttemptFailed(`element not found for selector ${JSON.stringify(job.selector)}`);
    }
    // Scroll it into view first: an element outside the viewport is captured,
    // but with the page still scrolled away its own reveal animations (if any)
    // would not have run.
    await target.scrollIntoViewIfNeeded({ timeout: options.timeout }).catch(() => undefined);
    let clip: ShotResult['clip'];
    try {
      const box = await target.boundingBox({ timeout: options.timeout });
      if (box) clip = { x: box.x, y: box.y, width: box.width, height: box.height };
    } catch {
      /* a box we cannot measure does not stop the capture */
    }
    const buffer = await target.screenshot({
      type: options.type,
      ...qualityOption,
      timeout: options.timeout,
    });
    return clip ? { buffer, clip } : { buffer };
  }

  if (job.mode === 'aboveTheFold') {
    const offset = job.foldOffset ?? 0;
    return {
      buffer: await page.screenshot({
        type: options.type,
        ...qualityOption,
        timeout: options.timeout,
        clip: { x: 0, y: offset, width: job.device.width, height: job.device.height },
      }),
    };
  }

  return {
    buffer: await page.screenshot({
      type: options.type,
      ...qualityOption,
      fullPage: job.mode === 'fullPage',
      timeout: options.timeout,
    }),
  };
}

/**
 * Cumulative layout shift observed in this page's lifetime (FR-17).
 *
 * Uses `performance.getEntriesByType('layout-shift')` rather than installing an
 * observer, so it also sees the shifts that happened during navigation and
 * hydration — the exact window a naive `waitForLoadState` misses. Each attempt
 * gets a fresh context, so the total is naturally per-attempt.
 */
export async function measureLayoutShift(page: Page): Promise<number> {
  try {
    return await page.evaluate(() => {
      type LayoutShiftEntry = { value: number; hadRecentInput: boolean };
      const host = performance as Performance & {
        getEntriesByType: (type: string) => unknown[];
      };
      const entries = (host.getEntriesByType('layout-shift') ?? []) as unknown as LayoutShiftEntry[];
      // Only user-input-free shifts count, as in the CLS definition.
      return entries.reduce((sum, entry) => (entry.hadRecentInput ? sum : sum + entry.value), 0);
    });
  } catch {
    // No LayoutShift support (or a hostile page) must not fail a capture.
    return 0;
  }
}

/**
 * Block third-party widget hosts at the request level (FR-15).
 *
 * Cheaper and more reliable than hiding the widget after it has loaded: a
 * blocked chat iframe never renders, never animates, and never re-opens itself.
 * Blocked requests are counted (not returned until the context closes), and the
 * route lives and dies with the context, so there is nothing to dispose.
 */
export async function blockHosts(
  context: BrowserContext,
  hosts: string[],
  warn: (message: string, fields?: Record<string, unknown>) => void = () => undefined,
): Promise<number> {
  const patterns = hosts.map((host) => host.trim().toLowerCase()).filter(Boolean);
  if (patterns.length === 0) return 0;
  let blocked = 0;
  try {
    await context.route('**/*', (route) => {
      let host: string;
      try {
        host = new URL(route.request().url()).hostname.toLowerCase();
      } catch {
        return route.continue();
      }
      if (patterns.some((pattern) => host === pattern || host.endsWith(`.${pattern}`))) {
        blocked++;
        return route.abort();
      }
      return route.continue();
    });
  } catch (err) {
    warn('request blocking unavailable; capturing with third-party requests', {
      error: (err as Error).message,
    });
  }
  return blocked;
}

/**
 * Context options for one job (FR-6, FR-10, FR-25, FR-28, G4 determinism).
 *
 * Device emulation belongs on the context, which is what lets three viewports
 * run concurrently without sharing state. Locale and timezone are pinned so a
 * run on a laptop in Lagos produces the same pixels as CI in Ohio.
 */
function contextOptions(
  job: Job,
  config: ResolvedConfig,
  recordDir?: string,
): BrowserContextOptions {
  const auth = config.auth as
    | {
        storageState?: string;
        headers?: Record<string, string>;
        locale?: string;
        timezone?: string;
        geolocation?: { latitude: number; longitude: number };
      }
    | undefined;
  let storageState: string | undefined;
  if (typeof auth?.storageState === 'string' && auth.storageState.length > 0) {
    const candidate = path.isAbsolute(auth.storageState)
      ? auth.storageState
      : path.resolve(process.cwd(), auth.storageState);
    if (existsSync(candidate)) storageState = candidate;
  }
  return {
    viewport: { width: job.device.width, height: job.device.height },
    deviceScaleFactor: job.device.deviceScaleFactor,
    isMobile: job.device.mobile,
    hasTouch: job.device.mobile,
    // FR-10: per-scheme capture via prefers-color-scheme.
    colorScheme: (job.scheme ?? 'light') === 'dark' ? 'dark' : 'light',
    locale: auth?.locale ?? 'en-US',
    timezoneId: auth?.timezone ?? 'UTC',
    ...(auth?.geolocation ? { geolocation: auth.geolocation } : {}),
    ...(auth?.headers && Object.keys(auth.headers).length > 0
      ? { extraHTTPHeaders: auth.headers }
      : {}),
    ...(storageState ? { storageState } : {}),
    // FR-19: one video per viewport, sized to the viewport. The file lands in
    // the staging dir and moves to videos/ only after post-processing.
    ...(recordDir
      ? {
        recordVideo: {
          dir: recordDir,
          size: { width: job.device.width, height: job.device.height },
        },
      }
      : {}),
    // FR-10: reduced-motion is honoured at the engine level, on top of the CSS
    // freeze, because some components read the media query rather than CSS.
    reducedMotion: config.stabilize.disableAnimations ? 'reduce' : 'no-preference',
  };
}

/**
 * Finalize one recording: wait for the closed context's file, transcode to
 * the configured formats, and describe the results for the manifest.
 */
async function finalizeClip(
  job: Job,
  config: ResolvedConfig,
  runDir: string,
  clip: Video,
  values: { trimStartSec: number; attempts: number; durationMs: number; strategy: string },
): Promise<ManifestVideo[]> {
  const rawPath = await clip.path();
  const destDir = path.join(runDir, 'videos', job.pageSlug);
  const stem = videoBaseName(job);
  const produced = await postProcessRecording(rawPath, destDir, stem, {
    formats: config.video?.formats ?? ['mp4'],
    maxSizeMB: config.video?.maxSizeMB ?? 5,
    fps: config.video?.fps ?? 15,
    trimStartSec: values.trimStartSec,
  });
  return produced.map((file) => ({
    page: job.pagePath,
    viewport: job.device.name,
    type: 'video' as const,
    path: path.relative(runDir, file.path).split(path.sep).join('/'),
    width: job.device.width,
    height: job.device.height,
    format: file.format,
    kind: 'walkthrough' as const,
    ...(job.flowName ? { flow: job.flowName } : {}),
    bytes: file.bytes,
    durationMs: values.durationMs,
    attempts: values.attempts,
    ...((job.scheme ?? 'light') === 'light' ? {} : { scheme: job.scheme as 'dark' }),
  }));
}

/** Page height as the document reported it, so a gallery can label tall captures. */
async function measureContentHeight(page: Page, job: Job): Promise<number> {
  if (job.mode !== 'fullPage') return job.device.height;
  try {
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    return typeof height === 'number' && height > 0 ? height : job.device.height;
  } catch {
    return job.device.height;
  }
}

/**
 * Writes the retained trace and returns its run-relative path.
 *
 * `tracing.stop({ path })` both ends the trace and persists it, so this must be
 * called instead of — never in addition to — a plain stop().
 */
async function saveTrace(context: BrowserContext, runDir: string, job: Job): Promise<string> {
  const suffix = job.scheme && job.scheme !== 'light' ? `-${job.scheme}` : '';
  const relative = path.join('logs', 'traces', `${job.pageSlug}-${job.device.name}${suffix}.zip`);
  const absolute = path.join(runDir, relative);
  await mkdir(path.dirname(absolute), { recursive: true });
  await context.tracing.stop({ path: absolute });
  return relative.split(path.sep).join('/');
}
