import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';

/**
 * Watch mode (FR-36): recapture affected pages on file change, debounced.
 *
 * Watches the working directory (minus the output root, node_modules, and
 * dotfiles) and re-invokes the capture. Serial by design: a run in flight
 * suppresses overlapping triggers and one trailing rerun catches everything
 * that changed meanwhile.
 */

export type WatchOptions = {
  /** Directory to watch. Defaults to the caller cwd. */
  watchPath?: string;
  /** Output root to ignore (plus node_modules and dotfiles, always ignored). */
  outDir?: string;
  /** Quiet period before a rerun fires. */
  debounceMs?: number;
};

function ignoredBilge(file: string, outDir: string): boolean {
  const base = path.basename(file);
  if (base.startsWith('.') || base === 'node_modules') return true;
  const rel = path.relative(process.cwd(), file);
  const out = path.relative(process.cwd(), path.resolve(outDir));
  return rel === out || rel.startsWith(`${out}${path.sep}`);
}

export function watchAndRerun(  options: WatchOptions,
  rerun: () => Promise<{ exitCode: number }>,
  events: {
    onChange?: (file: string) => void;
    onResult?: (exitCode: number) => void;
    onError?: (err: Error) => void;
  } = {},
): { stop: () => void } {
  const watchPath = path.resolve(options.watchPath ?? process.cwd());
  const outDir = options.outDir ?? 'captures';
  const debounceMs = options.debounceMs ?? 1000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let trailing = false;
  let stopped = false;

  const fire = () => {
    if (stopped) return;
    if (running) {
      trailing = true;
      return;
    }
    running = true;
    rerun().then(
      (result) => {
        running = false;
        events.onResult?.(result.exitCode);
        if (trailing && !stopped) {
          trailing = false;
          schedule();
        }
      },
      (err: Error) => {
        running = false;
        events.onError?.(err);
      },
    );
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(fire, debounceMs);
  };

  const watcher: FSWatcher = watch(watchPath, { recursive: true }, (_event, filename) => {
    const file = filename ? path.join(watchPath, filename.toString()) : watchPath;
    if (ignoredBilge(file, outDir)) return;
    events.onChange?.(file);
    schedule();
  });

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      watcher.close();
    },
  };
}
