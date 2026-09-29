import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Job } from './jobs.ts';

/**
 * `manifest.json` (FR-29).
 *
 * The manifest is the contract between a run and every consumer: the gallery,
 * a future Dino importer, CI. It must describe what succeeded, what failed and
 * why, so nothing has to be inferred from the file system.
 */
export type ManifestAsset = {
  page: string;
  viewport: string;
  type: 'screenshot';
  path: string;
  width: number;
  height: number;
  deviceScaleFactor: number;
  fullPage: boolean;
  format: 'png' | 'webp' | 'jpeg';
  /** Capture mode (FR-8). Absent means "fullPage"/"viewport" per `fullPage` (pre-M5 manifests). */
  mode?: 'viewport' | 'fullPage' | 'element' | 'aboveTheFold';
  /** Selector captured in `element` mode. */
  selector?: string;
  /**
   * Measured box of an `element` capture in CSS px, so the gallery can label a
   * shot whose pixels are not the size of the viewport.
   */
  clip?: { x: number; y: number; width: number; height: number };
  /** Color scheme (FR-10). Absent means light (M0 manifests). */
  scheme?: 'light' | 'dark';
  /** Device frame recorded for gallery rendering (FR-9). */
  frame?: 'none' | 'browser' | 'phone' | 'auto';
  /** Flow that produced this asset, if any (FR-21). */
  flow?: string;
  bytes: number;
  /** Height of the rendered page in CSS px; equals viewport height when not full-page. */
  contentHeight: number;
  attempts: number;
  durationMs: number;
  /** Which retry strategy ultimately produced this asset. */
  strategy: string;
};

export type ManifestVideo = {
  page: string;
  viewport: string;
  type: 'video';
  path: string;
  width: number;
  height: number;
  /** Format: mp4, webm, gif. */
  format: 'mp4' | 'webm' | 'gif';
  /** What the video shows: walkthrough (auto scroll) or a named flow (FR-21/22). */
  kind: 'walkthrough' | 'flow';
  flow?: string;
  bytes: number;
  durationMs: number;
  attempts: number;
  scheme?: 'light' | 'dark';
};

export type ManifestFailure = {
  page: string;
  viewport: string;
  type: 'screenshot';
  reason: string;
  attempts: number;
  /** Per-attempt detail, newest last. */
  attemptLog: unknown[];
  tracePath?: string;
  durationMs: number;
};

export type Manifest = {
  schemaVersion: 1;
  runId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  target: string;
  /** Capturekit version + the browser that actually rendered, for reproducibility. */
  tool: { name: 'capturekit'; version: string; chromium: string };
  gitRef?: string;
  config: { source: string; concurrency: number; viewports: string[] };
  summary: {
    planned: number;
    succeeded: number;
    failed: number;
    /** Jobs that needed more than the first attempt. */
    retried: number;
    durationMs: number;
  };
  assets: ManifestEntry[];
  failures: ManifestFailure[];
};

/** Discriminated union of all asset types in a manifest. */
export type ManifestEntry = ManifestAsset | ManifestVideo;

/** Fields that can come from a job that never produced an asset. */
export function buildManifest(options: {
  runId: string;
  startedAt: Date;
  finishedAt: Date;
  target: string;
  version: string;
  chromium: string;
  gitRef?: string;
  configSource: string;
  concurrency: number;
  viewports: string[];
  planned: number;
  assets: ManifestEntry[];
  failures: ManifestFailure[];
}): Manifest {
  const durationMs = options.finishedAt.getTime() - options.startedAt.getTime();
  const retried = options.assets.filter((asset) => asset.attempts > 1).length;
  return {
    schemaVersion: 1,
    runId: options.runId,
    startedAt: options.startedAt.toISOString(),
    finishedAt: options.finishedAt.toISOString(),
    durationMs,
    target: options.target,
    tool: { name: 'capturekit', version: options.version, chromium: options.chromium },
    ...(options.gitRef ? { gitRef: options.gitRef } : {}),
    config: {
      source: options.configSource,
      concurrency: options.concurrency,
      viewports: options.viewports,
    },
    summary: {
      planned: options.planned,
      succeeded: options.assets.length,
      failed: options.failures.length,
      retried,
      durationMs,
    },
    assets: options.assets,
    failures: options.failures,
  };
}

export async function writeManifest(dir: string, manifest: Manifest): Promise<string> {
  const file = path.join(dir, 'manifest.json');
  await writeFile(file, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return file;
}

export async function readManifest(dir: string): Promise<Manifest> {
  const raw = await readFile(path.join(dir, 'manifest.json'), 'utf8');
  return JSON.parse(raw) as Manifest;
}

/** Asset shape helper, so the capture worker cannot forget a field. */
export function assetFromJob(
  job: Job,
  values: {
    bytes: number;
    contentHeight: number;
    attempts: number;
    durationMs: number;
    strategy: string;
    frame?: 'none' | 'browser' | 'phone' | 'auto';
    clip?: { x: number; y: number; width: number; height: number };
  },
): ManifestAsset {
  return {
    page: job.pagePath,
    viewport: job.device.name,
    type: 'screenshot',
    path: job.relPath.split(path.sep).join('/'),
    width: job.device.width,
    height: job.device.height,
    deviceScaleFactor: job.device.deviceScaleFactor,
    fullPage: job.mode === 'fullPage',
    mode: job.mode === 'viewport' || job.mode === 'fullPage' ? undefined : job.mode,
    ...(job.selector ? { selector: job.selector } : {}),
    ...(values.clip ? { clip: values.clip } : {}),
    format: job.format ?? 'png',
    ...((job.scheme ?? 'light') === 'light' ? {} : { scheme: job.scheme }),
    ...(job.frame && job.frame !== 'none' ? { frame: job.frame } : {}),
    ...(job.flowName ? { flow: job.flowName } : {}),
    bytes: values.bytes,
    contentHeight: values.contentHeight,
    attempts: values.attempts,
    durationMs: values.durationMs,
    strategy: values.strategy,
  };
}
