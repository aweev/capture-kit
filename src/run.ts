import { appendFile } from "node:fs/promises"
import { execFile } from "node:child_process"
import path from "node:path"
import process from "node:process"
import { promisify } from "node:util"

import { chromium, type Browser } from "playwright"
import pLimit from "p-limit"

import { buildConfig, type ResolvedConfig } from "./config.ts"
import { captureJob } from "./capture.ts"
import { CaptureKitError, ExitCode } from "./exit.ts"
import { planJobs, type Job, type JobFailure } from "./jobs.ts"
import { Logger, type LogLevel } from "./log.ts"
import { buildManifest, writeManifest, type Manifest, type ManifestAsset } from "./manifest.ts"
import { createRun, writeLatestPointer, type RunLocation } from "./rundir.ts"

/**
 * The run: plan, capture in parallel, package (PRD section 8 pipeline minus
 * discovery and post-processing, which land in M1).
 *
 * Principle 2 shapes this function: a failed job is recorded, never allowed to
 * abort the run. Only a failure of the *infrastructure* (no browser) stops
 * everything, and then with a reason and an exit code.
 */
export const VERSION = "0.0.1"

export type RunOptions = {
  json?: boolean
  quiet?: boolean
  level?: LogLevel
  /** Fraction of jobs that may fail before the exit code turns non-zero. */
  maxFailureRate?: number
  cwd?: string
  url?: string
  config?: string
  noConfig?: boolean
  viewport?: string[]
  pages?: string
  outDir?: string
  fullPage?: boolean
  concurrency?: number
  timeoutMs?: number
}

export type RunResult = {
  exitCode: number
  run: RunLocation
  manifest: Manifest
  /** Absolute path of `manifest.json`, for `--json` consumers. */
  manifestPath: string
}

const execFileAsync = promisify(execFile)

/** `branch@sha`, captured without failing when there is no git here (FR-29). */
async function detectGitRef(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--short", "HEAD"], { cwd })
    const sha = stdout.trim()
    if (!sha) return undefined
    const branch = (await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd })).stdout.trim()
    return branch ? `${branch}@${sha}` : sha
  } catch {
    return undefined
  }
}

export async function run(options: RunOptions): Promise<RunResult> {
  const config = await buildConfig(options)
  const location = await createRun(config.outDir)

  // JSONL starts immediately, so even a crashed run leaves a trace of how far
  // it got (section 9: logs/run.log.json).
  const logFile = path.join(location.logsDir, "run.log.json")
  const log = new Logger({ level: options.level, quiet: options.quiet }).withFile((record) => {
    void appendFile(logFile, JSON.stringify(record) + "\n", "utf8").catch(() => undefined)
  })

  log.debug("config resolved", { source: config.source, concurrency: config.concurrency })
  log.info(`target ${config.target}`, {
    viewports: config.devices.map((device) => device.name).join(", "),
  })

  const { jobs, collisions } = planJobs({
    base: config.base,
    pages: config.pages,
    devices: config.devices,
    fullPage: config.capture.fullPage,
  })
  if (collisions.length > 0) log.warn("renamed colliding page slugs", { collisions })
  log.info(`planned ${jobs.length} job${jobs.length === 1 ? "" : "s"}`, {
    pages: config.pages.length,
    viewports: config.devices.length,
  })

  const startedAt = new Date()
  const assets: ManifestAsset[] = []
  const failures: JobFailure[] = []
  const gitRef = await detectGitRef(process.cwd())

  let browser: Browser
  try {
    browser = await chromium.launch({ headless: true })
  } catch (err) {
    throw new CaptureKitError(
      `could not start Chromium: ${(err as Error).message}`,
      ExitCode.Environment,
      "Run `capturekit doctor` to see how to provision the browser.",
    )
  }

  try {
    const chromiumVersion = browser.version()
    // FR-7: one shared browser, one isolated context per job, one bounded pool.
    const limit = pLimit(config.concurrency)

    await Promise.all(
      jobs.map((job) =>
        limit(async () => {
          try {
            const outcome = await captureJob(browser, job, config, location.dir, (message, fields) =>
              log.debug(message, fields),
            )
            if (outcome.ok) {
              assets.push(outcome.asset)
              return
            }
            failures.push({
              job,
              reason: outcome.reason,
              attempts: outcome.attempts.length,
              attemptsDetail: outcome.attempts,
              ...(outcome.tracePath ? { tracePath: outcome.tracePath } : {}),
            })
            log.error(`${job.pagePath} @ ${job.device.name}: ${outcome.reason}`, {
              attempts: outcome.attempts.map((entry) => `${entry.attempt}:${entry.strategy}`),
              ...(outcome.tracePath ? { trace: outcome.tracePath } : {}),
            })
          } catch (err) {
            // A defect in the harness itself must not sink the other jobs.
            failures.push({ job, reason: `internal error: ${(err as Error).message}`, attempts: 0, attemptsDetail: [] })
            log.error(`internal error on ${job.id}`, { error: String(err) })
          }
        }),
      ),
    )

    // Deterministic order so two runs of the same site diff cleanly (G4).
    assets.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    failures.sort((a, b) => (a.job.id < b.job.id ? -1 : 1))

    const finishedAt = new Date()
    const manifest = buildManifest({
      runId: location.runId,
      startedAt,
      finishedAt,
      target: config.target,
      version: VERSION,
      chromium: chromiumVersion,
      ...(gitRef ? { gitRef } : {}),
      configSource: config.source,
      concurrency: config.concurrency,
      viewports: config.devices.map((device) => device.name),
      planned: jobs.length,
      assets,
      failures: failures.map(toManifestFailure),
    })

    const manifestPath = await writeManifest(location.dir, manifest)
    await writeLatestPointer(config.outDir, location)

    // FR-39: non-zero only past the configured threshold, so one broken page on
    // a 12-page site does not fail a pipeline.
    const failureRate = jobs.length === 0 ? 1 : failures.length / jobs.length
    const exitCode = failureRate > (options.maxFailureRate ?? 0.5) ? ExitCode.CaptureFailed : ExitCode.Ok

    log.info(
      `${assets.length}/${jobs.length} captured in ${(manifest.durationMs / 1000).toFixed(1)}s` +
        (failures.length > 0 ? `, ${failures.length} failed` : ""),
    )
    log.info(`output ${location.dir}`)

    return { exitCode, run: location, manifest, manifestPath }
  } finally {
    await browser.close().catch(() => undefined)
  }
}

function toManifestFailure(failure: JobFailure): Manifest["failures"][number] {
  return {
    page: failure.job.pagePath,
    viewport: failure.job.device.name,
    type: "screenshot",
    reason: failure.reason,
    attempts: failure.attempts,
    attemptLog: failure.attemptsDetail,
    ...(failure.tracePath ? { tracePath: failure.tracePath } : {}),
    durationMs: failure.attemptsDetail.reduce((total, entry) => total + entry.durationMs, 0),
  }
}

/** Re-exported so the CLI and tests can import types from one place. */
export type { Job, ResolvedConfig }
