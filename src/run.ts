import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import { chromium, type Browser } from 'playwright';
import pLimit from 'p-limit';

import { resolveAuth, redactSecrets, runLoginRecipe, type ResolvedAuth } from './auth.ts';
import { buildConfig, type ResolvedConfig } from './config.ts';
import { captureJob } from './capture.ts';
import { CaptureKitError, ExitCode } from './exit.ts';
import { flowSlug } from './flows.ts';
import { planJobs, type Job, type JobFailure } from './jobs.ts';
import { Logger, type LogLevel } from './log.ts';
import { buildManifest, writeManifest, type Manifest, type ManifestEntry } from './manifest.ts';
import { resolveBrand, markdownSnippet, assetGrid, themedShell } from './branding.ts';
import { buildPrComment } from './pr-comment.ts';
import { exportZip, summaryHtml, writeSummary } from './export.ts';
import { generateAltText } from './ai-alt.ts';
import { generateClientSummary } from './ai-summary.ts';
import type { QaFinding } from './qa.ts';
import { detectRoutes, rankPages } from './routes.ts';
import { discoverPages } from './discover.ts';
import { buildGallery } from './gallery.ts';
import { publishRun } from './publish.ts';
import { loadPlugins, applyPostprocessors } from './plugins.ts';
import { createRun, writeLatestPointer, type RunLocation } from './rundir.ts';

/**
 * The run: plan, capture in parallel, package (PRD section 8 pipeline minus
 * discovery and post-processing, which land in M1).
 *
 * Principle 2 shapes this function: a failed job is recorded, never allowed to
 * abort the run. Only a failure of the *infrastructure* (no browser) stops
 * everything, and then with a reason and an exit code.
 */
export const VERSION = '0.0.1';

export type RunOptions = {
  json?: boolean;
  quiet?: boolean;
  level?: LogLevel;
  /** Fraction of jobs that may fail before the exit code turns non-zero. */
  maxFailureRate?: number;
  cwd?: string;
  url?: string;
  config?: string;
  noConfig?: boolean;
  viewport?: string[];
  pages?: string;
  outDir?: string;
  fullPage?: boolean;
  concurrency?: number;
  timeoutMs?: number;
  scheme?: string[];
  format?: string;
  frame?: string;
  exportZip?: boolean;
  ai?: boolean;
  aiKey?: string;
  discover?: boolean;
  videoWalkthrough?: boolean;
};

export type RunResult = {
  exitCode: number;
  run: RunLocation;
  manifest: Manifest;
  /** Absolute path of `manifest.json`, for `--json` consumers. */
  manifestPath: string;
};

const execFileAsync = promisify(execFile);

/** `branch@sha`, captured without failing when there is no git here (FR-29). */
async function detectGitRef(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], { cwd });
    const sha = stdout.trim();
    if (!sha) return undefined;
    const branch = (
      await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd })
    ).stdout.trim();
    return branch ? `${branch}@${sha}` : sha;
  } catch {
    return undefined;
  }
}

export async function run(options: RunOptions): Promise<RunResult> {
  const config = await buildConfig(options);
  const location = await createRun(config.outDir);

  // JSONL starts immediately, so even a crashed run leaves a trace of how far
  // it got (section 9: logs/run.log.json).
  const logFile = path.join(location.logsDir, 'run.log.json');
  const log = new Logger({ level: options.level, quiet: options.quiet }).withFile((record) => {
    void appendFile(logFile, JSON.stringify(record) + '\n', 'utf8').catch(() => undefined);
  });

  log.debug('config resolved', { source: config.source, concurrency: config.concurrency });
  // FR-26: secrets never reach logs — redact before emitting.
  log.info(redactSecrets(`target ${config.target}`), {
    viewports: config.devices.map((device) => device.name).join(', '),
    ...(config.schemes ? { schemes: config.schemes.join(', ') } : {}),
  });

  // FR-25/28: resolve auth env refs now so missing secrets fail fast, and keep
  // the resolved form so capture can apply cookies and the saved session.
  let resolvedAuth: ResolvedAuth | undefined;
  try {
    resolvedAuth = config.auth
      ? resolveAuth(config.auth as never, options.cwd ?? process.cwd())
      : undefined;
  } catch (err) {
    throw new CaptureKitError((err as Error).message, ExitCode.Config);
  }
  if (resolvedAuth) config.authResolved = resolvedAuth;

  // FR-2: framework route adapters contribute pages when a project path is
  // supplied. They join the explicit list as discovery seeds (FR-1).
  let seedPages = config.pages;
  if (config.routes?.projectPath) {
    try {
      const { framework, routes } = await detectRoutes(config.routes.projectPath, {
        maxRoutes: config.routes.maxRoutes ?? 20,
      });
      if (routes.length > 0) {
        const seen = new Set(seedPages);
        for (const route of routes) {
          const pagePath = route.path.startsWith('/') ? route.path : `/${route.path}`;
          if (!seen.has(pagePath)) {
            seen.add(pagePath);
            seedPages = [...seedPages, pagePath];
          }
        }
        log.info(`route adapter (${framework}) added ${routes.length} page(s)`);
      }
    } catch (err) {
      log.warn('route adapter failed; continuing with configured pages', {
        error: (err as Error).message,
      });
    }
  }

  // FR-1: auto-discovery via sitemap, robots hints, then same-origin crawl.
  // Explicit pages always survive; FR-4 ranking orders the rest by home,
  // nav destinations, and inbound link count when the cap is hit.
  let pages = seedPages;
  if (config.discovery?.mode !== 'off') {
    try {
      const discovery = await discoverPages({
        base: config.base,
        configPages: seedPages,
        include: config.discovery?.include ?? [],
        exclude: config.discovery?.exclude ?? [],
        maxDepth: config.discovery?.depth ?? 2,
        maxPages: config.discovery?.maxPages ?? 20,
      });
      pages = rankPages(discovery.pages, {
        navLinks: discovery.navLinks,
        inbound: discovery.inbound,
      });
      const found = pages.length - seedPages.length;
      if (found > 0) log.info(`discovery found ${found} additional page(s)`);
    } catch (err) {
      log.warn('discovery failed; continuing with configured pages', {
        error: (err as Error).message,
      });
    }
  }

  // M5: plugins extend the core without touching it. A broken plugin warns,
  // never fails the run.
  const plugins = await loadPlugins(config.plugins ?? [], options.cwd ?? process.cwd()).catch(
    (err: Error) => {
      log.warn('plugin loading failed; continuing without plugins', { error: err.message });
      return [];
    },
  );

  const { jobs: pageJobs, collisions, skipped: skippedJobs } = planJobs({
    base: config.base,
    pages,
    devices: config.devices,
    fullPage: config.capture.fullPage,
    ...(config.schemes ? { schemes: config.schemes } : {}),
    ...(config.capture?.format ? { format: config.capture.format } : {}),
    ...(config.capture.mode ? { mode: config.capture.mode } : {}),
    ...(config.capture.selector ? { selector: config.capture.selector } : {}),
    ...(config.overrides?.length ? { overrides: config.overrides } : {}),
  });
  // FR-21: flows fan out per page x viewport x scheme when capture is enabled.
  const jobs: Job[] = [];
  for (const job of pageJobs) {
    const flows = (config.flows ?? []).filter((f) => f.capture !== false);
    if (flows.length === 0) {
      jobs.push(job);
      continue;
    }
    jobs.push(job);
    for (const flow of flows) {
      const slug = flowSlug(flow.name);
      const ext = (job.format ?? 'png') === 'jpeg' ? 'jpg' : (job.format ?? 'png');
      const schemeSuffix = job.scheme && job.scheme !== 'light' ? `-${job.scheme}` : '';
      jobs.push({
        ...job,
        id: `${job.id}#${slug}`,
        flowName: flow.name,
        url: job.url,
        relPath: `screenshots/${job.pageSlug}/${job.device.name}${schemeSuffix}-${slug}.${ext}`,
      });
    }
  }
  if (collisions.length > 0) log.warn('renamed colliding page slugs', { collisions });
  if (skippedJobs.length > 0) {
    log.info(`${skippedJobs.length} page x viewport pair(s) skipped by overrides`, {
      skipped: skippedJobs.map((s) => s.id).join(', '),
    });
  }
  log.info(`planned ${jobs.length} job${jobs.length === 1 ? '' : 's'}`, {
    pages: pages.length,
    viewports: config.devices.length,
  });

  const startedAt = new Date();
  // Screenshot jobs planned; walkthrough videos append as sibling entries, so
  // `succeeded` can exceed `planned` when video is on (FR-19/20).
  const assets: ManifestEntry[] = [];
  const failures: JobFailure[] = [];
  const qaFindings: { page: string; viewport: string; scheme?: string; findings: QaFinding[] }[] =
    [];
  const gitRef = await detectGitRef(process.cwd());

  let browser: Browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    throw new CaptureKitError(
      `could not start Chromium: ${(err as Error).message}`,
      ExitCode.Environment,
      'Run `capturekit doctor` to see how to provision the browser.',
    );
  }

  try {
    const chromiumVersion = browser.version();

    // FR-25: run the login recipe once, save storageState, and let every
    // viewport reuse it. Done after launch (it needs a context) and before the
    // pool, so twelve jobs do not each perform the same login.
    if (resolvedAuth?.hasRecipe && config.auth?.recipe && resolvedAuth.storageStatePath) {
      const storageStatePath = resolvedAuth.storageStatePath;
      try {
        log.info('running the auth login recipe');
        await runLoginRecipe(
          config.auth.recipe,
          options.cwd ?? process.cwd(),
          (contextOptions) => browser.newContext(contextOptions),
          storageStatePath,
        );
        log.info('saved auth storageState', { path: storageStatePath });
      } catch (err) {
        // A failed login would otherwise silently capture the login wall, so it
        // is a config error with the recipe named.
        throw new CaptureKitError(
          `login recipe failed: ${redactSecrets((err as Error).message)}`,
          ExitCode.Config,
          `Fix ${config.auth.recipe}, or remove \`auth.recipe\` to capture anonymously.`,
        );
      }
    }

    // FR-7: one shared browser, one isolated context per job, one bounded pool.
    const limit = pLimit(config.concurrency);

    await Promise.all(
      jobs.map((job) =>
        limit(async () => {
          try {
            const outcome = await captureJob(
              browser,
              job,
              config,
              location.dir,
              (message, fields) => log.debug(message, fields),
              {
                onQa: (failedJob, findings: QaFinding[]) => {
                  qaFindings.push({
                    page: failedJob.pagePath,
                    viewport: failedJob.device.name,
                    ...(failedJob.scheme && failedJob.scheme !== 'light'
                      ? { scheme: failedJob.scheme }
                      : {}),
                    findings,
                  });
                },
              },
            );
            if (outcome.ok) {
              assets.push(outcome.asset, ...outcome.videos);
              return;
            }
            failures.push({
              job,
              reason: outcome.reason,
              attempts: outcome.attempts.length,
              attemptsDetail: outcome.attempts,
              ...(outcome.tracePath ? { tracePath: outcome.tracePath } : {}),
            });
            log.error(
              redactSecrets(
                `${job.pagePath} @ ${job.device.name}${job.scheme && job.scheme !== 'light' ? `:${job.scheme}` : ''}${job.flowName ? `#${job.flowName}` : ''}: ${outcome.reason}`,
              ),
              {
                attempts: outcome.attempts.map((entry) => `${entry.attempt}:${entry.strategy}`),
                ...(outcome.tracePath ? { trace: outcome.tracePath } : {}),
              },
            );
          } catch (err) {
            // A defect in the harness itself must not sink the other jobs.
            failures.push({
              job,
              reason: `internal error: ${(err as Error).message}`,
              attempts: 0,
              attemptsDetail: [],
            });
            log.error(`internal error on ${job.id}`, { error: String(err) });
          }
        }),
      ),
    );

    // Deterministic order so two runs of the same site diff cleanly (G4).
    assets.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    failures.sort((a, b) => (a.job.id < b.job.id ? -1 : 1));

    const finishedAt = new Date();
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
    });

    const manifestPath = await writeManifest(location.dir, manifest);
    await writeLatestPointer(config.outDir, location);

    // FR-31/32: client-delivery files written alongside the manifest so every
    // run is shippable. Cheap, additive, and never allowed to fail the run.
    try {
      const brand = resolveBrand(config.gallery as never);
      const shots = assets.filter((a) => a.type === 'screenshot');
      const snippet = markdownSnippet(
        shots.map((a) => ({ path: a.path, page: a.page, viewport: a.viewport })),
        { target: config.target, runDirName: location.dirName },
      );
      await writeFile(path.join(location.dir, 'snippet.md'), snippet, 'utf8');
      // FR-37: PR-ready comment body, so the GitHub Action can post it as-is.
      await writeFile(path.join(location.dir, 'pr-comment.md'), buildPrComment(manifest), 'utf8');
      const grid = assetGrid(
        shots.map((a) => ({ path: a.path, page: a.page, viewport: a.viewport })),
      );
      await writeFile(path.join(location.dir, 'preview.html'), themedShell(brand, grid), 'utf8');
      await writeSummary(
        location.dir,
        summaryHtml({
          title: brand.title,
          target: config.target,
          startedAt: manifest.startedAt,
          summary: manifest.summary,
          assets: shots.map((a) => ({ page: a.page, viewport: a.viewport, path: a.path })),
        }),
      );
      // FR-42: QA report. Advisory only — written whenever findings exist.
      if (qaFindings.length > 0) {
        qaFindings.sort((a, b) =>
          a.page < b.page ? -1 : a.page > b.page ? 1 : a.viewport < b.viewport ? -1 : 1,
        );
        await writeFile(
          path.join(location.dir, 'qa.json'),
          JSON.stringify({ runId: location.runId, findings: qaFindings }, null, 2) + '\n',
          'utf8',
        );
        log.warn(`qa flagged ${qaFindings.length} capture(s); see qa.json`);
      }
      // M4: AI post-pass. Off by default; every step is warn-and-skip so a
      // model outage never fails the run. Secrets never reach logs or files.
      const aiEnabled = options.ai === true || config.ai?.enabled === true;
      if (aiEnabled) {
        const aiConfig = {
          ...config.ai,
          ...(options.aiKey ? { apiKey: options.aiKey } : {}),
        };
        try {
          const alt = await generateAltText(
            aiConfig,
            location.dir,
            assets.filter((a) => a.type === 'screenshot'),
          );
          if (Object.keys(alt).length > 0) {
            await writeFile(
              path.join(location.dir, 'alt.json'),
              JSON.stringify(alt, null, 2) + '\n',
              'utf8',
            );
            log.info(`alt text for ${Object.keys(alt).length} asset(s); see alt.json`);
          }
        } catch (err) {
          log.warn('alt-text generation skipped', {
            error: redactSecrets((err as Error).message),
          });
        }
        try {
          const summary = await generateClientSummary(aiConfig, manifest);
          await writeFile(path.join(location.dir, 'client-summary.md'), summary, 'utf8');
          log.info('client summary written; see client-summary.md');
        } catch (err) {
          log.warn('client summary skipped', {
            error: redactSecrets((err as Error).message),
          });
        }
      }
      // FR-30: the self-contained gallery (screenshots, videos, lightbox).
      // Built after the AI pass so alt.json (M4) feeds its alt attributes,
      // and before the ZIP so the bundle includes gallery + AI files.
      try {
        let altText: Record<string, { alt?: string; caption?: string }> | undefined;
        try {
          altText = JSON.parse(await readFile(path.join(location.dir, 'alt.json'), 'utf8')) as Record<
            string,
            { alt?: string; caption?: string }
          >;
        } catch {
          altText = undefined;
        }
        await buildGallery({
          runDir: location.dir,
          ...(altText ? { altText } : {}),
        });
        log.info(`gallery ${path.join(location.dir, 'index.html')}`);
      } catch (err) {
        log.warn('gallery build failed; run itself succeeded', {
          error: (err as Error).message,
        });
      }
      if (options.exportZip === true || config.export?.zip === true) {
        await exportZip({ assets: assets.map((a) => ({ path: a.path })) }, location.dir);
        await mkdir(path.dirname(path.join(location.dir, 'assets.zip')), { recursive: true });
      }
      // M5: plugin postprocessors run over captured files (best-effort).
      try {
        await applyPostprocessors(
          plugins,
          assets.map((a) => path.join(location.dir, a.path)),
          (message, fields) => log.warn(message, fields),
        );
      } catch (err) {
        log.warn('postprocessor step failed; run itself succeeded', {
          error: (err as Error).message,
        });
      }
      // FR-34: publish targets. Each is warn-and-continue.
      for (const target of config.publish ?? []) {
        try {
          const receipt = await publishRun(location.dir, target, {
            cwd: options.cwd ?? process.cwd(),
          });
          log.info(`published (${receipt.type}): ${receipt.detail}`);
        } catch (err) {
          log.warn(`publish to ${(target as { type: string }).type} failed`, {
            error: redactSecrets((err as Error).message),
          });
        }
      }
    } catch (err) {
      log.warn('export step failed; run itself succeeded', { error: (err as Error).message });
    }

    // FR-39: non-zero only past the configured threshold, so one broken page on
    // a 12-page site does not fail a pipeline.
    const failureRate = jobs.length === 0 ? 1 : failures.length / jobs.length;
    const exitCode =
      failureRate > (options.maxFailureRate ?? 0.5) ? ExitCode.CaptureFailed : ExitCode.Ok;

    log.info(
      `${assets.length}/${jobs.length} captured in ${(manifest.durationMs / 1000).toFixed(1)}s` +
        (failures.length > 0 ? `, ${failures.length} failed` : ''),
    );
    log.info(`output ${location.dir}`);

    return { exitCode, run: location, manifest, manifestPath };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

function toManifestFailure(failure: JobFailure): Manifest['failures'][number] {
  return {
    page: failure.job.pagePath,
    viewport: failure.job.device.name,
    type: 'screenshot',
    reason: failure.reason,
    attempts: failure.attempts,
    attemptLog: failure.attemptsDetail,
    ...(failure.tracePath ? { tracePath: failure.tracePath } : {}),
    durationMs: failure.attemptsDetail.reduce((total, entry) => total + entry.durationMs, 0),
  };
}

/** Re-exported so the CLI and tests can import types from one place. */
export type { Job, ResolvedConfig };
