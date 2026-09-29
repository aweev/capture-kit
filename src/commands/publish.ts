import path from 'node:path';
import { Command } from 'commander';

import { isCaptureKitError, ExitCode } from '../exit.ts';
import { publishRun, publishTargetSchema } from '../publish.ts';
import { redactSecrets } from '../auth.ts';
import { readLatestPointer } from '../rundir.ts';
import { Logger } from '../log.ts';

/**
 * `capturekit publish` (FR-34).
 *
 * Publishes a run folder to a target: `--to folder --dest ./out`,
 * `--to github-pages --dest ./site`, `--to s3 --bucket name --prefix cap/`,
 * `--to r2 ...`, `--to netlify|vercel --dest ./dist`. Defaults to the latest
 * run; `--run <dirName>` picks another.
 */
export function publishCommand(program: Command): Command {
  return program
    .command('publish')
    .description('Publish a run folder to a hosting target.')
    .option('--to <type>', 'folder, github-pages, s3, r2, netlify, vercel')
    .option('--dest <dir>', 'destination for folder-style targets')
    .option('--bucket <name>', 'bucket for s3/r2')
    .option('--prefix <path>', 'key prefix for s3/r2', '')
    .option('--endpoint <url>', 'endpoint URL for r2')
    .option('--cname <host>', 'custom domain for github-pages')
    .option('--run <name>', 'run dir name (default: latest)')
    .option('--out <dir>', 'output root holding the runs (default: captures)')
    .action(async (options: PublishCliOptions) => {
      try {
        if (!options.to) {
          process.stderr.write('\nerror: --to is required.\n');
          process.stderr.write('hint:  --to folder --dest ./out\n');
          process.exit(ExitCode.Usage);
        }
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
        // Only the keys each target type accepts (schemas are strict).
        const candidate: Record<string, string> = { type: options.to };
        if (options.dest) candidate.dest = options.dest;
        if (options.bucket) candidate.bucket = options.bucket;
        if (options.to === 's3' || options.to === 'r2') candidate.prefix = options.prefix ?? '';
        if (options.endpoint) candidate.endpoint = options.endpoint;
        if (options.cname) candidate.cname = options.cname;
        const parsed = publishTargetSchema.safeParse(candidate);
        if (!parsed.success) {
          process.stderr.write(
            `\nerror: invalid publish target: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}\n`,
          );
          process.exit(ExitCode.Config);
        }
        const logger = new Logger({});
        logger.info(`publishing ${runName} to ${options.to}`);
        const receipt = await publishRun(runDir, parsed.data);
        logger.info(`${receipt.type}: ${receipt.detail}`);
      } catch (err) {
        if (isCaptureKitError(err)) {
          process.stderr.write(`\nerror: ${err.message}\n`);
          if (err.hint !== undefined) process.stderr.write(`hint:  ${err.hint}\n`);
          process.exit(err.code);
        }
        process.stderr.write(`\nunexpected error: ${redactSecrets(String(err))}\n`);
        process.exit(ExitCode.CaptureFailed);
      }
    });
}

export type PublishCliOptions = {
  to?: string;
  dest?: string;
  bucket?: string;
  prefix?: string;
  endpoint?: string;
  cname?: string;
  run?: string;
  out?: string;
};
