import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

import type { Browser, BrowserContext, BrowserContextOptions, Page } from "playwright"

import type { ResolvedConfig } from "./config.ts"
import type { AttemptRecord, Job } from "./jobs.ts"
import { assetFromJob, type ManifestAsset } from "./manifest.ts"
import { detectBrokenPage, isNearUniform, STRATEGY_LABEL, stabilize, type WaitStrategy } from "./stabilize.ts"

/**
 * Capture one job (FR-7, FR-8, FR-17).
 *
 * FR-7 is followed literally: one shared `Browser`, a fresh isolated
 * `BrowserContext` per viewport, created and closed inside the job. Concurrency
 * is therefore bounded by the worker pool, not by luck.
 */

/** PRD section 8: every rung of the ladder escalates the wait strategy. */
const LADDER: WaitStrategy[] = ["standard", "patient", "fallback"]

export type CaptureOutcome =
  | { ok: true; asset: ManifestAsset; attempts: AttemptRecord[] }
  | { ok: false; reason: string; attempts: AttemptRecord[]; tracePath?: string }

/** Signals "this attempt failed, climb the ladder" rather than "abort the run". */
class AttemptFailed extends Error {}

export async function captureJob(
  browser: Browser,
  job: Job,
  config: ResolvedConfig,
  runDir: string,
  log: (message: string, fields?: Record<string, unknown>) => void,
): Promise<CaptureOutcome> {
  const maxAttempts = config.stabilize.attempts
  const attemptLog: AttemptRecord[] = []
  let lastReason = "unknown failure"
  let tracePath: string | undefined

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const strategy = (LADDER[Math.min(attempt - 1, LADDER.length - 1)] ?? "standard") as WaitStrategy
    const started = Date.now()
    const isFinalAttempt = attempt === maxAttempts

    const context = await browser.newContext(contextOptions(job, config))
    let page: Page | undefined
    // The trace must be written while the context is alive, and stopping it twice
    // is an error, so exactly one path owns it per attempt.
    let traceOwned = false

    try {
      await context.tracing.start({ snapshots: true, screenshots: false, sources: false })
      traceOwned = true

      page = await context.newPage()
      const response = await page.goto(job.url, {
        waitUntil: strategy === "fallback" ? "domcontentloaded" : "load",
        timeout: config.stabilize.timeoutMs,
      })

      const status = response?.status() ?? null
      if (status !== null && status >= 400) throw new AttemptFailed(`HTTP ${status} for ${job.url}`)

      await stabilize(page, config, strategy, (message, fields) =>
        log(`${job.id} (attempt ${attempt}): ${message}`, fields),
      )

      const broken = await detectBrokenPage(page)
      if (broken !== null) throw new AttemptFailed(broken)

      const buffer = await page.screenshot({
        type: "png",
        fullPage: job.mode === "fullPage",
        timeout: Math.round(config.stabilize.timeoutMs * 1.5),
      })

      // FR-18: a near-uniform frame is a failure with a reason, never a blank
      // tile in someone's gallery. Judged on decoded pixels, because compressed
      // byte counts misjudge clean, mostly-white pages.
      if (await isNearUniform(page, buffer)) {
        throw new AttemptFailed(`blank frame (${buffer.length} bytes for ${job.device.width}x${job.device.height})`)
      }

      const absolute = path.join(runDir, job.relPath)
      await mkdir(path.dirname(absolute), { recursive: true })
      await writeFile(absolute, buffer)

      const durationMs = Date.now() - started
      attemptLog.push({ attempt, strategy: STRATEGY_LABEL[strategy], durationMs, status })
      await context.tracing.stop()
      traceOwned = false

      log(`captured ${job.relPath}`, { attempt, ms: durationMs, bytes: buffer.length })
      return {
        ok: true,
        asset: assetFromJob(job, {
          bytes: buffer.length,
          contentHeight: await measureContentHeight(page, job),
          attempts: attempt,
          durationMs,
          strategy: STRATEGY_LABEL[strategy],
        }),
        attempts: attemptLog,
      }
    } catch (err) {
      lastReason = err instanceof AttemptFailed ? err.message : (err as Error).message
      attemptLog.push({
        attempt,
        strategy: STRATEGY_LABEL[strategy],
        durationMs: Date.now() - started,
        status: null,
        error: lastReason,
      })

      if (isFinalAttempt) {
        // FR-17: keep the trace of the last failed attempt only.
        const saved = await saveTrace(context, runDir, job).catch(() => undefined)
        if (saved !== undefined) tracePath = saved
        traceOwned = false
      } else {
        log(`retrying ${job.id}: ${lastReason}`, { attempt, next: attempt + 1 })
      }
      continue
    } finally {
      if (traceOwned) await context.tracing.stop().catch(() => undefined)
      // FR-24: contexts are closed before the run finalizes any output.
      await page?.close().catch(() => undefined)
      await context.close().catch(() => undefined)
    }
  }

  return { ok: false, reason: lastReason, attempts: attemptLog, ...(tracePath ? { tracePath } : {}) }
}

/**
 * Context options for one job (FR-6, FR-10, G4 determinism).
 *
 * Device emulation belongs on the context, which is what lets three viewports
 * run concurrently without sharing state. Locale and timezone are pinned so a
 * run on a laptop in Lagos produces the same pixels as CI in Ohio.
 */
function contextOptions(job: Job, config: ResolvedConfig): BrowserContextOptions {
  return {
    viewport: { width: job.device.width, height: job.device.height },
    deviceScaleFactor: job.device.deviceScaleFactor,
    isMobile: job.device.mobile,
    hasTouch: job.device.mobile,
    locale: "en-US",
    timezoneId: "UTC",
    // FR-10: reduced-motion is honoured at the engine level, on top of the CSS
    // freeze, because some components read the media query rather than CSS.
    reducedMotion: config.stabilize.disableAnimations ? "reduce" : "no-preference",
  }
}

/** Page height as the document reported it, so a gallery can label tall captures. */
async function measureContentHeight(page: Page, job: Job): Promise<number> {
  if (job.mode !== "fullPage") return job.device.height
  try {
    const height = await page.evaluate(() => document.documentElement.scrollHeight)
    return typeof height === "number" && height > 0 ? height : job.device.height
  } catch {
    return job.device.height
  }
}

/**
 * Writes the retained trace and returns its run-relative path.
 *
 * `tracing.stop({ path })` both ends the trace and persists it, so this must be
 * called instead of — never in addition to — a plain stop().
 */
async function saveTrace(context: BrowserContext, runDir: string, job: Job): Promise<string> {
  const relative = path.join("logs", "traces", `${job.pageSlug}-${job.device.name}.zip`)
  const absolute = path.join(runDir, relative)
  await mkdir(path.dirname(absolute), { recursive: true })
  await context.tracing.stop({ path: absolute })
  return relative.split(path.sep).join("/")
}
