import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

import { chromium } from 'playwright';

import { DEVICES } from '../devices.ts';
import { VERSION } from '../run.ts';

/**
 * `capturekit doctor` (FR-35, and §7 Install: "browsers auto-provisioned by
 * doctor").
 *
 * Every check is a verdict plus one action. The command exists so a cold
 * checkout on a strange machine produces instructions instead of a stack trace,
 * and it is what CI calls before a capture to fail fast and legibly.
 */
export type Check = {
  name: string;
  ok: boolean;
  detail: string;
  /** Printed only when `ok` is false. */
  fix?: string;
};

export type DoctorReport = { checks: Check[]; ok: boolean; provisioned: boolean };

const MIN_NODE = 22;

export async function doctorCommand(options: { install?: boolean } = {}): Promise<DoctorReport> {
  const checks: Check[] = [];

  checks.push({ name: 'capturekit', ok: true, detail: `v${VERSION}` });

  const [major] = process.versions.node.split('.').map(Number);
  checks.push({
    name: 'node',
    ok: (major ?? 0) >= MIN_NODE,
    detail: `v${process.versions.node} (needs ${MIN_NODE}+)`,
    fix: 'Install Node 22 or newer: nvm install 22',
  });

  // Node reports the TypeScript mode as a truthy string when stripping is built
  // in, and `false` when the flag is required. Types say `false | "strip"`,
  // future modes included, so this test is deliberately not a literal compare.
  const nativeTs: string | boolean = process.features.typescript;
  checks.push({
    name: 'typescript',
    ok: true,
    detail:
      typeof nativeTs === 'string'
        ? `type stripping built in (${nativeTs})`
        : 'type stripping runs via --experimental-strip-types (the bin shim passes it)',
  });

  // FR-7 needs a viewport per context, so the browser is the one hard dependency.
  let executable = '';
  try {
    executable = chromium.executablePath();
  } catch (err) {
    checks.push({
      name: 'chromium',
      ok: false,
      detail: (err as Error).message.split('\n')[0] ?? 'not installed',
      fix: options.install
        ? 'installing now...'
        : 'run: capturekit doctor --install  (or: npx playwright install chromium)',
    });
  }

  if (executable !== '') {
    checks.push({ name: 'chromium', ok: true, detail: executable });
    const launch = await tryLaunch();
    checks.push(launch);
  }

  if (options.install === true) {
    const missing = checks.find((check) => check.name === 'chromium' && !check.ok);
    if (missing !== undefined) {
      const installed = await installBrowser();
      checks.push(installed);
    }
  }

  checks.push({
    name: 'viewports',
    ok: true,
    detail:
      `${Object.keys(DEVICES).length} profiles: ` +
      Object.values(DEVICES)
        .map(
          (device) =>
            `${device.name} ${device.width}x${device.height}@${device.deviceScaleFactor}x`,
        )
        .join(', '),
  });

  // Video post-processing needs ffmpeg; without it walkthroughs ship as raw
  // WebM instead of MP4. Warning, not failure: capture still works.
  checks.push(await ffmpegCheck());

  const ok = checks.every((check) => check.ok || check.name === 'ffmpeg');
  return { checks, ok, provisioned: options.install === true };
}

/** Resolve the ffmpeg binary the video post-processor would use (FR-22). */
async function ffmpegCheck(): Promise<Check> {
  try {
    const { findFfmpeg } = await import('../video.ts');
    const binary = await findFfmpeg();
    if (binary) return { name: 'ffmpeg', ok: true, detail: binary };
  } catch {
    /* fall through to the missing report */
  }
  return {
    name: 'ffmpeg',
    ok: true,
    detail: 'not found — walkthroughs will ship as WebM (npm i ffmpeg-static or install ffmpeg)',
  };
}

async function tryLaunch(): Promise<Check> {
  const started = Date.now();
  try {
    const browser = await chromium.launch({ headless: true });
    const version = browser.version();
    // Prove a context can actually be created, not just that the binary runs.
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    await page.setContent('<h1>capturekit ok</h1>');
    const shot = await page.screenshot({ type: 'png' });
    await context.close();
    await browser.close();
    return {
      name: 'launch',
      ok: shot.length > 100,
      detail: `Chromium ${version}, context + screenshot in ${Date.now() - started}ms`,
      ...(shot.length > 100
        ? {}
        : { fix: 'screenshot came back empty; something is wrong with the headless shell' }),
    };
  } catch (err) {
    return {
      name: 'launch',
      ok: false,
      detail: (err as Error).message.split('\n')[0] ?? 'launch failed',
      fix: 'run: capturekit doctor --install',
    };
  }
}

/** Streams the download to the terminal so a slow CI log still shows progress. */
function installBrowser(): Promise<Check> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [playwrightCliPath(), 'install', 'chromium'], {
      stdio: 'inherit',
    });
    child.on('error', (err) => {
      resolve({
        name: 'provision',
        ok: false,
        detail: err.message,
        fix: 'npx playwright install chromium',
      });
    });
    child.on('exit', (code) => {
      resolve({
        name: 'provision',
        ok: code === 0,
        detail: code === 0 ? 'chromium installed' : `installer exited with code ${code ?? 'null'}`,
        ...(code === 0 ? {} : { fix: 'npx playwright install chromium' }),
      });
    });
  });
}

/**
 * Playwright's CLI entry point.
 *
 * Resolved through `createRequire` rather than a hard-coded relative path, so it
 * keeps working when npm/pnpm hoists the package to a different depth, and
 * because `URL.pathname` returns a broken drive-letter path on Windows.
 */
function playwrightCliPath(): string {
  const require = createRequire(import.meta.url);
  const main = require.resolve('playwright');
  return path.join(path.dirname(main), 'cli.js');
}
