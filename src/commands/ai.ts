import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Command } from 'commander';

import { buildConfig } from '../config.ts';
import { isCaptureKitError, ExitCode } from '../exit.ts';
import { resolveApiKey } from '../ai-client.ts';
import { suggestFlows } from '../ai-flows.ts';
import { redactSecrets } from '../auth.ts';
import { Logger } from '../log.ts';

/**
 * `capturekit ai` (FR-40).
 *
 * Drafts flow configs from a plain-English goal. The suggestions are validated
 * and written to `flows.suggested.json` for review — never applied. Requires
 * an API key (`ai.apiKey` or `--ai-key`); without one it fails fast with
 * instructions instead of a silent no-op.
 */
export function aiCommand(program: Command): Command {
  return program
    .command('ai')
    .description('Draft flow configs from a plain-English goal (review before use).')
    .argument('<goal>', 'what to show, e.g. "show signup and dashboard"')
    .argument('[url]', 'site to target; overrides capture.config.ts')
    .option('--config <file>', 'path to a capture config file')
    .option('--no-config', 'ignore capture.config.* entirely')
    .option('--pages <list>', 'comma-separated known pages, e.g. /,/pricing')
    .option('--out <file>', 'where to write suggestions (default: flows.suggested.json)')
    .option('--ai-key <key>', 'API key (or $ENV:NAME); overrides config')
    .option('--model <name>', 'model override for this call')
    .action(async (goal: string, url: string | undefined, options: AiCliOptions) => {
      try {
        const config = await buildConfig({
          url,
          config: options.config,
          noConfig: options.noConfig === true,
          pages: options.pages,
          ...(options.aiKey ? { aiKey: options.aiKey } : {}),
          cwd: process.cwd(),
        });
        const ai = {
          ...config.ai,
          enabled: true,
          ...(options.aiKey ? { apiKey: options.aiKey } : {}),
          ...(options.model ? { model: options.model } : {}),
        };
        try {
          resolveApiKey(ai);
        } catch {
          process.stderr.write('\nerror: AI needs an API key.\n');
          process.stderr.write(
            'hint:  set `ai: { enabled: true, apiKey: "$ENV:OPENAI_API_KEY" }` or pass --ai-key\n',
          );
          process.exit(ExitCode.Config);
        }
        const logger = new Logger({});
        logger.info(`drafting flows for "${goal}" on ${config.target}`);
        const flows = await suggestFlows(ai, {
          url: config.target,
          goal,
          pages: config.pages,
        });
        const dest = options.out
          ? path.resolve(process.cwd(), options.out)
          : path.join(process.cwd(), 'flows.suggested.json');
        await writeFile(dest, JSON.stringify({ flows }, null, 2) + '\n', 'utf8');
        logger.info(`wrote ${flows.length} suggested flow(s) to ${dest}`);
        logger.info('review, copy what you want into `flows:` in capture.config.ts');
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

export type AiCliOptions = {
  config?: string;
  noConfig?: boolean;
  pages?: string;
  out?: string;
  aiKey?: string;
  model?: string;
};
