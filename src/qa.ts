/**
 * Visual QA pass (FR-42).
 *
 * Flags clipped text, overlapping elements, and horizontal overflow before
 * delivery. The checks are deterministic DOM heuristics — no model call, no
 * API key — so they run anywhere; the M4 layer owns *reporting* them
 * (`qa.json` per run). Findings never fail a capture; they are advisory.
 */
import { z } from 'zod';

export const qaSchema = z
  .object({
    enabled: z.boolean().default(false),
    maxPerRule: z.number().int().min(1).max(50).default(10),
  })
  .strict();

export type QaConfig = z.infer<typeof qaSchema>;

export type QaRule = 'horizontal-overflow' | 'clipped-text' | 'overlap';

export type QaSeverity = 'warn' | 'info';

export type QaFinding = {
  rule: QaRule;
  severity: QaSeverity;
  selector: string;
  message: string;
};

type QaRawFinding = { rule: string; selector: string; message: string };

type QaArg = { sample: number; perRule: number };

/**
 * Minimal surface used by the checks: tests pass fakes, and the capture
 * pipeline adapts a real Playwright page with a one-line wrapper.
 */
export type QaPage = {
  evaluate: (fn: (arg: QaArg) => QaRawFinding[], arg: QaArg) => Promise<QaRawFinding[] | null>;
};

/** Adapt a Playwright page to the QA surface. */
export function qaPageFrom(page: {
  evaluate: (fn: (arg: QaArg) => QaRawFinding[], arg: QaArg) => Promise<QaRawFinding[]>;
}): QaPage {
  return { evaluate: (fn, arg) => page.evaluate(fn, arg) };
}

export type QaOptions = {
  /** Max elements sampled for the pairwise overlap check. */
  maxOverlapSample?: number;
  /** Max findings per rule. */
  maxPerRule?: number;
};

/**
 * Run all QA rules against the live page. Each rule degrades to "no findings"
 * on evaluation errors — a hostile DOM must not fail a capture (Principle 2).
 */
export async function runQaChecks(page: QaPage, options: QaOptions = {}): Promise<QaFinding[]> {
  const maxOverlapSample = options.maxOverlapSample ?? 120;
  const maxPerRule = options.maxPerRule ?? 10;
  const findings: QaFinding[] = [];
  try {
    const raw = await page.evaluate(
      ({ sample, perRule }) => {
        const out: { rule: string; selector: string; message: string }[] = [];
        const push = (rule: string, el: Element, message: string) => {
          if (out.filter((f) => f.rule === rule).length >= perRule) return;
          const sel = describe(el);
          out.push({ rule, selector: sel, message });
        };
        function describe(el: Element): string {
          const tag = el.tagName.toLowerCase();
          const id = el.getAttribute('id');
          if (id) return `${tag}#${id}`;
          const cls = (el.getAttribute('class') || '').trim().split(/\s+/)[0];
          const text = (el.textContent || '').trim().slice(0, 24).replace(/\s+/g, ' ');
          return `${tag}${cls ? `.${cls}` : ''}${text ? ` "${text}"` : ''}`.slice(0, 80);
        }
        // Rule 1: horizontal overflow — scrolled width exceeds the viewport.
        if (document.documentElement.scrollWidth > window.innerWidth + 1) {
          const wide = Array.from(document.querySelectorAll('*')).filter((el) => {
            const r = el.getBoundingClientRect();
            return r.width > window.innerWidth + 1 && r.width < window.innerWidth * 4;
          });
          for (const el of wide.slice(0, perRule)) {
            push('horizontal-overflow', el, `element is wider than the viewport`);
          }
          if (wide.length === 0) {
            push(
              'horizontal-overflow',
              document.documentElement,
              `page scrolls horizontally (${document.documentElement.scrollWidth}px > ${window.innerWidth}px)`,
            );
          }
        }
        // Rule 2: clipped text — ellipsis with truncated scrollable content.
        const candidates = Array.from(
          document.querySelectorAll('h1, h2, h3, p, a, button, span, li'),
        ).slice(0, sample * 4);
        for (const el of candidates) {
          const html = el as HTMLElement;
          const style = getComputedStyle(html);
          const clipped =
            (style.textOverflow === 'ellipsis' || style.overflow === 'hidden') &&
            html.scrollWidth > html.clientWidth + 2 &&
            (html.textContent || '').trim().length > 0;
          if (clipped) push('clipped-text', el, `text may be clipped`);
          if (out.filter((f) => f.rule === 'clipped-text').length >= perRule) break;
        }
        // Rule 3: overlap — sampled visible leaf-ish elements whose boxes
        // intersect without containment (excludes intentionally stacked UI).
        const boxes = Array.from(document.querySelectorAll('body *'))
          .slice(0, sample)
          .map((el) => ({ el, r: el.getBoundingClientRect() }))
          .filter(
            ({ r }) =>
              r.width > 4 &&
              r.height > 4 &&
              r.bottom > 0 &&
              r.right > 0 &&
              r.top < window.innerHeight,
          );
        const overlaps = (a: DOMRect, b: DOMRect) =>
          a.left < b.right - 2 &&
          b.left < a.right - 2 &&
          a.top < b.bottom - 2 &&
          b.top < a.bottom - 2;
        const contains = (a: DOMRect, b: DOMRect) =>
          a.left <= b.left && a.top <= b.top && a.right >= b.right && a.bottom >= b.bottom;
        for (let i = 0; i < boxes.length; i++) {
          for (let j = i + 1; j < boxes.length; j++) {
            const a = boxes[i]!;
            const b = boxes[j]!;
            if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
            if (overlaps(a.r, b.r) && !contains(a.r, b.r) && !contains(b.r, a.r)) {
              push('overlap', b.el, `overlaps ${describe(a.el)}`);
              break;
            }
          }
          if (out.filter((f) => f.rule === 'overlap').length >= perRule) break;
        }
        return out;
      },
      { sample: maxOverlapSample, perRule: maxPerRule } as never,
    );
    for (const finding of raw ?? []) {
      if (
        finding.rule === 'horizontal-overflow' ||
        finding.rule === 'clipped-text' ||
        finding.rule === 'overlap'
      ) {
        findings.push({ ...finding, rule: finding.rule, severity: 'warn' });
      }
    }
  } catch {
    /* evaluation failures yield no findings, never a failed capture */
  }
  return findings;
}
