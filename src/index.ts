/**
 * Public API. `npx capturekit` uses `src/cli.ts`; a project that wants to embed
 * capture (the GitHub Action, an M3 webhook handler) imports this instead.
 */
export { defineConfig, configSchema, parseConfig, buildConfig } from './config.ts';
export type { InputConfig, ResolvedConfig } from './config.ts';
export { DEVICES, DEFAULT_VIEWPORTS } from './devices.ts';
export type { Device } from './devices.ts';
export { planJobs, pageSlug } from './jobs.ts';
export type { Job, CaptureMode, JobFailure, Scheme } from './jobs.ts';
export { captureJob } from './capture.ts';
export { run, VERSION } from './run.ts';
export type { RunOptions, RunResult } from './run.ts';
export { buildManifest, readManifest, writeManifest } from './manifest.ts';
export type { Manifest, ManifestAsset, ManifestFailure } from './manifest.ts';
export { createRun, readLatestPointer, writeLatestPointer } from './rundir.ts';
export type { RunLocation } from './rundir.ts';
export { stabilize, FREEZE_CSS, isNearUniform, detectBrokenPage } from './stabilize.ts';
export type { WaitStrategy } from './stabilize.ts';
export { CaptureKitError, ExitCode, isCaptureKitError } from './exit.ts';
export { Logger } from './log.ts';
export type { LogLevel, LogRecord } from './log.ts';
export { discoverPages } from './discover.ts';
export type { DiscoveredPage, DiscoveryOptions, DiscoveryResult } from './discover.ts';
export { dismissOverlays, hideSelectors, OVERLAY_SELECTORS } from './overlays.ts';
export { applyMask, applyDeterminism, maskCss, parseFreezeTime } from './determinism.ts';
export { flowSchema, flowStepSchema, runFlowSteps, flowSlug, showCursor } from './flows.ts';
export type { Flow, FlowStep } from './flows.ts';
export { authSchema, resolveAuth, resolveSecret, redactSecrets, loadStorageState } from './auth.ts';
export type { AuthConfig, ResolvedAuth } from './auth.ts';
export { frameFor, frameCss, frameHtml } from './frames.ts';
export type { FrameKind, FrameSpec } from './frames.ts';
export {
  gallerySchema,
  resolveBrand,
  themedShell,
  assetGrid,
  markdownSnippet,
} from './branding.ts';
export type { GalleryConfig, ResolvedBrand } from './branding.ts';
export { createZip, exportZip, summaryHtml, writeSummary } from './export.ts';
export { startSchema } from './start-config.ts';
export type { StartConfig } from './start-config.ts';
export { waitForHealth, spawnApp, teardownApp, startAndCapture } from './start.ts';
export type { StartOptions } from './start.ts';
export { startCommand } from './commands/start.ts';
export type { StartCliOptions } from './commands/start.ts';
export {
  buildPrComment,
  parseGitHubRef,
  postOrUpdateComment,
  PR_COMMENT_MARKER,
} from './pr-comment.ts';
export type { PrCommentOptions, GitHubRef } from './pr-comment.ts';
export { aiSchema } from './ai-config.ts';
export type { AiConfig } from './ai-config.ts';
export { chatCompletion, resolveApiKey } from './ai-client.ts';
export type { ChatMessage, ChatPart } from './ai-client.ts';
export { generateAltText } from './ai-alt.ts';
export type { AltEntry } from './ai-alt.ts';
export { generateClientSummary } from './ai-summary.ts';
export { suggestFlows } from './ai-flows.ts';
export { qaSchema, runQaChecks, qaPageFrom } from './qa.ts';
export type { QaConfig, QaFinding, QaPage, QaOptions } from './qa.ts';
export { aiCommand } from './commands/ai.ts';
export type { AiCliOptions } from './commands/ai.ts';
export { openCommand, openFile } from './commands/open.ts';
export type { OpenCliOptions } from './commands/open.ts';
export { buildGallery, buildGalleryHtml } from './gallery.ts';
export type { GalleryOptions } from './gallery.ts';
export {
  videoSchema,
  findFfmpeg,
  walkthrough,
  transcodeMp4,
  transcodeGif,
  postProcessRecording,
  videoBaseName,
} from './video.ts';
export type { VideoConfig, VideoFile, TranscodeOptions, WalkthroughPage } from './video.ts';
export { routesSchema, detectFramework, detectRoutes, rankPages, segmentsToPath } from './routes.ts';
export type { RoutesConfig, Framework, DetectedRoute, RankSignals } from './routes.ts';
export { publishSchema, publishTargetSchema, publishRun } from './publish.ts';
export type { PublishTarget, PublishResult } from './publish.ts';
export { listRuns, matchAssets, sliderHtml } from './history.ts';
export type { HistoryEntry, ComparePair } from './history.ts';
export { pluginSchema, loadPlugins, applyPostprocessors, applyDiscoverers } from './plugins.ts';
export type { PluginHooks, LoadedPlugin, DiscoverContext } from './plugins.ts';
export { watchAndRerun } from './watch.ts';
export type { WatchOptions } from './watch.ts';
export { renderMarkdown, buildDocsSite } from './docs-site.ts';
export { historyCommand } from './commands/history.ts';
export type { HistoryCliOptions } from './commands/history.ts';
export { publishCommand } from './commands/publish.ts';
export type { PublishCliOptions } from './commands/publish.ts';
export { docsCommand } from './commands/docs.ts';
export type { DocsCliOptions } from './commands/docs.ts';
export { serveCommand, handleHook } from './commands/serve.ts';
export type { ServeCliOptions, ServeDeps } from './commands/serve.ts';
