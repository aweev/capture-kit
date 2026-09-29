# Configuration reference

Config is optional. `capturekit run <url>` works with no file at all; the file
exists to refine defaults, never to enable features.

## File discovery

capturekit looks for, in order:

1. the path given to `--config <file>`
2. `capture.config.ts`, `capture.config.mjs`, or `capture.config.js` in the
   current directory or the nearest parent (up to 8 levels)

`--no-config` ignores all of it. Flags always beat the file.

The file is imported directly by Node (type-stripped, no build step) and must
have a default export. `defineConfig` is available for editor type-checking but
a plain object works too, which is why `capturekit init` writes one: a template
must be valid before capturekit is installed as a package in that project.

```ts
export default {
  target: 'http://localhost:3000',
  pages: ['/', '/pricing'],
  viewports: ['mobile', 'tablet', 'desktop'],
};
```

## Schema

Every field below shows its default. Anything not listed here is rejected —
unknown keys are a config error (exit 3), not a silent ignore, because a typo in
`concurrency` would otherwise quietly cost you parallelism.

### target

Absolute http/https URL. The base that `pages` paths resolve against.

```ts
target: 'https://preview.example.com';
```

### outDir

`"captures"` — relative to the process working directory. Each run creates
`<outDir>/<UTC timestamp>_<6 hex>/`.

### pages

`["/"]` — paths resolved against `target`'s origin. M0 uses an explicit list;
`discovery` replaces it in M1.

### viewports

`["mobile", "tablet", "desktop"]`. Names or custom objects:

| name      | CSS px      | DPR | mobile |
| --------- | ----------- | --- | ------ |
| `mobile`  | 390 x 844   | 3   | yes    |
| `tablet`  | 834 x 1112  | 2   | yes    |
| `laptop`  | 1440 x 900  | 2   | no     |
| `desktop` | 1920 x 1080 | 2   | no     |

```ts
viewports: ['desktop', { name: 'ultrawide', width: 3440, height: 1440, deviceScaleFactor: 1 }];
```

A custom profile that reuses a built-in name overrides it for that run. Names
must be unique, since they become filenames.

### capture

```ts
capture: {
  fullPage: true,   // false captures only the viewport (FR-8)
  format: "png",    // webp/jpeg arrive with the sharp post-processor (FR-9)
}
```

### stabilize

The knobs that decide whether a capture can be trusted.

```ts
stabilize: {
  networkIdle: true,          // wait for load state networkidle (FR-12)
  fontsReady: true,           // await document.fonts.ready (FR-12)
  imagesDecoded: true,        // await incomplete images' decode() (FR-12)
  mutationQuiescenceMs: 400,  // DOM must be quiet this long (FR-12)
  disableAnimations: true,    // inject CSS that stops motion; sets reducedMotion (FR-14)
  scrollWarmup: true,         // scroll to bottom and back to fire lazy loading (FR-13)
  timeoutMs: 20000,           // per-attempt ready budget
  attempts: 3,                // retry ladder rungs (FR-17)
}
```

`attempts` maps onto the ladder: 1 = standard waits, 2 = patient (longer settle,
fuller scroll), 3 = fallback (loads on `domcontentloaded` and accepts less). Only
the final failed attempt keeps a Playwright trace.

### concurrency

`min(cpu cores, 4)`. Number of capture contexts alive at once (FR-7). One
browser is shared; isolation comes from a fresh context per job.

## CLI overrides

| flag                        | sets                                    |
| --------------------------- | --------------------------------------- |
| `[url]`                     | `target`                                |
| `--pages /,/pricing`        | `pages`                                 |
| `--viewport mobile desktop` | `viewports`                             |
| `--viewport-only`           | `capture.fullPage = false`              |
| `--out <dir>`               | `outDir`                                |
| `--concurrency <n>`         | `concurrency`                           |
| `--timeout <ms>`            | `stabilize.timeoutMs`                   |
| `--max-fail-rate <f>`       | exit-code threshold, not a config field |

## Not configurable yet (M1+)

`discovery`, `schemes` (dark/light), `frame` (device mockups), `mask`,
`freezeTime`, `dismissOverlays`, `video`, `flows`, `auth`, `gallery`, `publish`.
The schema is strict, so adding these later is additive and cannot break an
existing file.
