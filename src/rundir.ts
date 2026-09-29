import { randomBytes } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

/**
 * Run directory + pointer file.
 *
 * Principle 4: "Outputs are artifacts, not logs" — every run is a versioned,
 * self-describing folder that stays valid even after newer runs exist.
 */
export type RunLocation = {
  /** Short hex id, matches `manifest.json`'s `runId`. */
  runId: string
  /** Directory name, e.g. `2026-09-29T14-32-10_a1b2c3`. */
  dirName: string
  /** Absolute path to the run directory. */
  dir: string
  screenshotsDir: string
  logsDir: string
  tracesDir: string
  startedAt: Date
}

/** `2026-09-29T14-32-10` — UTC, sortable, filesystem-safe (colons are not). */
function stamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace(/:/g, "-")
}

export async function createRun(outDir: string): Promise<RunLocation> {
  const startedAt = new Date()
  const runId = randomBytes(3).toString("hex")
  const dirName = `${stamp(startedAt)}_${runId}`
  const dir = path.join(outDir, dirName)

  const location: RunLocation = {
    runId,
    dirName,
    dir,
    screenshotsDir: path.join(dir, "screenshots"),
    logsDir: path.join(dir, "logs"),
    tracesDir: path.join(dir, "logs", "traces"),
    startedAt,
  }

  // recursive mkdir: the run dir, its two children, and outDir if missing.
  await mkdir(location.screenshotsDir, { recursive: true })
  await mkdir(location.tracesDir, { recursive: true })

  return location
}

/**
 * The PRD specifies a `latest` symlink. Symlinks need extra privileges on
 * Windows (open question 5), so the pointer is a plain text file with the run
 * directory name — same ergonomics, portable everywhere, and diff-free.
 */
export async function writeLatestPointer(outDir: string, run: RunLocation): Promise<string> {
  const pointer = path.join(outDir, ".latest")
  await writeFile(pointer, run.dirName + "\n", "utf8")
  return pointer
}

export async function readLatestPointer(outDir: string): Promise<string | null> {
  try {
    const text = await readFile(path.join(outDir, ".latest"), "utf8")
    const trimmed = text.trim()
    return trimmed || null
  } catch {
    return null
  }
}
