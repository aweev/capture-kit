import type { Page } from 'playwright';
import { z } from 'zod';

/**
 * Scripted flows (FR-21).
 *
 * A flow is a named list of steps that drive the page before (or during) a
 * capture: `goto`, `click`, `fill`, `hover`, `press`, `waitFor`, `scroll`.
 * Steps are validated with Zod at config load so a typo fails fast with a
 * config error (exit 3), not mid-run. Execution is sequential and best-effort
 * per step with a clear error naming the step index — Principle 2 still holds:
 * a failed flow fails its jobs with a reason, never the whole run.
 */

const stepSchemas = {
  goto: z.object({ goto: z.string().min(1) }).strict(),
  click: z
    .object({ click: z.string().min(1), timeoutMs: z.number().int().min(0).max(60000).optional() })
    .strict(),
  fill: z
    .object({
      fill: z.string().min(1),
      text: z.string(),
      timeoutMs: z.number().int().min(0).max(60000).optional(),
    })
    .strict(),
  hover: z
    .object({ hover: z.string().min(1), timeoutMs: z.number().int().min(0).max(60000).optional() })
    .strict(),
  press: z.object({ press: z.string().min(1), key: z.string().min(1) }).strict(),
  waitFor: z
    .object({
      waitFor: z.string().min(1),
      timeoutMs: z.number().int().min(0).max(120000).optional(),
    })
    .strict(),
  scroll: z
    .object({
      scroll: z.enum(['bottom', 'top']).or(z.object({ y: z.number().int() })),
    })
    .strict(),
} as const;

export const flowStepSchema = z.union([
  stepSchemas.goto,
  stepSchemas.click,
  stepSchemas.fill,
  stepSchemas.hover,
  stepSchemas.press,
  stepSchemas.waitFor,
  stepSchemas.scroll,
]);

export type FlowStep = z.infer<typeof flowStepSchema>;

export const flowSchema = z
  .object({
    name: z.string().min(1).max(80),
    steps: z.array(flowStepSchema).min(1).max(50),
    /** Capture a screenshot after the flow; false means video/flows-only use. */
    capture: z.boolean().default(true),
  })
  .strict();

export type Flow = z.infer<typeof flowSchema>;

/** Visible cursor + click ripple shown during flow execution (optional). */
export const CURSOR_CSS = `
.capturekit-cursor {
  position: fixed; width: 18px; height: 18px; border-radius: 50%;
  background: rgba(15, 98, 254, 0.9); border: 2px solid #fff;
  box-shadow: 0 1px 6px rgba(0,0,0,0.4); z-index: 2147483647;
  pointer-events: none; transition: left 120ms linear, top 120ms linear;
}
.capturekit-ripple {
  position: fixed; width: 36px; height: 36px; border-radius: 50%;
  border: 3px solid rgba(15, 98, 254, 0.8); z-index: 2147483647;
  pointer-events: none; animation: capturekit-ripple 450ms ease-out forwards;
}
@keyframes capturekit-ripple { from { transform: scale(0.4); opacity: 1; } to { transform: scale(1.4); opacity: 0; } }
`;

export async function showCursor(page: Page): Promise<void> {
  await page
    .evaluate((css: string) => {
      if (document.getElementById('capturekit-cursor-style')) return;
      const style = document.createElement('style');
      style.id = 'capturekit-cursor-style';
      style.textContent = css;
      document.head.appendChild(style);
      const dot = document.createElement('div');
      dot.className = 'capturekit-cursor';
      dot.id = 'capturekit-cursor';
      dot.style.left = '0px';
      dot.style.top = '0px';
      document.body.appendChild(dot);
    }, CURSOR_CSS)
    .catch(() => undefined);
}

async function moveCursor(page: Page, selector: string): Promise<void> {
  await page
    .evaluate((sel: string) => {
      const el = document.querySelector(sel);
      const dot = document.getElementById('capturekit-cursor');
      if (!el || !dot) return;
      const r = el.getBoundingClientRect();
      dot.style.left = `${r.x + r.width / 2 - 9}px`;
      dot.style.top = `${r.y + r.height / 2 - 9}px`;
      const ripple = document.createElement('div');
      ripple.className = 'capturekit-ripple';
      ripple.style.left = `${r.x + r.width / 2 - 18}px`;
      ripple.style.top = `${r.y + r.height / 2 - 18}px`;
      document.body.appendChild(ripple);
      setTimeout(() => ripple.remove(), 500);
    }, selector)
    .catch(() => undefined);
}

export type FlowOptions = {
  base: URL;
  showCursor?: boolean;
  defaultTimeoutMs?: number;
};

/**
 * Run a flow's steps against an already-open page. Resolves page-relative
 * `goto` targets against the run's base URL so flows stay portable across
 * localhost / preview / production.
 */
export async function runFlowSteps(
  page: Page,
  flow: Flow,
  options: FlowOptions,
  warn: (message: string, fields?: Record<string, unknown>) => void = () => undefined,
): Promise<void> {
  if (options.showCursor === true) await showCursor(page);
  for (let i = 0; i < flow.steps.length; i++) {
    const step = flow.steps[i] as FlowStep;
    const label = `flow ${JSON.stringify(flow.name)} step ${i + 1}/${flow.steps.length}`;
    try {
      if ('goto' in step) {
        const url = new URL(step.goto, options.base).toString();
        await page.goto(url, { waitUntil: 'load', timeout: options.defaultTimeoutMs ?? 20000 });
      } else if ('click' in step) {
        if (options.showCursor === true) await moveCursor(page, step.click);
        await page.click(step.click, {
          timeout: step.timeoutMs ?? options.defaultTimeoutMs ?? 10000,
        });
      } else if ('fill' in step) {
        if (options.showCursor === true) await moveCursor(page, step.fill);
        await page.fill(step.fill, step.text, {
          timeout: step.timeoutMs ?? options.defaultTimeoutMs ?? 10000,
        });
      } else if ('hover' in step) {
        if (options.showCursor === true) await moveCursor(page, step.hover);
        await page.hover(step.hover, {
          timeout: step.timeoutMs ?? options.defaultTimeoutMs ?? 10000,
        });
      } else if ('press' in step) {
        await page
          .locator(step.press)
          .press(step.key, { timeout: options.defaultTimeoutMs ?? 10000 });
      } else if ('waitFor' in step) {
        const sel = step.waitFor;
        if (sel.startsWith('text=') || sel.startsWith('/') || sel.includes('>>')) {
          await page
            .locator(sel)
            .first()
            .waitFor({ timeout: step.timeoutMs ?? 10000 });
        } else {
          await page.waitForSelector(sel, { timeout: step.timeoutMs ?? 10000 });
        }
      } else if ('scroll' in step) {
        if (step.scroll === 'bottom') {
          await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        } else if (step.scroll === 'top') {
          await page.evaluate(() => window.scrollTo(0, 0));
        } else {
          const y = (step.scroll as { y: number }).y;
          await page.evaluate((yy: number) => window.scrollTo(0, yy), y);
        }
        await page.waitForTimeout(250).catch(() => undefined);
      }
    } catch (err) {
      throw new Error(`${label} failed: ${(err as Error).message}`);
    }
    warn(`${label} ok`);
  }
}

/** Flow names must be unique and filename-safe; validated at config load. */
export function flowSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'flow'
  );
}
