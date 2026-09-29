import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { CaptureKitError, ExitCode } from '../exit.ts';

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

  // Page discovery (FR-1). Auto mode finds pages via sitemap.xml, robots
  // hints, then same-origin crawl (depth 2, max 20 pages); explicit \`pages\`
  // above are always included. Set mode: "off" for a fixed list.
  discovery: { mode: "auto", depth: 2, maxPages: 20, exclude: ["/admin/**"] },

  // Named profiles: mobile, tablet, laptop, desktop
  // ...or objects: { name: "wide", width: 2560, height: 1440, deviceScaleFactor: 1 }
  viewports: ["mobile", "tablet", "desktop"],

  // Color schemes (FR-10). Add "dark" for dark-mode captures.
  schemes: ["light"],

  capture: {
    fullPage: true,
    format: "png", // "png" | "webp" | "jpeg"
    quality: 80, // jpeg/webp only
    frame: "none", // "none" | "browser" | "phone" | "auto" (gallery-level mockup)
  },

  stabilize: {
    networkIdle: true,
    fontsReady: true,
    imagesDecoded: true,
    mutationQuiescenceMs: 400,
    disableAnimations: true,
    scrollWarmup: true,
    dismissOverlays: true, // auto-dismiss cookie banners / chat widgets (FR-15)
    dismissSelectors: [], // extra selectors to hide, e.g. [".promo-popup"]
    mask: [], // selectors to black out for determinism, e.g. [".timestamp"]
    maskMode: "black", // "black" | "blur"
    // freezeTime: "2026-01-01T00:00:00Z", // freeze Date/clocks (FR-16)
    seedRandom: false,
    timeoutMs: 20000,
    attempts: 3,
  },

  // Scripted flows (FR-21). Each flow re-captures every page x viewport.
  // flows: [{ name: "Checkout", steps: [{ goto: "/products" }, { click: "text=Add to cart" }] }],

  // Auth + environment (FR-25, FR-28). Secrets use $ENV:NAME, never committed.
  // auth: { storageState: ".auth/state.json", headers: { Authorization: "$ENV:TOKEN" } },

  // White-label gallery branding (FR-31).
  gallery: { title: "Acme Redesign", brand: { accent: "#0F62FE" } },

  // Walkthrough video per capture (FR-19/20/22). One clip per viewport,
  // trimmed of dead time and compressed under maxSizeMB.
  video: { walkthrough: true, formats: ["mp4"], maxSizeMB: 5, durationMs: 5000 },

  // Export bundle (FR-32). ZIP is opt-in; snippet.md + summary.html always written.
  export: { zip: false },

  // Managed app for \`capturekit start\` (FR-27). Boots the command, waits for
  // the health URL, captures \`target\`, then tears the app down. CI-trivial.
  // start: { command: "npm run dev", waitOn: "http://localhost:3000/health" },

  // AI layer (M4, FR-40..43). Off by default; bring your own key. Emits
  // reviewable files (alt.json, client-summary.md) and never fails a run.
  // ai: { enabled: true, apiKey: "$ENV:OPENAI_API_KEY", model: "gpt-4o-mini" },

  // Visual QA pass (FR-42). Deterministic DOM heuristics, no key needed.
  // qa: { enabled: true },

  // Framework route adapters (FR-2). Reads routes from the project instead
  // of crawling when a path is supplied.
  // routes: { projectPath: "./my-app" },

  // Publish targets executed after each run (FR-34).
  // publish: [{ type: "folder", dest: "./public/captures" }],

  // Plugins extending the core (M5). Modules exporting hook functions.
  // plugins: ["./capturekit.plugin.mjs"],

  // Parallel capture contexts. Default is min(cores, 4).
  concurrency: 4,
}
`;

export async function initCommand(cwd: string, force = false): Promise<string> {
  const file = path.join(cwd, 'capture.config.ts');
  if (!force) {
    try {
      // `wx` fails if the file exists, which also covers the race of two devs
      // running init at once, without a separate existence check.
      await writeFile(file, TEMPLATE, { flag: 'wx', encoding: 'utf8' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new CaptureKitError(
          `${file} already exists.`,
          ExitCode.Usage,
          'Edit it, or re-run with --force to overwrite.',
        );
      }
      throw err;
    }
    return file;
  }
  await writeFile(file, TEMPLATE, 'utf8');
  return file;
}

export const CONFIG_TEMPLATE = TEMPLATE;
