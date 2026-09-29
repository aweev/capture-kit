import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

import { DEVICES, DEVICE_NAMES, type Device, type DeviceName } from './devices.ts';
import { CaptureKitError, ExitCode } from './exit.ts';
import { authSchema, type AuthConfig, type ResolvedAuth } from './auth.ts';
import type { CaptureMode, CaptureOverride } from './jobs.ts';
import { gallerySchema, type GalleryConfig } from './branding.ts';
import { flowSchema, type Flow } from './flows.ts';
import { startSchema, type StartConfig } from './start-config.ts';
import { aiSchema, type AiConfig } from './ai-config.ts';
import { qaSchema, type QaConfig } from './qa.ts';
import { routesSchema, type RoutesConfig } from './routes.ts';
import { publishSchema, type PublishTarget } from './publish.ts';
import { pluginSchema } from './plugins.ts';
import { videoSchema, type VideoConfig } from './video.ts';

/**
 * Config loader with Zod validation (PRD section 8).
 *
 * G1 Autonomy means the schema must be fully defaultable: every field has a
 * value that works on a first run, so `capturekit run <url>` needs no file at
 * all. Config exists only to refine, never to enable (Principle 1).
 */

const viewportDeviceSchema = z.enum(DEVICE_NAMES as [string, ...string[]]);

const viewportCustomSchema = z
  .object({
    name: z.string().min(1).max(40),
    width: z.number().int().min(200).max(10000),
    height: z.number().int().min(200).max(10000),
    deviceScaleFactor: z.number().min(1).max(4).optional(),
    mobile: z.boolean().optional(),
  })
  .strict();

const viewportSchema = z.union([viewportDeviceSchema, viewportCustomSchema]);

export const configSchema = z
  .object({
    /** The site to capture: localhost, a preview deploy, or production. */
    target: z.string().min(1).optional(),
    /** Root folder for run output. Relative paths resolve from the working dir. */
    outDir: z.string().min(1).default('captures'),
    /** Paths to capture. M0 takes an explicit list; discovery fills this in later. */
    pages: z.array(z.string()).default(['/']),
    /**
     * Per-page and per-viewport overrides (FR-11). Entries are matched in order
     * and later ones win, so a broad viewport rule can be refined by a narrow
     * page rule below it.
     */
    overrides: z
      .array(
        z
          .object({
            /** Path globs this entry applies to; omitted means every page. */
            pages: z.array(z.string().min(1)).max(50).optional(),
            /** Viewport names this entry applies to; omitted means every one. */
            viewports: z.array(z.string().min(1)).max(20).optional(),
            mode: z.enum(['viewport', 'fullPage', 'element', 'aboveTheFold']).optional(),
            selector: z.string().min(1).optional(),
            foldOffset: z.number().int().min(0).max(100000).optional(),
            fullPage: z.boolean().optional(),
            format: z.enum(['png', 'webp', 'jpeg']).optional(),
            quality: z.number().int().min(10).max(100).optional(),
            frame: z.enum(['none', 'browser', 'phone', 'auto']).optional(),
            schemes: z.array(z.enum(['light', 'dark'])).min(1).max(2).optional(),
            timeoutMs: z.number().int().min(1000).max(120000).optional(),
            attempts: z.number().int().min(1).max(3).optional(),
            /** Drop this page x viewport pair entirely. */
            skip: z.boolean().optional(),
          })
          .strict(),
      )
      .max(50)
      .default([]),
    viewports: z.array(viewportSchema).min(1).default(['mobile', 'tablet', 'desktop']),
    /** Color schemes to capture (FR-10). Light-only preserves M0 output paths. */
    schemes: z
      .array(z.enum(['light', 'dark']))
      .min(1)
      .max(2)
      .default(['light']),
    capture: z
      .object({
        fullPage: z.boolean().default(true),
        /** Playwright screenshots natively; no sharp post-processor needed. */
        format: z.enum(['png', 'webp', 'jpeg']).default('png'),
        /** JPEG/WebP quality (ignored for PNG). */
        quality: z.number().int().min(10).max(100).default(80),
        /** Device-frame mockup rendered at gallery level (FR-9). */
        frame: z.enum(['none', 'browser', 'phone', 'auto']).default('none'),
        /**
         * Screenshot mode (FR-8). `fullPage`/`viewport` remain reachable through
         * the boolean above; `element` and `aboveTheFold` are the two modes M0
         * did not have.
         */
        mode: z.enum(['viewport', 'fullPage', 'element', 'aboveTheFold']).optional(),
        /** Selector captured when `mode: "element"`. */
        selector: z.string().min(1).optional(),
        /** Scroll offset in CSS px for `aboveTheFold` (default 0 = page top). */
        foldOffset: z.number().int().min(0).max(100000).optional(),
      })
      .strict()
      // Zod 4 needs a complete default object; inner fields keep their own
      // defaults so a partial config still validates.
      .default({ fullPage: true, format: 'png', quality: 80, frame: 'none' }),

    stabilize: z
      .object({
        networkIdle: z.boolean().default(true),
        fontsReady: z.boolean().default(true),
        imagesDecoded: z.boolean().default(true),
        /** The DOM must be quiet this long before the page counts as ready (FR-12). */
        mutationQuiescenceMs: z.number().int().min(0).max(15000).default(400),
        /** Inject CSS that stops transitions and animations (FR-14). */
        disableAnimations: z.boolean().default(true),
        /**
         * 'freeze' kills motion and captures immediately; 'settle' leaves
         * animation alone and waits for it to stop by itself (FR-14). Settle is
         * slower but correct for pages whose final state depends on an
         * animation finishing (a chart drawing itself, a marquee that parks).
         */
        settleMode: z.enum(['freeze', 'settle']).default('freeze'),
        /** Pause <video>/<audio> elements so a clip cannot change mid-shot (FR-14). */
        pauseMedia: z.boolean().default(true),
        /** Scroll to the bottom and back to fire lazy loading (FR-13). */
        scrollWarmup: z.boolean().default(true),
        /** Auto-dismiss cookie banners / chat widgets / modals (FR-15). */
        dismissOverlays: z.boolean().default(true),
        /** Extra selectors to hide when the built-in library misses (FR-15). */
        dismissSelectors: z.array(z.string().min(1)).max(50).default([]),
        /** Third-party hosts to block at the request level (FR-15). */
        blockHosts: z.array(z.string().min(1)).max(50).default([]),
        /** Block the built-in widget hosts even when they are not listed (FR-15). */
        blockKnownHosts: z.boolean().default(false),
        /** Mask dynamic regions so runs are pixel-stable (FR-16). */
        mask: z.array(z.string().min(1)).max(50).default([]),
        /** 'black' blacks out, 'blur' blurs (FR-16). */
        maskMode: z.enum(['black', 'blur']).default('black'),
        /** Freeze Date/clocks at this ISO time (FR-16). */
        freezeTime: z.string().min(1).optional(),
        /** Seed Math.random deterministically (FR-16). */
        seedRandom: z.boolean().default(false),
        /**
         * Cumulative layout shift budget for one capture (FR-17). Above it the
         * attempt is retried with a slower strategy instead of recording a frame
         * that was still moving. 0 disables the check.
         */
        maxLayoutShift: z.number().min(0).max(10).default(0.25),
        /** Ceiling on waiting for one page to become ready. */
        timeoutMs: z.number().int().min(1000).max(120000).default(20000),
        /** Attempts per job with an escalating wait strategy (FR-17). */
        attempts: z.number().int().min(1).max(3).default(3),
      })
      .strict()
      .default({
        networkIdle: true,
        fontsReady: true,
        imagesDecoded: true,
        mutationQuiescenceMs: 400,
        disableAnimations: true,
        settleMode: 'freeze',
        pauseMedia: true,
        scrollWarmup: true,
        dismissOverlays: true,
        dismissSelectors: [],
        blockHosts: [],
        blockKnownHosts: false,
        mask: [],
        maskMode: 'black',
        seedRandom: false,
        maxLayoutShift: 0.25,
        timeoutMs: 20000,
        attempts: 3,
      }),
    /** Parallel capture contexts (FR-7). min(cores, 4) keeps a laptop usable. */
    concurrency: z
      .number()
      .int()
      .min(1)
      .max(16)
      .default(Math.min(os.cpus().length || 2, 4)),
    /** Scripted flows (FR-21). Empty means plain page captures. */
    flows: z.array(flowSchema).max(10).default([]),
    /** Auth + environment (FR-25, FR-28). Absent means anonymous capture. */
    auth: authSchema.optional(),
    /** White-label gallery branding (FR-31). */
    gallery: gallerySchema.default({ title: 'Capturekit gallery', brand: {} }),
    /** Show a visible cursor + click ripple during flows (FR-21). */
    cursor: z.boolean().default(false),
    /** Export bundle (FR-32). ZIP is opt-in; snippet + summary always written. */
    export: z
      .object({ zip: z.boolean().default(false) })
      .strict()
      .default({ zip: false }),
    /** App boot for `capturekit start` (FR-27). Absent means no managed process. */
    start: startSchema.optional(),
    /** AI layer (M4). Disabled by default; bring your own key. */
    ai: aiSchema.default({
      enabled: false,
      provider: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      timeoutMs: 60000,
      maxImageBytes: 2_000_000,
      maxAltAssets: 20,
    }),
    /** Visual QA pass (FR-42). Deterministic DOM heuristics, no key needed. */
    qa: qaSchema.default({ enabled: false, maxPerRule: 10 }),
    /** Framework route adapters (FR-2). Absent means no adapter source. */
    routes: routesSchema.default({ maxRoutes: 20 }),
    /** Publish targets executed after each run (FR-34). Empty means none. */
    publish: publishSchema,
    /** Plugin modules extending the core (M5). Empty means none. */
    plugins: pluginSchema,
    /** Walkthrough video per capture (FR-19/20/22). On by default. */
    video: videoSchema.default({
      walkthrough: true,
      formats: ['mp4'],
      maxSizeMB: 5,
      durationMs: 5000,
      fps: 15,
    }),
    /** Page discovery (FR-1): sitemap, robots hints, then same-origin crawl. */
    discovery: z
      .object({
        /** 'auto' discovers; 'off' captures only the explicit `pages` list. */
        mode: z.enum(['auto', 'off']).default('auto'),
        /** Crawl depth (FR-1 default 2). */
        depth: z.number().int().min(0).max(5).default(2),
        /** Max pages total (FR-1 default 20). */
        maxPages: z.number().int().min(1).max(200).default(20),
        /** Explicit include globs override discovery (FR-5). */
        include: z.array(z.string().min(1)).max(50).default([]),
        /** Explicit exclude globs override discovery (FR-5). */
        exclude: z.array(z.string().min(1)).max(50).default([]),
      })
      .strict()
      .default({ mode: 'auto', depth: 2, maxPages: 20, include: [], exclude: [] }),
  })
  .strict();

export type InputConfig = z.input<typeof configSchema>;
export type OutputConfig = z.output<typeof configSchema>;

export type ResolvedConfig = {
  target: string;
  /** Base for joining page paths; always the target as a URL. */
  base: URL;
  outDir: string;
  pages: string[];
  /** Per-page / per-viewport capture overrides (FR-11). */
  overrides: CaptureOverride[];
  devices: Device[];
  schemes: ('light' | 'dark')[];
  capture: {
    fullPage: boolean;
    format: 'png' | 'webp' | 'jpeg';
    quality: number;
    frame: 'none' | 'browser' | 'phone' | 'auto';
    /** Screenshot mode (FR-8). Absent means derive it from `fullPage`. */
    mode?: CaptureMode;
    /** Selector for `element` mode (FR-8). */
    selector?: string;
    /** Fold offset for `aboveTheFold` mode (FR-8). */
    foldOffset?: number;
  };
  stabilize: {
    networkIdle: boolean;
    fontsReady: boolean;
    imagesDecoded: boolean;
    mutationQuiescenceMs: number;
    disableAnimations: boolean;
    /** 'freeze' kills motion; 'settle' waits it out (FR-14). */
    settleMode: 'freeze' | 'settle';
    /** Pause <video>/<audio> before capture (FR-14). */
    pauseMedia: boolean;
    scrollWarmup: boolean;
    dismissOverlays: boolean;
    dismissSelectors: string[];
    /** Third-party hosts blocked at the request level (FR-15). */
    blockHosts: string[];
    /** Block the built-in widget hosts too (FR-15). */
    blockKnownHosts: boolean;
    mask: string[];
    maskMode: 'black' | 'blur';
    freezeTime?: string;
    seedRandom: boolean;
    /** CLS budget per capture; 0 disables the check (FR-17). */
    maxLayoutShift: number;
    timeoutMs: number;
    attempts: number;
  };
  concurrency: number;
  flows: Flow[];
  auth?: AuthConfig;
  /**
   * Auth with `$ENV:` refs resolved and the storageState path made absolute.
   * Attached by `run()` so capture can apply cookies without re-resolving
   * secrets per job (FR-25, FR-28).
   */
  authResolved?: ResolvedAuth;
  gallery: GalleryConfig;
  cursor: boolean;
  export: { zip: boolean };
  start?: StartConfig;
  ai: AiConfig;
  qa: QaConfig;
  routes: RoutesConfig;
  publish: PublishTarget[];
  plugins: string[];
  video: VideoConfig;
  discovery: {
    mode: 'auto' | 'off';
    depth: number;
    maxPages: number;
    include: string[];
    exclude: string[];
  };
  /** Where the config came from: a file path, or "defaults and CLI flags". */
  source: string;
};

/** Identity helper so a config file is type-checked by the editor. */
export function defineConfig(config: InputConfig): InputConfig {
  return config;
}

/** Merge a raw config object with defaults and validate. */
export function parseConfig(raw: unknown, source: string): ResolvedConfig {
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new CaptureKitError(
      `Invalid configuration from ${source}:\n${issues}`,
      ExitCode.Config,
      'See docs/CONFIG.md for the full schema.',
    );
  }
  return resolve(parsed.data, source);
}

function resolve(config: OutputConfig, source: string): ResolvedConfig {
  const target = config.target;
  if (!target) {
    throw new CaptureKitError(
      'No target URL.',
      ExitCode.Usage,
      'Pass one on the command line (`capturekit run http://localhost:3000`) or set `target` in capture.config.ts.',
    );
  }

  let base: URL;
  try {
    base = new URL(target);
  } catch {
    throw new CaptureKitError(
      `Target ${JSON.stringify(target)} is not a valid absolute URL.`,
      ExitCode.Config,
      'Include the scheme, e.g. http://localhost:3000.',
    );
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new CaptureKitError(
      `Unsupported protocol ${base.protocol}.`,
      ExitCode.Config,
      'Target must be an http or https URL.',
    );
  }

  const devices = config.viewports.map((viewport): Device => {
    if (typeof viewport === 'string') {
      const device = DEVICES[viewport as DeviceName];
      if (!device) {
        throw new CaptureKitError(
          `Unknown viewport ${JSON.stringify(viewport)}.`,
          ExitCode.Config,
          `Known profiles: ${DEVICE_NAMES.join(', ')}.`,
        );
      }
      return device;
    }
    const builtIn = DEVICES[viewport.name as DeviceName];
    // A custom profile that borrows a built-in name overrides it for this run.
    return {
      name: viewport.name,
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.deviceScaleFactor ?? builtIn?.deviceScaleFactor ?? 1,
      mobile: viewport.mobile ?? builtIn?.mobile ?? viewport.width < 700,
    };
  });

  const repeated = devices.find(
    (device, index) => devices.findIndex((other) => other.name === device.name) !== index,
  );
  if (repeated) {
    throw new CaptureKitError(
      `Duplicate viewport name ${JSON.stringify(repeated.name)}.`,
      ExitCode.Config,
      'Give one of them an explicit `name` so output files cannot collide.',
    );
  }

  if (
    config.stabilize.freezeTime !== undefined &&
    Number.isNaN(Date.parse(config.stabilize.freezeTime))
  ) {
    throw new CaptureKitError(
      `Invalid stabilize.freezeTime ${JSON.stringify(config.stabilize.freezeTime)}.`,
      ExitCode.Config,
      'Use an ISO date, e.g. "2026-01-01T00:00:00Z".',
    );
  }

  const repeatedScheme =
    config.schemes.length !== new Set(config.schemes).size
      ? config.schemes.find((s, i) => config.schemes.indexOf(s) !== i)
      : undefined;
  if (repeatedScheme) {
    throw new CaptureKitError(
      `Duplicate scheme ${JSON.stringify(repeatedScheme)}.`,
      ExitCode.Config,
      'List each of "light", "dark" at most once.',
    );
  }

  return {
    target,
    base,
    outDir: path.isAbsolute(config.outDir)
      ? config.outDir
      : path.resolve(process.cwd(), config.outDir),
    pages: config.pages.map((page) => (page.startsWith('/') ? page : `/${page}`)),
    overrides: config.overrides as ResolvedConfig['overrides'],
    devices,
    schemes: config.schemes,
    capture: config.capture,
    stabilize: config.stabilize,
    concurrency: config.concurrency,
    flows: config.flows,
    ...(config.auth ? { auth: config.auth } : {}),
    gallery: config.gallery,
    cursor: config.cursor,
    export: config.export,
    ...(config.start ? { start: config.start } : {}),
    ai: config.ai,
    qa: config.qa,
    routes: config.routes,
    publish: config.publish,
    plugins: config.plugins,
    video: config.video,
    discovery: config.discovery,
    source,
  };
}

/**
 * Effective config from config file + CLI flags. Flags win, because a one-off
 * run should never require editing a file.
 */
export async function buildConfig(options: {
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
  startCommand?: string;
  waitOn?: string;
  ai?: boolean;
  aiKey?: string;
  discover?: boolean;
  videoWalkthrough?: boolean;
  cwd?: string;
}): Promise<ResolvedConfig> {
  const cwd = options.cwd ?? process.cwd();
  let raw: Record<string, unknown> = {};
  let source = 'defaults and CLI flags';

  if (!options.noConfig) {
    if (options.config) {
      const file = path.resolve(cwd, options.config);
      try {
        await readFile(file, 'utf8');
      } catch {
        throw new CaptureKitError(`Config file ${options.config} not found.`, ExitCode.Config);
      }
      raw = await loadConfigFile(file);
      source = file;
    } else {
      const found = await findConfigFile(cwd);
      if (found) {
        raw = await loadConfigFile(found);
        source = found;
      }
    }
  }

  const overrides: Record<string, unknown> = {};
  // A positional URL overrides only `target`; everything else in the file still applies.
  if (options.url) overrides.target = options.url;
  if (options.viewport?.length) overrides.viewports = options.viewport;
  // An explicit `--pages` list is a complete answer, not a seed: requesting
  // "/,/pricing" and then getting six crawled pages would capture things the
  // user just said they did not want. Use `discovery.include` to narrow
  // discovery, or omit `--pages` to let it run.
  let pagesWereNamed = false;
  if (options.pages) {
    const listed = options.pages
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (listed.length > 0) {
      pagesWereNamed = true;
      overrides.pages = listed;
    }
  }
  if (options.outDir) overrides.outDir = options.outDir;
  if (options.concurrency) overrides.concurrency = options.concurrency;
  if (options.timeoutMs)
    overrides.stabilize = {
      ...((raw.stabilize as Record<string, unknown>) ?? {}),
      timeoutMs: options.timeoutMs,
    };
  if (options.fullPage === false)
    overrides.capture = { ...((raw.capture as Record<string, unknown>) ?? {}), fullPage: false };
  if (options.scheme?.length) overrides.schemes = options.scheme;
  if (options.format)
    overrides.capture = {
      ...((raw.capture as Record<string, unknown>) ?? {}),
      ...((overrides.capture as Record<string, unknown>) ?? {}),
      format: options.format,
    };
  if (options.frame)
    overrides.capture = {
      ...((raw.capture as Record<string, unknown>) ?? {}),
      ...((overrides.capture as Record<string, unknown>) ?? {}),
      frame: options.frame,
    };
  if (options.startCommand || options.waitOn)
    overrides.start = {
      ...((raw.start as Record<string, unknown>) ?? {}),
      ...(options.startCommand ? { command: options.startCommand } : {}),
      ...(options.waitOn ? { waitOn: options.waitOn } : {}),
    };
  if (options.ai === true || options.aiKey)
    overrides.ai = {
      ...((raw.ai as Record<string, unknown>) ?? {}),
      ...(options.ai === true ? { enabled: true } : {}),
      ...(options.aiKey ? { apiKey: options.aiKey } : {}),
    };
  if (options.discover === false || pagesWereNamed)
    overrides.discovery = { ...((raw.discovery as Record<string, unknown>) ?? {}), mode: 'off' };
  if (options.videoWalkthrough === false)
    overrides.video = { ...((raw.video as Record<string, unknown>) ?? {}), walkthrough: false };

  return parseConfig({ ...raw, ...overrides }, source);
}

const CONFIG_FILENAMES = ['capture.config.ts', 'capture.config.mjs', 'capture.config.js'];

/**
 * Find `capture.config.*` walking up from `start`, so a capture can be kicked
 * off from anywhere inside a project.
 */
export async function findConfigFile(start: string): Promise<string | null> {
  let dir = path.resolve(start);
  for (let depth = 0; depth < 8; depth++) {
    for (const name of CONFIG_FILENAMES) {
      const candidate = path.join(dir, name);
      try {
        await readFile(candidate, 'utf8');
        return candidate;
      } catch {
        /* not here; keep walking up */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Import a config file. Node type-strips `.ts`, so there is no build step and
 * no transpile dependency. Plain object exports are accepted as well, so a file
 * that never imports `defineConfig` still works.
 */
export async function loadConfigFile(file: string): Promise<Record<string, unknown>> {
  let module: unknown;
  try {
    module = await import(pathToFileURL(file).href);
  } catch (err) {
    throw new CaptureKitError(
      `Could not load config file ${file}: ${(err as Error).message}`,
      ExitCode.Config,
      'A config file must default-export an object. Fix the file, or bypass it with --no-config.',
    );
  }
  const exported = (module as { default?: unknown }).default;
  if (typeof exported !== 'object' || exported === null) {
    throw new CaptureKitError(
      `${file} has no usable default export.`,
      ExitCode.Config,
      'Write `export default defineConfig({ ... })`.',
    );
  }
  return exported as Record<string, unknown>;
}
