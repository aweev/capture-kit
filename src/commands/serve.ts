import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Command } from 'commander';

import { ExitCode } from '../exit.ts';
import { runCommand, type RunCliOptions } from './run.ts';
import { redactSecrets } from '../auth.ts';
import { Logger } from '../log.ts';

/**
 * `capturekit serve` (FR-38).
 *
 * Webhook trigger endpoint for deploy hooks (Vercel, Netlify): POST /hook
 * runs a capture with the server's startup options, GET /health reports
 * liveness. Requests are serialized — a capture in flight makes /hook answer
 * 409 instead of stacking work. An optional shared secret (`--secret` or
 * `?secret=`) rejects strangers with 401.
 */
export function serveCommand(program: Command): Command {
  return program
    .command('serve')
    .description('Run a webhook endpoint that captures on deploy hooks.')
    .option('--port <n>', 'listen port', '4311')
    .option('--secret <value>', 'shared webhook secret ($ENV:NAME or literal)')
    .option('--config <file>', 'capture config file for triggered runs')
    .option('--pages <list>', 'comma-separated paths for triggered runs')
    .option('--out <dir>', 'output root (default: captures)')
    .action(async (options: ServeCliOptions) => {
      const logger = new Logger({});
      const port = Number(options.port ?? 4311);
      const secret = options.secret ? redactResolve(options.secret) : undefined;
      let busy = false;
      const server = createServer((req, res) => {
        void handleHook(req, res, {
          secret,
          busy: () => busy,
          capture: async () => {
            busy = true;
            try {
              const result = await runCommand(undefined, {
                config: options.config,
                pages: options.pages,
                out: options.out,
              } satisfies RunCliOptions);
              return result.exitCode;
            } finally {
              busy = false;
            }
          },
          log: (message: string) => logger.info(message),
        }).catch((err: Error) => {
          logger.info(`hook failed: ${redactSecrets(err.message)}`);
          if (!res.headersSent) {
            res.writeHead(500).end('capture failed');
          }
        });
      });
      server.listen(port, '127.0.0.1', () => {
        logger.info(`webhook listening on http://127.0.0.1:${port} (POST /hook)`);
      });
      const shutdown = () => {
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 3000).unref();
      };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
    });
}

function redactResolve(value: string): string {
  if (/^\$ENV:[A-Z_][A-Z0-9_]*$/.test(value.trim())) {
    const env = process.env[value.trim().slice(5)];
    if (!env) {
      process.stderr.write(`\nerror: secret ${value} refers to a missing env var.\n`);
      process.exit(ExitCode.Config);
    }
    return env;
  }
  return value;
}

export type ServeDeps = {
  secret?: string;
  busy: () => boolean;
  capture: () => Promise<number>;
  log: (message: string) => void;
};

/** One webhook request. Exported for tests (no sockets needed). */
export async function handleHook(
  req: IncomingMessage & { url?: string; method?: string; headers?: Record<string, string | string[] | undefined> },
  res: ServerResponse,
  deps: ServeDeps,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    return;
  }
  if (req.method !== 'POST' || url.pathname !== '/hook') {
    res.writeHead(404).end('not found');
    return;
  }
  if (deps.secret) {
    const provided =
      url.searchParams.get('secret') ??
      (typeof req.headers?.authorization === 'string'
        ? req.headers.authorization.replace(/^Bearer\s+/i, '')
        : undefined);
    if (provided !== deps.secret) {
      res.writeHead(401).end('unauthorized');
      return;
    }
  }
  if (deps.busy()) {
    res.writeHead(409).end('capture already running');
    return;
  }
  deps.log('webhook triggered capture');
  const exitCode = await deps.capture();
  res.writeHead(exitCode === 0 ? 200 : 500, { 'content-type': 'text/plain' }).end(
    exitCode === 0 ? 'captured' : 'captured with failures',
  );
}

export type ServeCliOptions = {
  port?: string;
  secret?: string;
  config?: string;
  pages?: string;
  out?: string;
};
