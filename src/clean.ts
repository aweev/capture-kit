import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { CaptureKitError, ExitCode } from './exit.ts';
import { readLatestPointer } from './rundir.ts';

/**
 * `capturekit clean` (FR-35).
 *
 * Run folders are the product, so they accumulate fast. Only directories that
 * match the run-folder shape (`<timestamp>_<6 hex>`) are eligible — a stray
 * folder inside the output root is never deleted by accident, and the pointer
 * file is left alone because it is rewritten by every run.
 */
const RUN_DIR_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}_[0-9a-f]{6}$/;

export type CleanOptions = { outDir: string; keep: number };

export async function cleanRuns(options: CleanOptions): Promise<string[]> {
  const root = path.resolve(options.outDir);

  try {
    const info = await stat(root);
    if (!info.isDirectory()) {
      throw new CaptureKitError(`${root} is not a directory.`, ExitCode.Usage);
    }
  } catch (err) {
    if (err instanceof CaptureKitError) throw err;
    throw new CaptureKitError(
      `no output folder at ${root}`,
      ExitCode.Usage,
      'Run `capturekit run` first.',
    );
  }

  const entries = await readdir(root);
  const runs = entries.filter((entry) => RUN_DIR_PATTERN.test(entry)).sort();

  if (runs.length <= options.keep) return [];

  // Names are UTC timestamps, so lexical order is chronological order: keep the
  // tail, remove the head.
  const removing = runs.slice(0, Math.max(0, runs.length - options.keep));
  const latest = await readLatestPointer(root);

  for (const dir of removing) {
    // Never delete the run the pointer refers to, even if it is old.
    if (dir === latest) continue;
    await rm(path.join(root, dir), { recursive: true, force: true });
  }

  return removing.filter((dir) => dir !== latest);
}
