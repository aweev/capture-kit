# Architecture

M0 (walking skeleton) is the pipeline in PRD section 8 with two stages removed:
discovery and post-processing. What is here is the parts that decide whether a
capture can be trusted.

```
CLI (src/cli.ts)
  -> config loader, Zod-validated (src/config.ts)
  -> job planner, page x viewport (src/jobs.ts)
  -> bounded worker pool, p-limit (src/run.ts)
  -> one browser, isolated context per job (src/capture.ts)
  -> stabilizer: ready + freeze + scroll + quiescence (src/stabilize.ts)
  -> validator: blank frame, HTTP error, error overlay (src/stabilize.ts)
  -> retry ladder: standard -> patient -> fallback (src/capture.ts)
  -> packager: manifest.json + run.log.json + traces (src/manifest.ts)
```

## Module map

| file | owns | FR |
|---|---|---|
| `cli.ts` | command surface, exit codes, error presentation | FR-35, FR-39 |
| `config.ts` | schema, defaults, file discovery, flag overrides | FR-11 |
| `devices.ts` | built-in viewport profiles | FR-6 |
| `jobs.ts` | the idempotent unit of work, slug de-duplication | FR-3 (partial) |
| `run.ts` | planning, pool, failure accounting, packaging | FR-7, FR-29 |
| `capture.ts` | context lifecycle, screenshot, retry ladder, traces | FR-8, FR-17, FR-24 |
| `stabilize.ts` | ready detection, motion freeze, validators | FR-12/13/14/18 |
| `manifest.ts` | the output contract | FR-29 |
| `rundir.ts` | run folder + `.latest` pointer | FR-33 |
| `log.ts` | console + JSONL sinks | section 7 |
| `exit.ts` | exit codes and typed errors | FR-39 |
| `clean.ts` | run retention | FR-35 |

## Decisions worth knowing

**One browser, many contexts.** Contexts are cheap and isolated; processes are
not. Per-job contexts mean a viewport cannot leak state into another, and the
pool bound (`min(cores, 4)`) is the only concurrency control needed.

**The job is the unit of everything.** `(page, viewport, mode)` is idempotent and
has its own retry state, its own output path, and its own failure record. This is
what makes partial reruns, parallelism, and "one broken page does not sink the
run" fall out of the design instead of requiring special cases.

**Every stabilization signal degrades to a warning.** Network never going idle,
fonts hanging, a scroll that times out — each logs and continues. Only the
*validators* can reject a frame, and they do so with a reason plus a retained
trace. A tool that fails a capture because a websocket stayed open is a tool that
gets deleted from CI.

**The retry ladder escalates strategy, not just time.** Rung 1 uses standard
waits, rung 2 waits longer and warms up scrolling, rung 3 loads on
`domcontentloaded` and accepts less. Retrying the identical sequence three times
would only triple the latency of a page that is genuinely broken.

**Blank-frame detection decodes pixels.** The first implementation estimated
blankness from compressed PNG bytes per pixel. It false-positived on clean,
mostly-white marketing pages — precisely the pages this tool exists to capture —
because flat backgrounds and hairline borders compress extremely well. The
validator now downsamples the real frame and measures colour spread. Do not
replace it with a size heuristic.

**Traces are failures-only.** Every attempt starts a trace so the final one can be
persisted; successful and intermediate attempts discard it. This keeps `traces/`
empty on a green run and makes a red run debuggable without a reprod.

**No build step.** Source is TypeScript, run directly by Node's type stripping.
`bin/capturekit.mjs` is plain JS and passes the experimental flag on runtimes
where stripping is not yet the default. A CLI installed with `npx` should not
depend on a transpile cache.

**`.latest` is a text file, not a symlink.** PRD section 9 specifies a symlink;
on Windows that needs extra privileges, and capturekit must work on a dev laptop.
A pointer file holding the run directory name gives the same ergonomics
portably. Revisit if it proves annoying.

## Deferred to M1+

Discovery (sitemap, crawl, route adapters), video and ffmpeg post-processing, the
generated gallery, device frames, dark/light schemes, overlay dismissal, masking
and time-freezing, auth, flows, publish adapters, the plugin surface, and the
optional AI layer. The config schema is strict today so that adding these later
is purely additive.
