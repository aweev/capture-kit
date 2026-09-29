import { Command } from 'commander';

import { discoverPages } from '../discover.ts';
import { buildConfig } from '../config.ts';
import { isCaptureKitError, ExitCode } from '../exit.ts';
import { Logger } from '../log.ts';

/**
 * `capturekit discover` (FR-35).
 *
 * Lists discovered pages without capturing them. Useful for debugging
 * discovery and verifying what will be captured.
 */
export function discoverCommand(program: Command): Command {
  return program
    .command('discover')
    .description('Discover pages for a target without capturing.')
    .argument('[url]', 'target URL; overrides capture.config.ts')
    .option('--config <file>', 'path to a capture config file')
    .option('--no-config', 'ignore capture.config.* entirely')
    .option('--depth <n>', 'max crawl depth (default: 2)', '2')
    .option('--max-pages <n>', 'max pages to discover (default: 20)', '20')
    .option('--include <globs...>', 'include glob patterns')
    .option('--exclude <globs...>', 'exclude glob patterns')
    .option('--json', 'print machine-readable JSON to stdout')
    .action(async (url: string | undefined, options: DiscoverCliOptions) => {
      try {
        const config = await buildConfig({
          url,
          config: options.config,
          noConfig: options.noConfig === true,
          cwd: process.cwd(),
        });

        const logger = new Logger({ level: options.json ? 'warn' : 'info' });

        const result = await discoverPages({
          base: config.base,
          configPages: config.pages,
          include: options.include || [],
          exclude: options.exclude || [],
          maxDepth: Number(options.depth),
          maxPages: Number(options.maxPages),
        });

        if (options.json) {
          process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        } else {
          logger.info(`Discovered ${result.pages.length} page(s) for ${config.target}`);
          for (const page of result.pages) {
            const detail = result.discovered.find((d) => d.path === page);
            const source = detail?.source ?? 'config';
            const priority = detail?.priority ?? 100;
            logger.info(`  ${page} (${source}, priority: ${priority})`);
          }
          if (result.skipped.length > 0) {
            logger.warn(`${result.skipped.length} page(s) skipped`);
            for (const skip of result.skipped) {
              logger.warn(`  ${skip.path} — ${skip.reason}`);
            }
          }
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

export type DiscoverCliOptions = {
  config?: string;
  noConfig?: boolean;
  depth?: string;
  maxPages?: string;
  include?: string[];
  exclude?: string[];
  json?: boolean;
};
