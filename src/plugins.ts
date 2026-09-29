import path from 'node:path';
import { z } from 'zod';

/**
 * Plugin surface (M5, PRD section 8).
 *
 * Extensions never touch the core: a plugin is a JS/MJS/TS module (imported
 * directly, no build step — same loader as config files) exporting any subset
 * of hooks:
 *
 * - `discoverer`: extra page sources — `(context) => string[] | Promise<string[]>`
 * - `stabilizer`: extra ready steps — `(page) => void | Promise<void>`
 * - `postprocessor`: per-file transforms after capture — `(file) => void | Promise<void>`
 * - `publisher`: extra publish targets — `(runDir, target) => { type, detail } | Promise<...>`
 *
 * `plugins: ["./my-plugin.mjs"]` in config. Hook failures are caught per
 * plugin and logged as warnings; a broken plugin never fails a run.
 */

export const pluginSchema = z.array(z.string().min(1)).max(10).default([]);

export type DiscoverContext = { target: string; base: URL; pages: string[] };
export type StabilizerPage = { addStyleTag: (options: { content?: string }) => Promise<unknown> };
export type PublishReceipt = { type: string; detail: string };

export type PluginHooks = {
  name?: string;
  discoverer?: (context: DiscoverContext) => string[] | Promise<string[]>;
  stabilizer?: (page: StabilizerPage) => void | Promise<void>;
  postprocessor?: (file: string) => void | Promise<void>;
  publisher?: (runDir: string, target: { type: string }) => PublishReceipt | Promise<PublishReceipt>;
};

export type LoadedPlugin = { name: string; path: string; hooks: PluginHooks };

/** Load and validate plugin modules. Invalid ones throw (config error). */
export async function loadPlugins(paths: string[], cwd: string): Promise<LoadedPlugin[]> {
  const loaded: LoadedPlugin[] = [];
  for (const entry of paths) {
    const file = path.resolve(cwd, entry);
    let module: Record<string, unknown>;
    try {
      module = (await import(file)) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`Could not load plugin ${entry}: ${(err as Error).message}`);
    }
    const exported = (module.default ?? module) as PluginHooks;
    if (typeof exported !== 'object' || exported === null) {
      throw new Error(`Plugin ${entry} has no usable export.`);
    }
    for (const hook of ['discoverer', 'stabilizer', 'postprocessor', 'publisher'] as const) {
      if (exported[hook] !== undefined && typeof exported[hook] !== 'function') {
        throw new Error(`Plugin ${entry}: hook ${hook} must be a function.`);
      }
    }
    loaded.push({
      name: typeof exported.name === 'string' ? exported.name : path.basename(entry),
      path: file,
      hooks: exported,
    });
  }
  return loaded;
}

/** Run every plugin's postprocessor over captured files. Best-effort per plugin. */
export async function applyPostprocessors(
  plugins: LoadedPlugin[],
  files: string[],
  warn: (message: string, fields?: Record<string, unknown>) => void = () => undefined,
): Promise<void> {
  for (const plugin of plugins) {
    if (!plugin.hooks.postprocessor) continue;
    try {
      for (const file of files) {
        await plugin.hooks.postprocessor(file);
      }
    } catch (err) {
      warn(`plugin ${plugin.name} postprocessor failed; continuing`, {
        error: (err as Error).message,
      });
    }
  }
}

/** Extra discoverer sources, merged with discovery results by the caller. */
export async function applyDiscoverers(
  plugins: LoadedPlugin[],
  context: DiscoverContext,
  warn: (message: string, fields?: Record<string, unknown>) => void = () => undefined,
): Promise<string[]> {
  const pages: string[] = [];
  for (const plugin of plugins) {
    if (!plugin.hooks.discoverer) continue;
    try {
      const found = await plugin.hooks.discoverer(context);
      pages.push(...found);
    } catch (err) {
      warn(`plugin ${plugin.name} discoverer failed; continuing`, {
        error: (err as Error).message,
      });
    }
  }
  return pages;
}
