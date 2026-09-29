#!/usr/bin/env node
// Plain-JS bootstrap. capturekit's source is TypeScript and runs directly on
// Node via type stripping (no build step, no bundler, nothing to install).
//
// Node unflagged type stripping arrived in 22.18.0 / 23.6.0. Older runtimes in
// the supported range still run the same source, we just have to pass the
// experimental flag ourselves by re-execing the CLI once.
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import path from "node:path"
import process from "node:process"

// 22.6.0 is where --experimental-strip-types first appeared; without it there is
// no way to run .ts source, which is what this package ships.
const MIN_MAJOR = 22
const MIN_MINOR = 6

const here = path.dirname(fileURLToPath(import.meta.url))
const entry = path.join(here, "..", "src", "cli.ts")

const [major, minor] = process.versions.node.split(".").map(Number)
const tooOld =
  !Number.isFinite(major) || major < MIN_MAJOR || (major === MIN_MAJOR && (!Number.isFinite(minor) || minor < MIN_MINOR))
if (tooOld) {
  process.stderr.write(
    `capturekit needs Node ${MIN_MAJOR}.${MIN_MINOR} or newer (you are on ${process.versions.node}).\n` +
      `Install it with: nvm install 22\n`,
  )
  process.exit(2)
}

// Node reports the TypeScript mode as a truthy string ("strip", or a future
// mode) when stripping is on by default, and `false` when the flag is required.
// This file is plain .js (type syntax is only stripped from .ts), so no annotation.
const nativeTs = process.features.typescript
const needsFlag = typeof nativeTs !== "string"

const child = spawn(
  process.execPath,
  [
    ...(needsFlag ? ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"] : []),
    entry,
    ...process.argv.slice(2),
  ],
  { stdio: "inherit" },
)

child.on("error", (err) => {
  process.stderr.write(`capturekit failed to start: ${err.message}\n`)
  process.exit(2)
})

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 1)
})
