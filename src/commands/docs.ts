import { Command } from 'commander';

import { isCaptureKitError, ExitCode } from '../exit.ts';
import { buildDocsSite } from '../docs-site.ts';
import { Logger } from '../log.ts';

/**
 * `capturekit docs` (M5 reach).
 *
 * Builds a small static site from `docs/*.md` — shippable anywhere static
 * files go, or publishable with `capturekit publish`.
 */
export function docsCommand(program: Command): Command {
  return program
    .command('docs')
    .description('Build a static site from docs/*.md.')
    .option('--docs <dir>', 'docs directory (default: ./docs)')
    .option('--out <dir>', 'site output directory (default: ./site)')
    .action(async (options: DocsCliOptions) => {
      try {
        const result = await buildDocsSite({
          ...(options.docs ? { docsDir: options.docs } : {}),
          outDir: options.out ?? './site',
        });
        const logger = new Logger({});
        logger.info(`built ${result.pages.length} page(s) in ${result.outDir}`);
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

export type DocsCliOptions = {
  docs?: string;
  out?: string;
};
