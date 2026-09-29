import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { Command } from 'commander';

import { doctorCommand } from './commands/doctor.ts';
import { discoverCommand } from './commands/discover.ts';
import { initCommand } from './commands/init.ts';
import { aiCommand } from './commands/ai.ts';
import { historyCommand } from './commands/history.ts';
import { publishCommand } from './commands/publish.ts';
import { docsCommand } from './commands/docs.ts';
import { serveCommand } from './commands/serve.ts';
import { openCommand } from './commands/open.ts';
import { jsonResult, runCommand, type RunCliOptions } from './commands/run.ts';
import { startCommand, type StartCliOptions } from './commands/start.ts';
import { DEVICES } from './devices.ts';
import { isCaptureKitError, ExitCode } from './exit.ts';
import { VERSION } from './run.ts';

/**
 * CLI surface (FR-35).
 *
 * M0 ships `run`, `init`, `doctor`, `clean`; M3 adds `start` (boot, capture,
 * tear down); M4 adds `ai` (flow suggestions). `discover` and `open` arrive
 * with M1 (discovery) and the gallery. The contract with CI is fixed here: stdout carries only `--json`
 * output, all progress goes to stderr, and the exit code is meaningful
 * (FR-39).
 */
export function buildProgram(): Command {
  const program = new Command();

  program
    .name('capturekit')
    .description('Autonomous visual capture for shipped software.')
    .version(VERSION, '-V, --version', 'output the version number')
    .showHelpAfterError('Run `capturekit --help` for usage.');

  program
    .command('run')
    .description('Capture a target and write a run folder with manifest + screenshots.')
    .argument('[url]', 'target URL; overrides capture.config.ts')
    .option('--config <file>', 'path to a capture config file')
    .option('--viewport <name...>', `device profiles (${Object.keys(DEVICES).join(', ')}) or "WxH"`)
    .option('--pages <list>', 'comma-separated paths, e.g. /,/pricing')
    .option('--out <dir>', 'output root (default: captures)')
    .option('--no-config', 'ignore capture.config.* entirely')
    .option('--viewport-only', 'capture the viewport instead of the full page')
    .option('--scheme <name...>', 'color schemes: light, dark (default: light)')
    .option('--format <format>', 'image format: png, webp, jpeg (default: png)')
    .option('--frame <kind>', 'device frame: none, browser, phone, auto (default: none)')
    .option('--export-zip', 'write a ZIP bundle of the run assets')
    .option('--ai', 'enable the AI post-pass (alt text + client summary; needs a key)')
    .option('--ai-key <key>', 'API key (or $ENV:NAME) for this run')
    .option('--watch', 'recapture on file change (debounced)')
    .option('--no-video', 'skip walkthrough video recording')
    .option('--no-discover', 'capture only the explicit pages list')
    .option('--concurrency <n>', 'parallel capture contexts')
    .option('--timeout <ms>', 'per-page ready timeout')
    .option('--max-fail-rate <fraction>', 'exit non-zero above this failure rate (default 0.5)')
    .option('--json', 'print a machine-readable summary to stdout')
    .option('--quiet', 'suppress progress output (warnings and errors still print)')
    .option('--verbose', 'log every stabilization step')
    .action(async (url: string | undefined, options: RunCliOptions) => {
      if (options.watch === true) {
        const { watchAndRerun } = await import('./watch.ts');
        const once = async (): Promise<{ exitCode: number }> => {
          const result = await runCommand(url, options);
          if (options.json === true) process.stdout.write(jsonResult(result) + '\n');
          return { exitCode: result.exitCode };
        };
        await once();
        watchAndRerun(
          { outDir: options.out ?? 'captures' },
          once,
          {
            onChange: (file) => process.stderr.write(`changed ${file}; recapturing…\n`),
            onResult: (exitCode) => process.stderr.write(`recapture exit ${exitCode}\n`),
            onError: (err) => process.stderr.write(`recapture failed: ${err.message}\n`),
          },
        );
        process.stderr.write('watching for changes (Ctrl+C to stop)…\n');
        return;
      }
      const result = await runCommand(url, options);
      if (options.json === true) process.stdout.write(jsonResult(result) + '\n');
      process.exit(result.exitCode);
    });

  program
    .command('start')
    .description('Boot the app, wait for it, capture, then tear it down.')
    .argument('[url]', 'target URL; overrides capture.config.ts')
    .option('--config <file>', 'path to a capture config file')
    .option('--start-command <cmd>', 'shell command that boots the app')
    .option('--wait-on <url>', 'health URL to poll until the app is reachable')
    .option('--start-timeout <ms>', 'ceiling for the app to become reachable')
    .option('--viewport <name...>', `device profiles (${Object.keys(DEVICES).join(', ')}) or "WxH"`)
    .option('--pages <list>', 'comma-separated paths, e.g. /,/pricing')
    .option('--out <dir>', 'output root (default: captures)')
    .option('--no-config', 'ignore capture.config.* entirely')
    .option('--viewport-only', 'capture the viewport instead of the full page')
    .option('--scheme <name...>', 'color schemes: light, dark (default: light)')
    .option('--format <format>', 'image format: png, webp, jpeg (default: png)')
    .option('--frame <kind>', 'device frame: none, browser, phone, auto (default: none)')
    .option('--export-zip', 'write a ZIP bundle of the run assets')
    .option('--ai', 'enable the AI post-pass (alt text + client summary; needs a key)')
    .option('--ai-key <key>', 'API key (or $ENV:NAME) for this run')
    .option('--no-video', 'skip walkthrough video recording')
    .option('--no-discover', 'capture only the explicit pages list')
    .option('--concurrency <n>', 'parallel capture contexts')
    .option('--timeout <ms>', 'per-page ready timeout')
    .option('--max-fail-rate <fraction>', 'exit non-zero above this failure rate (default 0.5)')
    .option('--json', 'print a machine-readable summary to stdout')
    .option('--quiet', 'suppress progress output (warnings and errors still print)')
    .option('--verbose', 'log every stabilization step')
    .action(async (url: string | undefined, options: StartCliOptions) => {
      const result = await startCommand(url, options);
      if (options.json === true) process.stdout.write(jsonResult(result) + '\n');
      process.exit(result.exitCode);
    });

  program
    .command('init')
    .description('Write a documented capture.config.ts in the current folder.')
    .option('--force', 'overwrite an existing config file')
    .action(async (options: { force?: boolean }) => {
      const file = await initCommand(process.cwd(), options.force === true);
      process.stderr.write(`wrote ${file}\nnext: capturekit run\n`);
    });

  program
    .command('doctor')
    .description('Check Node, the browser, and viewport profiles; provision what is missing.')
    .option('--install', 'download Chromium if it is missing')
    .option('--json', 'print checks as JSON')
    .action(async (options: { install?: boolean; json?: boolean }) => {
      const report = await doctorCommand(options);
      if (options.json === true) {
        process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      } else {
        for (const check of report.checks) {
          const mark = check.ok ? 'ok  ' : 'FAIL';
          process.stderr.write(`${mark} ${check.name.padEnd(10)} ${check.detail}\n`);
          if (!check.ok && check.fix !== undefined)
            process.stderr.write(`       -> ${check.fix}\n`);
        }
      }
      process.exit(report.ok ? 0 : ExitCode.Environment);
    });

  program
    .command('clean')
    .description('Remove run folders from the output root.')
    .option('--out <dir>', 'output root (default: captures)')
    .option('--keep <n>', 'keep the newest n runs', '0')
    .action(async (options: { out?: string; keep: string }) => {
      const { cleanRuns } = await import('./clean.ts');
      const removed = await cleanRuns({
        outDir: options.out ?? 'captures',
        keep: Math.max(0, Number(options.keep) || 0),
      });
      process.stderr.write(
        `removed ${removed.length} run folder${removed.length === 1 ? '' : 's'}\n`,
      );
      for (const dir of removed) process.stderr.write(`  ${dir}\n`);
    });

  discoverCommand(program);
  aiCommand(program);
  openCommand(program);
  historyCommand(program);
  publishCommand(program);
  docsCommand(program);
  serveCommand(program);

  return program;
}

/** Top-level error handling: a sentence and a hint, never a stack trace. */
export async function main(argv: string[] = process.argv): Promise<void> {
  const program = buildProgram();
  try {
    await program.parseAsync(argv);
  } catch (err) {
    if (isCaptureKitError(err)) {
      process.stderr.write(`\nerror: ${err.message}\n`);
      if (err.hint !== undefined) process.stderr.write(`hint:  ${err.hint}\n`);
      process.exit(err.code);
    }
    process.stderr.write(`\nunexpected error: ${String(err)}\n`);
    process.stderr.write(
      'hint:  re-run with --verbose, or `capturekit doctor` to check your setup\n',
    );
    process.exit(ExitCode.CaptureFailed);
  }
}

/**
 * Runs when executed directly (`node src/cli.ts`, or via `bin/capturekit.mjs`),
 * and stays inert when imported as a library.
 */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
