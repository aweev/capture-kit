import type { Page } from 'playwright';

import type { ResolvedConfig } from './config.ts';

/**
 * Stabilization (FR-12, FR-13, FR-14).
 *
 * This is the half of capturekit that decides whether a capture can be trusted.
 * A screenshot taken one frame too early is worse than none: it looks fine in a
 * gallery and is wrong forever. A page is only "ready" when several independent
 * signals all agree, and each signal degrades to a warning rather than a hard
 * failure (Principle 2: never fail wholly).
 */

/**
 * CSS that stops motion (FR-14). `!important` and the universal selectors are
 * deliberate: page CSS must lose every specificity fight, otherwise a hero
 * animation renders mid-transition and the frame is unusable.
 */
export const FREEZE_CSS = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
    scroll-behavior: auto !important;
  }
  html { animation: none !important; }
`;

/** How aggressive to be. Higher retry rungs wait longer and give up earlier. */
export type WaitStrategy = 'standard' | 'patient' | 'fallback';

export const MULTIPLIER: Record<WaitStrategy, number> = {
  standard: 1,
  patient: 1.75,
  fallback: 2.5,
};

export const STRATEGY_LABEL: Record<WaitStrategy, string> = {
  standard: 'standard waits',
  patient: 'longer settle + scroll warm-up',
  fallback: 'cache cleared + domcontentloaded',
};

/**
 * Wait until the page has settled.
 *
 * Order matters: navigation-level signals first (network, fonts, images), DOM
 * quiescence last, because quiescence is what proves the earlier signals were
 * not merely lucky.
 */
export async function stabilize(
  page: Page,
  config: ResolvedConfig,
  strategy: WaitStrategy,
  warn: (message: string, fields?: Record<string, unknown>) => void,
  /** FR-11: a page may widen or narrow the ready budget for itself. */
  override: { timeoutMs?: number } = {},
): Promise<void> {
  const rules = config.stabilize;
  const budget = Math.round((override.timeoutMs ?? rules.timeoutMs) * MULTIPLIER[strategy]);
  // FR-14: 'settle' leaves animation running and waits for it to stop by
  // itself; 'freeze' kills it up front. `disableAnimations: false` is the
  // long-standing shorthand for settle, so either switch turns it on.
  const settle = rules.settleMode === 'settle' || rules.disableAnimations === false;
  const freezeCss = !settle;

  // Kill motion before anything else, so we never spend the budget watching an
  // infinite carousel.
  if (freezeCss) {
    await page.addStyleTag({ content: FREEZE_CSS }).catch(() => {
      warn('could not inject animation freeze; page may render mid-motion');
    });
  }

  // FR-14: CSS cannot stop a <video>, so pause media directly. This is also what
  // makes a video-carrying page capturable at all: without it the frame depends
  // on which frame the decoder happened to be on.
  if (rules.pauseMedia !== false) {
    const paused = await page
      .evaluate(() => {
        let count = 0;
        for (const media of Array.from(document.querySelectorAll('video, audio'))) {
          const el = media as HTMLMediaElement;
          if (!el.paused) {
            el.pause();
            count++;
          }
        }
        return count;
      })
      .catch(() => 0);
    if (paused > 0) warn(`paused ${paused} media element(s) before capture`);
  }

  if (rules.networkIdle && strategy !== 'fallback') {
    await page
      .waitForLoadState('networkidle', { timeout: budget })
      .catch(() => warn('network never went idle; continuing', { budget }));
  }

  if (rules.fontsReady) {
    await page
      .evaluate(() => document.fonts.ready.then(() => true))
      .catch(() => warn('font loading did not settle'));
  }

  if (rules.imagesDecoded) {
    await page
      .evaluate(async () => {
        const pending = Array.from(document.images).filter((image) => !image.complete);
        await Promise.all(pending.map((image) => image.decode().catch(() => undefined)));
        return pending.length;
      })
      .catch(() => warn('image decoding did not settle'));
  }

  if (rules.scrollWarmup) {
    await scrollWarmup(page, budget, warn);
  }

  await waitForQuietDom(page, rules.mutationQuiescenceMs, budget, warn);

  if (settle) {
    // Settle mode: animation is still running, so quiescence alone is not
    // evidence of readiness (a looping animation never mutates the DOM). Wait
    // for `getAnimations()` to drain, then quiescence again.
    await waitForAnimationsToFinish(page, budget, warn);
    await waitForQuietDom(page, rules.mutationQuiescenceMs, budget, warn);
  } else {
    // Re-freeze: a lazily mounted component may have introduced its own motion
    // after the first injection.
    await page.addStyleTag({ content: FREEZE_CSS }).catch(() => undefined);
  }
}

/**
 * FR-14 settle mode: wait until nothing is animating any more.
 *
 * `document.getAnimations()` covers CSS animations/transitions *and* Web
 * Animations, which is the practical definition of "the page has stopped
 * moving". Polling is used rather than a promise because the set can grow while
 * we wait (a lazy component starting its own intro).
 */
async function waitForAnimationsToFinish(
  page: Page,
  budget: number,
  warn: (message: string, fields?: Record<string, unknown>) => void,
): Promise<void> {
  const deadline = Date.now() + budget;
  // A looping animation (`infinite`) never drains. If the count has not moved
  // for this long, waiting the rest of the budget cannot help.
  const stableMs = 1500;
  let lastCount = -1;
  let lastChange = Date.now();
  for (;;) {
    const running = await page
      .evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').length)
      .catch(() => 0);
    if (running === 0) return;
    if (running !== lastCount) {
      lastCount = running;
      lastChange = Date.now();
    }
    if (Date.now() - lastChange >= stableMs) {
      warn('animations appear to loop; capturing at the settle point', { running });
      return;
    }
    if (Date.now() >= deadline) {
      warn('animations were still running at the budget; capturing anyway', { running, budget });
      return;
    }
    await page.waitForTimeout(100).catch(() => undefined);
  }
}

/**
 * FR-13: scroll to the bottom and back.
 *
 * IntersectionObserver lazy-loading only fires for content that enters the
 * viewport; without this, a full-page capture shows empty placeholders below the
 * fold. The step is bounded so a very tall page cannot eat the whole budget, and
 * we always return to the top so the first pixel is consistent across runs.
 */
async function scrollWarmup(
  page: Page,
  budget: number,
  warn: (message: string, fields?: Record<string, unknown>) => void,
): Promise<void> {
  const deadline = Date.now() + Math.min(budget * 0.6, 8000);
  try {
    await page.evaluate(
      async ({ deadline }) => {
        const step = Math.round(window.innerHeight * 0.8);
        let position = 0;
        for (let guard = 0; guard < 400; guard++) {
          position += step;
          window.scrollTo(0, position);
          await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
          await new Promise((resolve) => setTimeout(resolve, 60));
          if (position >= document.documentElement.scrollHeight - window.innerHeight) break;
          if (Date.now() > deadline) break;
        }
        window.scrollTo(0, 0);
        // Let anything triggered near the bottom flush before the frame is taken.
        await new Promise((resolve) => setTimeout(resolve, 150));
      },
      { deadline },
    );
  } catch {
    warn('scroll warm-up did not complete; full-page capture may show lazy gaps');
  }
}

/**
 * FR-12: DOM mutation quiescence.
 *
 * Resolves once no mutation has been seen for `quietMs`. This catches what load
 * events miss: hydration, skeletons replaced by content, fonts reflowing text.
 * The hard deadline guarantees it can never hang a capture on a page that
 * animates forever.
 */
async function waitForQuietDom(
  page: Page,
  quietMs: number,
  budget: number,
  warn: (message: string, fields?: Record<string, unknown>) => void,
): Promise<void> {
  if (quietMs <= 0) return;
  try {
    await page.evaluate(
      async ({ quiet, deadline }) => {
        await new Promise<void>((resolve) => {
          let timer: ReturnType<typeof setTimeout>;
          let done = false;
          const observer = new MutationObserver(() => {
            clearTimeout(timer);
            timer = setTimeout(finish, quiet);
          });
          function finish() {
            if (done) return;
            done = true;
            observer.disconnect();
            clearTimeout(timer);
            resolve();
          }
          observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            characterData: true,
          });
          timer = setTimeout(finish, quiet);
          setTimeout(finish, Math.max(deadline - Date.now(), quiet));
        });
      },
      { quiet: quietMs, deadline: Date.now() + budget },
    );
  } catch {
    warn('DOM quiescence check failed; capturing what is on screen');
  }
}

/**
 * FR-18: frame validator, run on the real decoded pixels.
 *
 * The first cut of this estimated "blankness" from compressed PNG bytes per
 * pixel. That failed in the dangerous direction: a clean marketing page (white
 * background, hairline borders, small body text) compresses to ~0.007 B/px at
 * 3840x2160 and was rejected as blank — on exactly the polished pages this tool
 * exists to capture. Decoding is the only reliable answer, so the frame is
 * downsampled in the page we already have open and judged on colour spread.
 *
 * Thresholds are deliberately conservative: a single line of body text produces
 * a stddev in the tens, while a truly flat frame sits near zero.
 */
const ANALYSIS_EDGE = 96;

export async function isNearUniform(page: Page, buffer: Buffer): Promise<boolean> {
  if (buffer.length < 100) return true;
  const isPng =
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
  // Not a PNG is our bug, not the page's; never reject the capture for it.
  if (!isPng) return false;

  try {
    const stats = await page.evaluate(
      async ({ base64, edge }) => {
        const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
        const canvas = document.createElement('canvas');
        canvas.width = edge;
        canvas.height = edge;
        const ctx = canvas.getContext('2d');
        if (ctx === null) return null;
        ctx.drawImage(bitmap, 0, 0, edge, edge);
        bitmap.close();

        const data = ctx.getImageData(0, 0, edge, edge).data;
        const colours = new Set<number>();
        let sum = 0;
        let sumSq = 0;
        for (let index = 0; index < data.length; index += 4) {
          const r = data[index] as number;
          const g = data[index + 1] as number;
          const b = data[index + 2] as number;
          colours.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
          const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          sum += luma;
          sumSq += luma * luma;
        }
        const count = data.length / 4;
        const mean = sum / count;
        return {
          colours: colours.size,
          stddev: Math.sqrt(Math.max(0, sumSq / count - mean * mean)),
        };
      },
      { base64: buffer.toString('base64'), edge: ANALYSIS_EDGE },
    );

    // An analysis failure must not fail a capture (Principle 2).
    if (stats === null) return false;
    return stats.colours <= 3 && stats.stddev < 1.5;
  } catch {
    return false;
  }
}

/**
 * FR-18 (M0 subset): obvious error states that must never reach a gallery.
 *
 * Detection is on the live DOM rather than the pixels, which is both cheaper and
 * more specific than image analysis: a Next/Vite error overlay is a reliable
 * signal even when the page behind it rendered beautifully.
 */
export async function detectBrokenPage(page: Page): Promise<string | null> {
  try {
    return await page.evaluate(() => {
      const overlay = document.querySelector(
        'nextjs__container_errors, nextjs__container_errors_label, vite-error-overlay, #webpack-dev-server-client-overlay',
      );
      if (overlay !== null) return 'framework error overlay present';
      const heading = document.querySelector('h1')?.textContent?.trim().toLowerCase() ?? '';
      const bodyLength = document.body?.innerText.trim().length ?? 0;
      if (bodyLength < 40 && /error|not found|500|404/.test(heading))
        return `error page: ${heading}`;
      // A page with no layout at all is a capture of nothing.
      if (bodyLength === 0 && document.querySelectorAll('img,svg,canvas').length === 0)
        return 'page has no content';
      return null;
    });
  } catch {
    return null;
  }
}
