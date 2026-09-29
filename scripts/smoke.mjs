import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

/**
 * M0 acceptance test (PRD section 15, criteria 1, 2, 5 and 8).
 *
 * Boots the fixture site, runs the real CLI as a child process, and asserts the
 * output tree matches the spec. No test runner: `npm run smoke` is the whole
 * interface, so CI can call it before vitest exists (PRD section 16).
 */
const PORT = Number(process.env.PORT ?? 4111);
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(process.cwd(), 'captures-smoke');

const failures = [];
function check(label, condition, detail = '') {
  process.stdout.write(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}\n`);
  if (!condition) failures.push(label);
}

const server = spawn(process.execPath, ['scripts/serve-fixtures.mjs'], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
server.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));

async function waitReady(tries = 30) {
  for (let index = 0; index < tries; index++) {
    try {
      if ((await fetch(`${BASE}/`)).ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

/** Runs the CLI the way a user or CI would: as a subprocess, checking its exit code. */
function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['bin/capturekit.mjs', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

/** Newest run folder by name; names are UTC timestamps, so lexical sort is chronological. */
function newestRun(root) {
  if (!existsSync(root)) return null;
  const runs = readdirSync(root)
    .filter((entry) => /^\d{4}-\d{2}-\d{2}T/.test(entry))
    .sort();
  const last = runs.at(-1);
  return last === undefined ? null : { name: last, dir: path.join(root, last) };
}

const checksToRun = async () => {
  // Criterion 1: no config file, one command, working output.
  const result = await runCli([
    'run',
    BASE,
    '--pages',
    '/,/pricing',
    '--out',
    ROOT,
    '--json',
    '--quiet',
  ]);

  check('exit code 0', result.code === 0, `got ${result.code}`);
  let summary = {};
  try {
    summary = JSON.parse(result.stdout);
    check('stdout is pure JSON (FR-39)', true);
  } catch {
    check('stdout is pure JSON (FR-39)', false, result.stdout.slice(0, 80).replace(/\n/g, ' '));
  }

  check(
    'planned 6 jobs (2 pages x 3 viewports)',
    summary.summary?.planned === 6,
    JSON.stringify(summary.summary),
  );
  check(
    'all 6 shots + 6 walkthrough videos succeeded',
    summary.summary?.succeeded === 12,
    `succeeded=${summary.summary?.succeeded}`,
  );
  check('no failures recorded', summary.summary?.failed === 0, `failed=${summary.summary?.failed}`);

  // FR-29: the deterministic output tree.
  const run = newestRun(ROOT);
  check('one run directory created', run !== null, run?.name ?? 'none');

  if (run !== null) {
    const manifestFile = path.join(run.dir, 'manifest.json');
    check('manifest.json exists', existsSync(manifestFile));

    if (existsSync(manifestFile)) {
      const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
      check('manifest schemaVersion is 1', manifest.schemaVersion === 1);
      check(
        'manifest records the chromium build',
        typeof manifest.tool?.chromium === 'string',
        manifest.tool?.chromium,
      );
      check(
        'manifest lists 6 shots + 6 videos',
        manifest.assets?.length === 12,
        `got ${manifest.assets?.length}`,
      );
      const shots = (manifest.assets ?? []).filter((asset) => asset.type === 'screenshot');
      const videos = (manifest.assets ?? []).filter((asset) => asset.type === 'video');
      check('6 screenshots recorded', shots.length === 6, `got ${shots.length}`);
      check('6 walkthrough videos recorded (FR-19/20)', videos.length === 6, `got ${videos.length}`);
      check(
        'shot paths match screenshots/<page>/<viewport>.png',
        shots.every((asset) =>
          /^screenshots\/[a-z0-9-]+\/(mobile|tablet|desktop)\.png$/.test(asset.path),
        ),
        shots[0]?.path,
      );
      check(
        'video paths match videos/<page>/<viewport>.mp4',
        videos.every(
          (asset) =>
            /^videos\/[a-z0-9-]+\/(mobile|tablet|desktop)\.mp4$/.test(asset.path) &&
            asset.kind === 'walkthrough',
        ),
        videos[0]?.path,
      );
      check(
        'every video is under the 5MB budget (FR-22)',
        videos.every((asset) => asset.bytes > 0 && asset.bytes < 5 * 1024 * 1024),
        videos.map((asset) => asset.bytes).join(','),
      );
      check(
        'full-page capture is taller than the viewport (FR-8/FR-13)',
        (manifest.assets ?? []).some((asset) => asset.contentHeight > asset.height),
        `sample contentHeight=${manifest.assets?.[0]?.contentHeight}`,
      );
      check('run.log.json written', existsSync(path.join(run.dir, 'logs', 'run.log.json')));
      check(
        'traces/ empty for a clean run',
        readdirSync(path.join(run.dir, 'logs', 'traces')).length === 0,
      );
    }

    for (const page of ['home', 'pricing']) {
      for (const viewport of ['mobile', 'tablet', 'desktop']) {
        const png = path.join(run.dir, 'screenshots', page, `${viewport}.png`);
        const bytes = existsSync(png) ? readFileSync(png).length : 0;
        // Substantial frames prove the capture is real and that FR-18 did not
        // reject a legitimate page as blank.
        check(`${page}/${viewport}.png is a real frame`, bytes > 10_000, `${bytes} bytes`);
        const mp4 = path.join(run.dir, 'videos', page, `${viewport}.mp4`);
        const clipBytes = existsSync(mp4) ? readFileSync(mp4).length : 0;
        check(
          `${page}/${viewport}.mp4 walkthrough finalized (FR-24)`,
          clipBytes > 1_000 && clipBytes < 5 * 1024 * 1024,
          `${clipBytes} bytes`,
        );
      }
    }

    // FR-30: the self-contained gallery with screenshots, videos, lightbox.
    const gallery = path.join(run.dir, 'index.html');
    check('index.html gallery written', existsSync(gallery));
    if (existsSync(gallery)) {
      const html = readFileSync(gallery, 'utf8');
      check('gallery embeds the manifest', html.includes('id="ck-manifest"'));
      check('gallery plays walkthrough videos', html.includes('<video'));
      check('gallery has viewport tabs', html.includes('mobile') && html.includes('desktop'));
    }
  }

  return run;
};

const main = async () => {
  if (!(await waitReady())) {
    check('fixture server ready', false, `nothing listening on ${BASE}`);
    return;
  }
  check('fixture server ready', true, BASE);

  await checksToRun();

  // FR-33 portable variant.
  const pointer = path.join(ROOT, '.latest');
  check('.latest pointer written', existsSync(pointer));

  // FR-1: discovery finds the fixture pages with no config.
  const discovered = await runCli(['discover', BASE, '--json']);
  let discoveredPages = [];
  try {
    discoveredPages = JSON.parse(discovered.stdout).pages ?? [];
  } catch {
    /* reported below */
  }
  check(
    'discover finds / and /pricing',
    discoveredPages.includes('/') && discoveredPages.includes('/pricing'),
    JSON.stringify(discoveredPages),
  );

  // Criterion 5 / Principle 2: one broken page must not sink the run. Page paths
  // resolve against the origin, so the bad path goes in `--pages`, not in the URL.
  const mixed = await runCli([
    'run',
    BASE,
    '--pages',
    '/,/does-not-exist',
    '--viewport',
    'mobile',
    '--out',
    ROOT,
    '--json',
    '--quiet',
  ]);
  let mixedSummary = {};
  try {
    mixedSummary = JSON.parse(mixed.stdout);
  } catch {
    /* the checks below report it */
  }
  check(
    'mixed run: 2 planned',
    mixedSummary.summary?.planned === 2,
    JSON.stringify(mixedSummary.summary),
  );
  check(
    'mixed run: good page shot + walkthrough captured',
    mixedSummary.summary?.succeeded === 2,
    `succeeded=${mixedSummary.summary?.succeeded}`,
  );
  check(
    'mixed run: broken page recorded as failed',
    mixedSummary.summary?.failed === 1,
    `failed=${mixedSummary.summary?.failed}`,
  );
  check(
    'failure carries a reason',
    typeof mixedSummary.failures?.[0]?.reason === 'string',
    mixedSummary.failures?.[0]?.reason,
  );
  // Criterion 8: 1 of 2 failed is exactly the 0.5 threshold, not above it.
  check('exit 0 at the default failure threshold', mixed.code === 0, `code ${mixed.code}`);

  const mixedRun = newestRun(ROOT);
  if (mixedRun !== null) {
    const traces = readdirSync(path.join(mixedRun.dir, 'logs', 'traces'));
    check('trace retained for the failed job (FR-17)', traces.length > 0, traces.join(','));
    check('asset list excludes the failed job', (mixedSummary.assets ?? []).length === 2);
    check(
      'no asset references the failed page',
      (mixedSummary.assets ?? []).every((asset) => asset.page !== '/does-not-exist'),
    );
  }
  check('.latest names the newest run', readFileSync(pointer, 'utf8').trim() === mixedRun?.name);

  // Criterion 8: tightening the threshold must flip the exit code, so CI can
  // choose how strict it wants to be.
  const strict = await runCli([
    'run',
    BASE,
    '--pages',
    '/,/does-not-exist',
    '--viewport',
    'mobile',
    '--out',
    ROOT,
    '--json',
    '--quiet',
    '--max-fail-rate',
    '0',
  ]);
  check('exit 1 above a zero tolerance threshold', strict.code === 1, `code ${strict.code}`);

  // FR-18, the other direction: a page with real DOM content but nothing
  // visible must still be rejected as a blank frame.
  const blank = await runCli([
    'run',
    BASE,
    '--pages',
    '/blank',
    '--viewport',
    'desktop',
    '--out',
    ROOT,
    '--json',
    '--quiet',
  ]);
  let blankSummary = {};
  try {
    blankSummary = JSON.parse(blank.stdout);
  } catch {
    /* reported below */
  }
  check(
    'white-on-white page rejected as blank frame',
    blankSummary.summary?.failed === 1 &&
      /blank frame/.test(blankSummary.failures?.[0]?.reason ?? ''),
    blankSummary.failures?.[0]?.reason,
  );

  // FR-39: config problems are exit 3 with a hint, never a stack trace.
  const badUrl = await runCli(['run', 'not-a-url', '--out', ROOT]);
  check('invalid URL exits 3', badUrl.code === 3, `code ${badUrl.code}`);
  check(
    'invalid URL prints a hint',
    badUrl.stderr.includes('hint:'),
    badUrl.stderr.trim().split('\n').slice(0, 2).join(' | '),
  );

  const noTarget = await runCli(['run', '--no-config', '--out', ROOT]);
  check('missing target exits 2', noTarget.code === 2, `code ${noTarget.code}`);
};

main().finally(() => {
  server.kill('SIGKILL');
  process.stdout.write(
    `\n${failures.length === 0 ? 'all checks passed' : `${failures.length} check(s) failed: ${failures.join(', ')}`}\n`,
  );
  process.exit(failures.length === 0 ? 0 : 1);
});
