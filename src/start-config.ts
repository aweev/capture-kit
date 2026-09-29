import { z } from 'zod';

/**
 * `start` config schema (FR-27). Lives in a leaf module so `config.ts` can
 * import it without a cycle (`start.ts` pulls in `run.ts`, which pulls in
 * `config.ts`).
 */
export const startSchema = z
  .object({
    /** Shell command that boots the app, e.g. `npm run dev`. */
    command: z.string().min(1),
    /** Health URL to poll until the app accepts connections. */
    waitOn: z.string().url(),
    /** Ceiling for the app to become reachable. */
    timeoutMs: z.number().int().min(1000).max(600000).default(60000),
    /** Poll interval while waiting. */
    intervalMs: z.number().int().min(100).max(10000).default(500),
    /** Working directory for the command. Defaults to the caller cwd. */
    cwd: z.string().min(1).optional(),
    /** Extra env for the child (merged over process.env, never logged). */
    env: z.record(z.string(), z.string()).default({}),
  })
  .strict();

export type StartConfig = z.infer<typeof startSchema>;
