# capturekit

Autonomous visual capture for shipped software. Point it at any running web
project and it produces a complete, current visual asset pack: multi-viewport
screenshots, a manifest, and a run folder you can hand to a client or archive in
CI.

**Status: M0 (walking skeleton).** One command, three viewports, PNG output, no
config required. Discovery, video, gallery, and stabilization beyond the core are
the next milestones.

```bash
npx capturekit run http://localhost:3000
```

That is the whole interface for the common case. It opens nothing, asks nothing,
and leaves a folder under `captures/` you can zip and send.

## Why

Visual material is needed on every release and skipped on most of them, because
making it is tedious: resizing the browser, waiting for lazy images, dismissing
cookie banners, re-taking the shot because a hero animation was caught
half-way. capturekit removes the tedium by owning the four boring mechanisms that
make a capture trustworthy — ready detection, animation freezing, validation, and
retry — and delegating all rendering to Playwright.

## What M0 does

|               |                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------- |
| **Input**     | one URL, optional `capture.config.ts`                                                       |
| **Pages**     | an explicit `pages` list (auto-discovery is M1)                                             |
| **Viewports** | `mobile` 390x844@3x, `tablet` 834x1112@2x, `laptop`, `desktop`, or custom                   |
| **Capture**   | full-page or viewport PNG, one isolated context per viewport, concurrent                    |
| **Stabilize** | network idle, fonts ready, images decoded, DOM quiescence, animation freeze, scroll warm-up |
| **Validate**  | rejects blank frames, HTTP errors, and framework error overlays                             |
| **Retry**     | 3 attempts with an escalating wait strategy; retains a trace on final failure               |
| **Package**   | `manifest.json`, `logs/run.log.json`, `.latest` pointer                                     |

## Commands

```
capturekit run [url]     capture a target and write a run folder
capturekit init          write a documented capture.config.ts
capturekit doctor        check Node, Chromium, and viewports (--install to provision)
capturekit clean         remove old run folders (--keep 3 to retain the newest)
```

Useful `run` flags: `--pages /,/pricing`, `--viewport mobile desktop`,
`--viewport-only`, `--out <dir>`, `--json`, `--quiet`, `--verbose`,
`--max-fail-rate <fraction>`, `--no-config`.

## Output

```
captures/
  2026-09-29T14-32-10_a1b2c3/
    manifest.json
    screenshots/
      home/      mobile.png  tablet.png  desktop.png
      pricing/   ...
    logs/
      run.log.json
      traces/            # only for failures
  .latest                # names the newest run
```

## Exit codes

| Code | Meaning                                                    |
| ---- | ---------------------------------------------------------- |
| 0    | succeeded, or failed under `--max-fail-rate` (default 0.5) |
| 1    | failure rate above the threshold                           |
| 2    | wrong command line                                         |
| 3    | invalid config                                             |
| 4    | environment cannot capture (no Chromium)                   |

With `--json`, stdout carries only the JSON summary and all progress goes to
stderr, so `capturekit run --json | jq` works in a pipeline.

## Run it from source

Requires Node 22.6+ (Node 23 recommended). capturekit runs its own TypeScript
source directly through Node type stripping — there is no build step.

```bash
npm install
npm run doctor     # verifies Chromium; add --install if missing
npm run fixture    # serves the local fixture site on :4111
npm run smoke      # end-to-end acceptance test against the fixture
npm run typecheck
```

`bin/capturekit.mjs` is a plain-JS bootstrap that re-execs the CLI with
`--experimental-strip-types` on runtimes where type stripping is not yet the
default.

## Design rules

1. **Autonomous by default, controllable by exception.** Every config field has a
   working default; config refines, never enables.
2. **Never fail silently, never fail wholly.** One broken page does not sink a
   run, and every failure is recorded with a reason and a trace.
3. **Boring core.** Playwright renders; capturekit owns orchestration,
   stabilization, and packaging.
4. **Outputs are artifacts.** A run folder is self-describing and stays valid.
5. **Local-first.** Nothing leaves the machine unless you publish it.

## Roadmap

M1 discovery + gallery + video · M2 client-ready (device frames, dark mode,
overlay dismissal, flows, auth, branding, exports) · M3 automation (GitHub
Action, `start` command, Docker) · M4 optional AI layer · M5 framework route
adapters and publish targets.

Not goals for v1: visual regression diffing, native mobile capture, hosted SaaS,
a visual editor. See `docs/`.

## Relationship to Dino

capturekit is a standalone tool that works on any URL, with or without Dino. The
contract between them is `manifest.json`: capturekit produces it, Dino's
`POST /api/v1/imports/capturekit` consumes it and opens the assets as a draft
Project for review. See `docs/INTEGRATION-DINO.md`.

MIT licensed.
