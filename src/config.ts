import { readFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import process from "node:process"
import { pathToFileURL } from "node:url"
import { z } from "zod"

import { DEVICES, DEVICE_NAMES, type Device } from "./devices.ts"
import { CaptureKitError, ExitCode } from "./exit.ts"

/**
 * Config loader with Zod validation (PRD section 8).
 *
 * G1 Autonomy means the schema must be fully defaultable: every field has a
 * value that works on a first run, so `capturekit run <url>` needs no file at
 * all. Config exists only to refine, never to enable (Principle 1).
 */

const viewportDeviceSchema = z.enum(DEVICE_NAMES as [string, ...string[]])

const viewportCustomSchema = z
  .object({
    name: z.string().min(1).max(40),
    width: z.number().int().min(200).max(10000),
    height: z.number().int().min(200).max(10000),
    deviceScaleFactor: z.number().min(1).max(4).optional(),
    mobile: z.boolean().optional(),
  })
  .strict()

const viewportSchema = z.union([viewportDeviceSchema, viewportCustomSchema])

export const configSchema = z
  .object({
    /** The site to capture: localhost, a preview deploy, or production. */
    target: z.string().min(1).optional(),
    /** Root folder for run output. Relative paths resolve from the working dir. */
    outDir: z.string().min(1).default("captures"),
    /** Paths to capture. M0 takes an explicit list; discovery fills this in later. */
    pages: z.array(z.string()).default(["/"]),
    viewports: z.array(viewportSchema).min(1).default(["mobile", "tablet", "desktop"]),
    capture: z
      .object({
        fullPage: z.boolean().default(true),
        /** M0 ships PNG only; webp/jpeg arrive with the sharp post-processor. */
        format: z.enum(["png"]).default("png"),
      })
      .strict()
      // Zod 4 needs a complete default object; inner fields keep their own
      // defaults so a partial config still validates.
      .default({ fullPage: true, format: "png" }),
    stabilize: z
      .object({
        networkIdle: z.boolean().default(true),
        fontsReady: z.boolean().default(true),
        imagesDecoded: z.boolean().default(true),
        /** The DOM must be quiet this long before the page counts as ready (FR-12). */
        mutationQuiescenceMs: z.number().int().min(0).max(15000).default(400),
        /** Inject CSS that stops transitions and animations (FR-14). */
        disableAnimations: z.boolean().default(true),
        /** Scroll to the bottom and back to fire lazy loading (FR-13). */
        scrollWarmup: z.boolean().default(true),
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
        scrollWarmup: true,
        timeoutMs: 20000,
        attempts: 3,
      }),
    /** Parallel capture contexts (FR-7). min(cores, 4) keeps a laptop usable. */
    concurrency: z.number().int().min(1).max(16).default(Math.min(os.cpus().length || 2, 4)),
  })
  .strict()

export type InputConfig = z.infer<typeof configSchema>

export type ResolvedConfig = {
  target: string
  /** Base for joining page paths; always the target as a URL. */
  base: URL
  outDir: string
  pages: string[]
  devices: Device[]
  capture: { fullPage: boolean; format: "png" }
  stabilize: {
    networkIdle: boolean
    fontsReady: boolean
    imagesDecoded: boolean
    mutationQuiescenceMs: number
    disableAnimations: boolean
    scrollWarmup: boolean
    timeoutMs: number
    attempts: number
  }
  concurrency: number
  /** Where the config came from: a file path, or "defaults and CLI flags". */
  source: string
}

/** Identity helper so a config file is type-checked by the editor. */
export function defineConfig(config: InputConfig): InputConfig {
  return config
}

/** Merge a raw config object with defaults and validate. */
export function parseConfig(raw: unknown, source: string): ResolvedConfig {
  const parsed = configSchema.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n")
    throw new CaptureKitError(
      `Invalid configuration from ${source}:\n${issues}`,
      ExitCode.Config,
      "See docs/CONFIG.md for the full schema.",
    )
  }
  return resolve(parsed.data, source)
}

function resolve(config: InputConfig, source: string): ResolvedConfig {
  const target = config.target
  if (!target) {
    throw new CaptureKitError(
      "No target URL.",
      ExitCode.Usage,
      "Pass one on the command line (`capturekit run http://localhost:3000`) or set `target` in capture.config.ts.",
    )
  }

  let base: URL
  try {
    base = new URL(target)
  } catch {
    throw new CaptureKitError(
      `Target ${JSON.stringify(target)} is not a valid absolute URL.`,
      ExitCode.Config,
      "Include the scheme, e.g. http://localhost:3000.",
    )
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new CaptureKitError(
      `Unsupported protocol ${base.protocol}.`,
      ExitCode.Config,
      "Target must be an http or https URL.",
    )
  }

  const devices = config.viewports.map((viewport): Device => {
    if (typeof viewport === "string") {
      const device = DEVICES[viewport]
      if (!device) {
        throw new CaptureKitError(
          `Unknown viewport ${JSON.stringify(viewport)}.`,
          ExitCode.Config,
          `Known profiles: ${DEVICE_NAMES.join(", ")}.`,
        )
      }
      return device
    }
    const builtIn = DEVICES[viewport.name]
    // A custom profile that borrows a built-in name overrides it for this run.
    return {
      name: viewport.name,
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.deviceScaleFactor ?? builtIn?.deviceScaleFactor ?? 1,
      mobile: viewport.mobile ?? builtIn?.mobile ?? viewport.width < 700,
    }
  })

  const repeated = devices.find((device, index) => devices.findIndex((other) => other.name === device.name) !== index)
  if (repeated) {
    throw new CaptureKitError(
      `Duplicate viewport name ${JSON.stringify(repeated.name)}.`,
      ExitCode.Config,
      "Give one of them an explicit `name` so output files cannot collide.",
    )
  }

  return {
    target,
    base,
    outDir: path.isAbsolute(config.outDir) ? config.outDir : path.resolve(process.cwd(), config.outDir),
    pages: config.pages.map((page) => (page.startsWith("/") ? page : `/${page}`)),
    devices,
    capture: config.capture,
    stabilize: config.stabilize,
    concurrency: config.concurrency,
    source,
  }
}

/**
 * Effective config from config file + CLI flags. Flags win, because a one-off
 * run should never require editing a file.
 */
export async function buildConfig(options: {
  url?: string
  config?: string
  noConfig?: boolean
  viewport?: string[]
  pages?: string
  outDir?: string
  fullPage?: boolean
  concurrency?: number
  timeoutMs?: number
  cwd?: string
}): Promise<ResolvedConfig> {
  const cwd = options.cwd ?? process.cwd()
  let raw: Record<string, unknown> = {}
  let source = "defaults and CLI flags"

  if (!options.noConfig) {
    if (options.config) {
      const file = path.resolve(cwd, options.config)
      try {
        await readFile(file, "utf8")
      } catch {
        throw new CaptureKitError(`Config file ${options.config} not found.`, ExitCode.Config)
      }
      raw = await loadConfigFile(file)
      source = file
    } else {
      const found = await findConfigFile(cwd)
      if (found) {
        raw = await loadConfigFile(found)
        source = found
      }
    }
  }

  const overrides: Record<string, unknown> = {}
  // A positional URL overrides only `target`; everything else in the file still applies.
  if (options.url) overrides.target = options.url
  if (options.viewport?.length) overrides.viewports = options.viewport
  if (options.pages) {
    overrides.pages = options.pages
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
  }
  if (options.outDir) overrides.outDir = options.outDir
  if (options.concurrency) overrides.concurrency = options.concurrency
  if (options.timeoutMs) overrides.stabilize = { ...(raw.stabilize ?? {}), timeoutMs: options.timeoutMs }
  if (options.fullPage === false) overrides.capture = { ...(raw.capture ?? {}), fullPage: false }

  return parseConfig({ ...raw, ...overrides }, source)
}

const CONFIG_FILENAMES = ["capture.config.ts", "capture.config.mjs", "capture.config.js"]

/**
 * Find `capture.config.*` walking up from `start`, so a capture can be kicked
 * off from anywhere inside a project.
 */
export async function findConfigFile(start: string): Promise<string | null> {
  let dir = path.resolve(start)
  for (let depth = 0; depth < 8; depth++) {
    for (const name of CONFIG_FILENAMES) {
      const candidate = path.join(dir, name)
      try {
        await readFile(candidate, "utf8")
        return candidate
      } catch {
        /* not here; keep walking up */
      }
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * Import a config file. Node type-strips `.ts`, so there is no build step and
 * no transpile dependency. Plain object exports are accepted as well, so a file
 * that never imports `defineConfig` still works.
 */
export async function loadConfigFile(file: string): Promise<Record<string, unknown>> {
  let module: unknown
  try {
    module = await import(pathToFileURL(file).href)
  } catch (err) {
    throw new CaptureKitError(
      `Could not load config file ${file}: ${(err as Error).message}`,
      ExitCode.Config,
      "A config file must default-export an object. Fix the file, or bypass it with --no-config.",
    )
  }
  const exported = (module as { default?: unknown }).default
  if (typeof exported !== "object" || exported === null) {
    throw new CaptureKitError(
      `${file} has no usable default export.`,
      ExitCode.Config,
      "Write `export default defineConfig({ ... })`.",
    )
  }
  return exported as Record<string, unknown>
}
