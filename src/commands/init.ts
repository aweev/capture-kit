import { writeFile } from "node:fs/promises"
import path from "node:path"

import { CaptureKitError, ExitCode } from "../exit.ts"

/**
 * `capturekit init` (FR-35).
 *
 * init is optional, not a gate — a first run needs no config at all. What this
 * writes is a starting point that documents every knob with its default, so the
 * file is readable without opening the docs (Principle 1).
 */
/**
 * Template is dependency-free on purpose: a plain default export is accepted by
 * the loader, so `init` works before capturekit is installed as a package in
 * this project (e.g. when run via `npx capturekit init`). `defineConfig` is
 * available to add later for editor type-checking.
 */
const TEMPLATE = `// capturekit configuration. Every field is optional; these are the defaults.
export default {
  // The site to capture. Setting it here means \`capturekit run\` needs no argument.
  target: "http://localhost:3000",

  // Where runs land. Each run is its own timestamped folder with a manifest;
  // \`.latest\` records the newest one.
  outDir: "captures",

  // M0 captures an explicit list. Discovery (sitemap + crawl) replaces this
  // with automatic page finding in M1.
  pages: ["/"],

  // Named profiles: mobile, tablet, laptop, desktop
  // ...or objects: { name: "wide", width: 2560, height: 1440, deviceScaleFactor: 1 }
  viewports: ["mobile", "tablet", "desktop"],

  capture: {
    fullPage: true,
    format: "png",
  },

  stabilize: {
    networkIdle: true,
    fontsReady: true,
    imagesDecoded: true,
    mutationQuiescenceMs: 400,
    disableAnimations: true,
    scrollWarmup: true,
    timeoutMs: 20000,
    attempts: 3,
  },

  // Parallel capture contexts. Default is min(cores, 4).
  concurrency: 4,
}
`

export async function initCommand(cwd: string, force = false): Promise<string> {
  const file = path.join(cwd, "capture.config.ts")
  if (!force) {
    try {
      // `wx` fails if the file exists, which also covers the race of two devs
      // running init at once, without a separate existence check.
      await writeFile(file, TEMPLATE, { flag: "wx", encoding: "utf8" })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        throw new CaptureKitError(
          `${file} already exists.`,
          ExitCode.Usage,
          "Edit it, or re-run with --force to overwrite.",
        )
      }
      throw err
    }
    return file
  }
  await writeFile(file, TEMPLATE, "utf8")
  return file
}

export const CONFIG_TEMPLATE = TEMPLATE
