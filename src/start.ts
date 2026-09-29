import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';

import { run, type RunOptions, type RunResult } from './run.ts';
import { CaptureKitError, ExitCode } from './exit.ts';
import type { StartConfig } from './start-config.ts';

export type { StartConfig } from './start-config.ts';

const execFileAsync = promisify(execFile);

/**
 * `capturekit start` (FR-27).
 *
 * Boots the app (`start.command`), waits for a health URL (`start.waitOn`),
 * runs the capture, then tears the app down — so CI needs no separate
 * "start server" step. Any HTTP response from the health URL counts as up;
 * only connection/refusal errors keep the waiter polling.
 */

export type StartOptions = RunOptions & {
  startCommand?: string;
  waitOn?: string;
  startTimeoutMs?: number;
};

/** Poll a URL until any HTTP response arrives or the budget runs out. */
export async function waitForHealth(
  url: string,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 60000;
  const intervalMs = options.intervalMs ?? 500;
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no attempt made';
  for (;;) {
    try {
      // Any HTTP response (even 404/500) proves the server is listening.
      await fetch(url, { redirect: 'manual' });
      return;
    } catch (err) {
      lastError = (err as Error).message;
    }
    if (Date.now() >= deadline) {
      throw new CaptureKitError(
        `App did not become reachable at ${url} within ${timeoutMs}ms: ${lastError}.`,
        ExitCode.Environment,
        'Check that `start.command` boots the app and `start.waitOn` points at it.',
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Spawn the app detached so the whole process group can be torn down. */
export function spawnApp(
  command: string,
  options: { cwd?: string; env?: Record<string, string> } = {},
): ChildProcess {
  const child = spawn(command, {
    shell: true,
    detached: process.platform !== 'win32',
    cwd: options.cwd ?? process.cwd(),
    env: { ...process.env, ...options.env },
    stdio: 'ignore',
    windowsHide: true,
  });
  return child;
}

/**
 * Tree-aware kill: with `shell: true` the child PID is a shell (cmd.exe on
 * Windows, sh on POSIX) and killing it orphans the real app. POSIX children
 * are spawned detached so the negative-PID group kill reaches the whole tree;
 * on Windows `taskkill /T` does the equivalent.
 */
async function killTree(child: ChildProcess, signal: 'SIGTERM' | 'SIGKILL'): Promise<void> {
  if (child.pid === undefined) {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
    return;
  }
  if (process.platform === 'win32') {
    try {
      // /T kills the whole tree (the shell plus the app under it).
      await execFileAsync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
      return;
    } catch {
      /* fall through to direct kill */
    }
  } else {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      /* fall through to direct kill */
    }
  }
  try {
    child.kill(signal);
  } catch {
    /* already gone */
  }
}

/** True once the process has exited (checked first: the event may already have fired). */
function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(hasExited(child));
    }, ms);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}

/** SIGTERM the tree, SIGKILL stragglers. Never throws: teardown runs in `finally`. */
export async function teardownApp(child: ChildProcess | undefined): Promise<void> {
  if (!child || hasExited(child)) return;
  await killTree(child, 'SIGTERM');
  if (!(await waitExit(child, 5000))) {
    await killTree(child, 'SIGKILL');
  }
}

/**
 * Boot, wait, capture, tear down. The capture runs even if `target` differs
 * from `waitOn` (e.g. health endpoint vs. public URL) — `waitOn` only gates.
 */
export async function startAndCapture(
  start: StartConfig,
  runOptions: RunOptions,
  deps: {
    wait?: typeof waitForHealth;
    spawn?: typeof spawnApp;
    teardown?: typeof teardownApp;
    capture?: typeof run;
  } = {},
): Promise<RunResult> {
  const wait = deps.wait ?? waitForHealth;
  const spawnFn = deps.spawn ?? spawnApp;
  const teardown = deps.teardown ?? teardownApp;
  const capture = deps.capture ?? run;

  const child = spawnFn(start.command, {
    ...(start.cwd ? { cwd: start.cwd } : {}),
    env: start.env,
  });
  const spawnError = await new Promise<string | null>((resolve) => {
    if (child.exitCode !== null) {
      resolve(`exited immediately with code ${child.exitCode}`);
      return;
    }
    const timer = setTimeout(() => resolve(null), 500);
    child.once('error', (err) => {
      clearTimeout(timer);
      resolve((err as Error).message);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(`exited with code ${code ?? 'null'} before the health check passed`);
    });
  });
  if (spawnError !== null) {
    await teardown(child);
    throw new CaptureKitError(
      `Could not boot the app (${spawnError}).`,
      ExitCode.Environment,
      'Check that `start.command` runs from the right directory.',
    );
  }

  try {
    await wait(start.waitOn, { timeoutMs: start.timeoutMs, intervalMs: start.intervalMs });
    return await capture(runOptions);
  } finally {
    await teardown(child);
  }
}
