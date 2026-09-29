import path from "node:path"

import type { Device } from "./devices.ts"

/**
 * Job planner (PRD section 8: "Job Planner — page x viewport x mode").
 *
 * Every capture is an idempotent job keyed by (page, viewport, mode). Making the
 * job the unit of work is what allows parallelism, partial reruns, and per-job
 * retry state without any two jobs touching the same file.
 */
export type CaptureMode = "viewport" | "fullPage"

export type Job = {
  /** Stable identity across runs: `pagePath@viewport`. */
  id: string
  /** Path relative to the target origin, e.g. `/pricing`. */
  pagePath: string
  /** Folder name under `screenshots/`, e.g. `pricing`. */
  pageSlug: string
  /** Fully resolved URL for this job. */
  url: string
  device: Device
  mode: CaptureMode
  /** Where the PNG lands, relative to the run directory. */
  relPath: string
}

export type JobFailure = {
  job: Job
  /** Human-readable reason; always accompanied by a log line (Principle 2). */
  reason: string
  /** 1-based attempt number that produced this failure. */
  attempts: number
  /** Per-attempt diagnostics, newest last. */
  attemptsDetail: AttemptRecord[]
  /** Relative path of the retained Playwright trace, when one was written. */
  tracePath?: string
}

export type AttemptRecord = {
  attempt: number
  strategy: string
  durationMs: number
  status: number | null
  error?: string
}

/**
 * Folder name for a page. `/` becomes `home`, `/blog/hello` becomes
 * `blog-hello`. Trailing slashes and query strings are dropped so two URLs that
 * render the same page cannot collide.
 */
export function pageSlug(pagePath: string): string {
  const clean = pagePath.split("?")[0]?.split("#")[0] ?? ""
  const trimmed = clean.replace(/\/+$/, "")
  if (trimmed === "" || trimmed === "/") return "home"
  const slug = trimmed
    .replace(/^\/+/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug || "home"
}

/**
 * Expand pages x viewports into jobs, de-duplicating slugs so a collision
 * (e.g. `/a-b` vs `/a_b`) cannot silently overwrite a PNG.
 */
export function planJobs(options: {
  base: URL
  pages: string[]
  devices: Device[]
  fullPage: boolean
}): { jobs: Job[]; collisions: string[] } {
  const mode: CaptureMode = options.fullPage ? "fullPage" : "viewport"
  const used = new Map<string, number>()
  const collisions: string[] = []
  const jobs: Job[] = []

  for (const pagePath of options.pages) {
    let slug = pageSlug(pagePath)
    const seen = used.get(slug)
    if (seen !== undefined) {
      used.set(slug, seen + 1)
      slug = `${slug}-${seen + 1}`
      collisions.push(`${pagePath} -> ${slug}`)
    } else {
      used.set(slug, 1)
    }

    for (const device of options.devices) {
      const url = new URL(path.posix.join("/", pagePath), options.base).toString()
      jobs.push({
        id: `${pagePath}@${device.name}`,
        pagePath,
        pageSlug: slug,
        url,
        device,
        mode,
        relPath: `screenshots/${slug}/${device.name}.png`,
      })
    }
  }

  return { jobs, collisions }
}
