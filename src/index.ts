/**
 * Public API. `npx capturekit` uses `src/cli.ts`; a project that wants to embed
 * capture (the GitHub Action, an M3 webhook handler) imports this instead.
 */
export { defineConfig, configSchema, parseConfig, buildConfig } from "./config.ts"
export type { InputConfig, ResolvedConfig } from "./config.ts"
export { DEVICES, DEFAULT_VIEWPORTS } from "./devices.ts"
export type { Device } from "./devices.ts"
export { planJobs, pageSlug } from "./jobs.ts"
export type { Job, CaptureMode, JobFailure } from "./jobs.ts"
export { captureJob } from "./capture.ts"
export { run, VERSION } from "./run.ts"
export type { RunOptions, RunResult } from "./run.ts"
export { buildManifest, readManifest, writeManifest } from "./manifest.ts"
export type { Manifest, ManifestAsset, ManifestFailure } from "./manifest.ts"
export { createRun, readLatestPointer, writeLatestPointer } from "./rundir.ts"
export type { RunLocation } from "./rundir.ts"
export { stabilize, FREEZE_CSS, isNearUniform, detectBrokenPage } from "./stabilize.ts"
export type { WaitStrategy } from "./stabilize.ts"
export { CaptureKitError, ExitCode, isCaptureKitError } from "./exit.ts"
export { Logger } from "./log.ts"
export type { LogLevel, LogRecord } from "./log.ts"
