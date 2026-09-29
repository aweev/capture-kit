import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { Command } from 'commander';

import { ExitCode } from '../exit.ts';
import { readLatestPointer } from '../rundir.ts';

const execFileAsync = promisify(execFile);

/**
 * `capturekit open` (FR-35).
 *
 * Opens the latest run's gallery in the default browser. `--run` picks a
 * specific run; without a gallery yet it points at whatever index.html,
 * preview.html, or manifest.json exists, preferring in that order.
 */
export function openCommand(program: Command): Command {
  return program
    .command('open')
    .description("Open the latest run's gallery in the browser.")
    .option('--out <dir>', 'output root (default: captures)')
    .option('--run <name>', 'run dir name (default: latest)')
    .action(async (options: OpenCliOptions) => {
      const outDir = options.out ?? 'captures';
      let runName = options.run;
      if (!runName) {
        const latest = await readLatestPointer(outDir);
        if (!latest) {
          process.stderr.write(`\nerror: no runs in ${outDir}.\n`);
          process.exit(ExitCode.Usage);
        }
        runName = latest;
      }
      const runDir = path.resolve(outDir, runName);
      const candidate = ['index.html', 'preview.html', 'manifest.json']
        .map((file) => path.join(runDir, file))
        .find((file) => existsSync(file));
      if (!candidate) {
        process.stderr.write(`\nerror: ${runDir} has nothing to open.\n`);
        process.exit(ExitCode.Usage);
      }
      try {
        await openFile(candidate);
      } catch (err) {
        process.stderr.write(`\nerror: could not open ${candidate}: ${(err as Error).message}\n`);
        process.stderr.write(`hint:  open it manually: ${candidate}\n`);
        process.exit(ExitCode.Environment);
      }
      process.stderr.write(`opened ${candidate}\n`);
    });
}

/** Platform opener: `open`, `xdg-open`, or `start` (never through a shell). */
export async function openFile(file: string): Promise<void> {
  if (process.platform === 'darwin') {
    await execFileAsync('open', [file]);
  } else if (process.platform === 'win32') {
    await execFileAsync('cmd', ['/c', 'start', '""', file]);
  } else {
    await execFileAsync('xdg-open', [file]);
  }
}

export type OpenCliOptions = {
  out?: string;
  run?: string;
};
