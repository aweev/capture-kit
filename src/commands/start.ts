import { buildConfig } from '../config.ts';
import { CaptureKitError, ExitCode } from '../exit.ts';
import type { RunResult } from '../run.ts';
import { startAndCapture } from '../start.ts';
import { toRunOptions, type RunCliOptions } from './run.ts';

/**
 * `capturekit start` (FR-27).
 *
 * Same flags as `run`, plus app boot: `start.command` / `start.waitOn` come
 * from the config file or `--start-command` / `--wait-on`. The managed app is
 * always torn down, even when the capture fails.
 */
export type StartCliOptions = RunCliOptions & {
  startCommand?: string;
  waitOn?: string;
  startTimeout?: string;
};

export async function startCommand(
  url: string | undefined,
  options: StartCliOptions,
): Promise<RunResult> {
  const runOptions = toRunOptions(url, options);
  const config = await buildConfig({
    ...(url === undefined ? {} : { url }),
    ...(options.config === undefined ? {} : { config: options.config }),
    ...(options.viewport === undefined ? {} : { viewport: options.viewport }),
    ...(options.pages === undefined ? {} : { pages: options.pages }),
    ...(options.out === undefined ? {} : { outDir: options.out }),
    ...(options.noConfig === true ? { noConfig: true } : {}),
    ...(options.viewportOnly === true ? { fullPage: false } : {}),
    ...(options.scheme === undefined ? {} : { scheme: options.scheme }),
    ...(options.format === undefined ? {} : { format: options.format }),
    ...(options.frame === undefined ? {} : { frame: options.frame }),
    ...(options.exportZip === true ? { exportZip: true } : {}),
    ...(options.concurrency === undefined ? {} : { concurrency: Number(options.concurrency) }),
    ...(options.timeout === undefined ? {} : { timeoutMs: Number(options.timeout) }),
    ...(options.startCommand ? { startCommand: options.startCommand } : {}),
    ...(options.waitOn ? { waitOn: options.waitOn } : {}),
    ...(options.ai === true ? { ai: true } : {}),
    ...(options.aiKey ? { aiKey: options.aiKey } : {}),
    ...(options.video === false ? { videoWalkthrough: false } : {}),
    ...(options.discover === false ? { discover: false } : {}),
  });
  const start = config.start;
  if (!start) {
    throw new CaptureKitError(
      'No `start` configuration.',
      ExitCode.Usage,
      'Set `start: { command, waitOn }` in capture.config.ts or pass --start-command and --wait-on.',
    );
  }
  return startAndCapture(
    {
      ...start,
      ...(options.startTimeout ? { timeoutMs: Number(options.startTimeout) } : {}),
    },
    runOptions,
  );
}
