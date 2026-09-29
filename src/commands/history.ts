import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Command } from 'commander';

import { isCaptureKitError, ExitCode } from '../exit.ts';
import { listRuns, matchAssets, sliderHtml } from '../history.ts';
import { Logger } from '../log.ts';
import type { Manifest } from '../manifest.ts';

/**
 * `capturekit history` (FR-33).
 *
 * Lists runs (newest last) from the output root, or writes a before/after
 * slider page comparing two runs.
 */
export function historyCommand(program: Command): Command {
  return program
    .command('history')
    .description('List past runs, or compare two with a before/after slider.')
    .option('--out <dir>', 'output root (default: captures)')
    .option('--compare <pair>', 'two run dir names, e.g. "runA,runB"')
    .option('--write <file>', 'write the slider page here (default: compare.html in cwd)')
    .option('--json', 'print machine-readable JSON to stdout')
    .action(async (options: HistoryCliOptions) => {
      try {
        const outDir = options.out ?? 'captures';
        if (options.compare) {
          const [beforeName, afterName] = options.compare.split(',').map((s) => s.trim());
          if (!beforeName || !afterName) {
            process.stderr.write('\nerror: --compare needs two run names: --compare older,newer\n');
            process.exit(ExitCode.Usage);
          }
          const read = async (name: string): Promise<Manifest> =>
            JSON.parse(await readFile(path.join(outDir, name, 'manifest.json'), 'utf8')) as Manifest;
          const before = await read(beforeName);
          const after = await read(afterName);
          const pairs = matchAssets(before, after).map((p) => ({
            ...p,
            beforeUrl: path.join(outDir, beforeName, p.before).split(path.sep).join('/'),
            afterUrl: path.join(outDir, afterName, p.after).split(path.sep).join('/'),
          }));
          const html = sliderHtml({
            title: `Compare ${beforeName} → ${afterName}`,
            beforeLabel: beforeName,
            afterLabel: afterName,
            pairs,
          });
          const dest = options.write
            ? path.resolve(process.cwd(), options.write)
            : path.join(process.cwd(), 'compare.html');
          await writeFile(dest, html, 'utf8');
          process.stderr.write(`compared ${pairs.length} capture(s): ${dest}\n`);
          return;
        }
        const runs = await listRuns(outDir);
        if (options.json === true) {
          process.stdout.write(JSON.stringify(runs, null, 2) + '\n');
          return;
        }
        const logger = new Logger({});
        if (runs.length === 0) {
          logger.info(`no runs in ${outDir}`);
          return;
        }
        logger.info(`${runs.length} run(s) in ${outDir} (newest last)`);
        for (const run of runs) {
          logger.info(
            `  ${run.dirName}  ${run.succeeded}/${run.planned} ok  ${run.target}  ${run.startedAt}`,
          );
        }
      } catch (err) {
        if (isCaptureKitError(err)) {
          process.stderr.write(`\nerror: ${err.message}\n`);
          if (err.hint !== undefined) process.stderr.write(`hint:  ${err.hint}\n`);
          process.exit(err.code);
        }
        process.stderr.write(`\nunexpected error: ${String(err)}\n`);
        process.exit(ExitCode.CaptureFailed);
      }
    });
}

export type HistoryCliOptions = {
  out?: string;
  compare?: string;
  write?: string;
  json?: boolean;
};
