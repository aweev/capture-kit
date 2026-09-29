import { DEVICES, DEVICE_NAMES } from '../devices.ts';
import { run, type RunOptions, type RunResult } from '../run.ts';

/**
 * `capturekit run` (FR-35).
 *
 * The whole product promise lives in this file's defaults: `capturekit run
 * <url>` with no config file must work (G1, acceptance criterion 1).
 */
export type RunCliOptions = {
  config?: string;
  viewport?: string[];
  pages?: string;
  out?: string;
  noConfig?: boolean;
  viewportOnly?: boolean;
  scheme?: string[];
  format?: string;
  frame?: string;
  exportZip?: boolean;
  ai?: boolean;
  aiKey?: string;
  concurrency?: string;
  timeout?: string;
  json?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  maxFailRate?: string;
  open?: boolean;
  watch?: boolean;
  /** From --no-video (commander defaults true). */
  video?: boolean;
  /** From --no-discover (commander defaults true). */
  discover?: boolean;
};

export function toRunOptions(url: string | undefined, options: RunCliOptions): RunOptions {
  return {
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
    ...(options.ai === true ? { ai: true } : {}),
    ...(options.aiKey === undefined ? {} : { aiKey: options.aiKey }),
    ...(options.concurrency === undefined ? {} : { concurrency: Number(options.concurrency) }),
    ...(options.timeout === undefined ? {} : { timeoutMs: Number(options.timeout) }),
    ...(options.json === true ? { json: true } : {}),
    ...(options.quiet === true ? { quiet: true } : {}),
    ...(options.verbose === true ? { level: 'debug' as const } : {}),
    ...(options.maxFailRate === undefined ? {} : { maxFailureRate: Number(options.maxFailRate) }),
    ...(options.video === false ? { videoWalkthrough: false } : {}),
    ...(options.discover === false ? { discover: false } : {}),
  };
}

export async function runCommand(
  url: string | undefined,
  options: RunCliOptions,
): Promise<RunResult> {
  return run(toRunOptions(url, options));
}

/** Machine-readable summary for `--json` (FR-39). stdout carries only this. */
export function jsonResult(result: RunResult): string {
  return JSON.stringify(
    {
      ok: result.exitCode === 0,
      exitCode: result.exitCode,
      runDir: result.run.dir,
      manifestPath: result.manifestPath,
      summary: result.manifest.summary,
      assets: result.manifest.assets.map((asset) => asset.path),
      failures: result.manifest.failures.map((failure) => ({
        page: failure.page,
        viewport: failure.viewport,
        reason: failure.reason,
      })),
    },
    null,
    2,
  );
}

export { DEVICES, DEVICE_NAMES };
