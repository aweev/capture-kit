import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { BrowserContext, BrowserContextOptions } from 'playwright';
import { z } from 'zod';

/**
 * Auth and environment (FR-25, FR-26, FR-28).
 *
 * - Login recipe: a small module exporting `login(page)` (or a default
 *   function) that fills + submits + waits; its cookies/localStorage are saved
 *   as Playwright `storageState` and reused across viewports.
 * - Secrets (`CAPTUREKIT_*` env vars referenced as `$ENV:NAME` in config)
 *   resolve from the environment and are never written to output or logs.
 * - Custom headers, cookies, geolocation, locale, timezone ride on the context.
 */

export const SECRET_REF = /^\$ENV:([A-Z_][A-Z0-9_]*)$/;

export function resolveSecret(value: string): string {
  const m = SECRET_REF.exec(value.trim());
  if (!m) return value;
  const env = process.env[m[1] as string];
  if (env === undefined || env === '') {
    throw new Error(`Secret ${value} refers to empty or missing env var ${m[1]}.`);
  }
  return env;
}

/** Redact `password`, `token`, `secret`, `Authorization: ...` for logs. */
export function redactSecrets(text: string): string {
  return text
    .replace(/(password|passwd|secret|token|api[-_]?key)\s*[:=]\s*\S+/gi, '$1: [redacted]')
    .replace(/(Bearer\s+)[A-Za-z0-9\-._~+/=]{8,}/g, '$1[redacted]')
    .replace(/(\$ENV:[A-Z_][A-Z0-9_]*)/g, '[env-secret]');
}

export const authSchema = z
  .object({
    /** Path to a recipe module exporting `login(page)` or a default function. */
    recipe: z.string().min(1).optional(),
    /** Where to persist Playwright storageState (reused across viewports). */
    storageState: z.string().min(1).default('.auth/state.json'),
    headers: z.record(z.string(), z.string()).default({}),
    cookies: z
      .array(
        z
          .object({
            name: z.string(),
            value: z.string(),
            domain: z.string().optional(),
            path: z.string().optional(),
          })
          .strict(),
      )
      .default([]),
    locale: z.string().min(1).optional(),
    timezone: z.string().min(1).optional(),
    geolocation: z.object({ latitude: z.number(), longitude: z.number() }).strict().optional(),
  })
  .strict();

export type AuthConfig = z.infer<typeof authSchema>;

export type ResolvedAuth = {
  storageStatePath?: string;
  headers: Record<string, string>;
  cookies: { name: string; value: string; domain?: string; path?: string }[];
  locale?: string;
  timezone?: string;
  geolocation?: { latitude: number; longitude: number };
  hasRecipe: boolean;
};

/** Resolve `$ENV:NAME` refs; throws on missing secrets (fail fast, FR-26). */
export function resolveAuth(raw: AuthConfig | undefined, cwd: string): ResolvedAuth {
  if (!raw) return { headers: {}, cookies: [], hasRecipe: false };
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw.headers)) headers[k] = resolveSecret(v);
  const cookies = raw.cookies.map((c) => ({ ...c, value: resolveSecret(c.value) }));
  return {
    ...(raw.storageState ? { storageStatePath: path.resolve(cwd, raw.storageState) } : {}),
    headers,
    cookies,
    ...(raw.locale ? { locale: raw.locale } : {}),
    ...(raw.timezone ? { timezone: raw.timezone } : {}),
    ...(raw.geolocation ? { geolocation: raw.geolocation } : {}),
    hasRecipe: raw.recipe !== undefined,
  };
}

/** Load a saved storageState file if present; undefined when absent. */
export async function loadStorageState(storageStatePath?: string): Promise<string | undefined> {
  if (!storageStatePath) return undefined;
  try {
    await readFile(storageStatePath, 'utf8');
    return storageStatePath;
  } catch {
    return undefined;
  }
}

/**
 * Run the login recipe once and persist storageState. The recipe module must
 * export `login(page)` or a default async function. Called with the browser's
 * default context options; the resulting state is then attached to every
 * capture context.
 */
export async function runLoginRecipe(
  recipePath: string,
  cwd: string,
  createContext: (options: BrowserContextOptions) => Promise<BrowserContext>,
  storageStatePath: string,
): Promise<void> {
  const file = path.resolve(cwd, recipePath);
  const mod = (await import(file)) as {
    login?: (page: unknown) => Promise<void>;
    default?: (page: unknown) => Promise<void>;
  };
  const login = mod.login ?? mod.default;
  if (typeof login !== 'function') {
    throw new Error(`${recipePath} must export login(page) or a default function.`);
  }
  const context = await createContext({});
  try {
    const page = await context.newPage();
    try {
      await login(page);
    } finally {
      await page.close().catch(() => undefined);
    }
    await context.storageState({ path: storageStatePath });
  } finally {
    await context.close().catch(() => undefined);
  }
}
