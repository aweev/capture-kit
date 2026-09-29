import type { Page } from 'playwright';

/**
 * Overlay auto-dismissal (FR-15).
 *
 * Cookie banners, chat widgets, and newsletter modals are endless in variety,
 * so this is a curated heuristic library, not a classifier: a list of widely
 * used selectors (OneTrust, TrustArc, Cookiebot, Quantcast, Intercom, Drift,
 * HubSpot, etc.) plus role/attribute heuristics, applied safely. Every action
 * is best-effort and degrades to a warning — a banner that survives is a
 * cosmetic issue, never a failed capture (Principle 2). Users extend the list
 * with `stabilize.dismissSelectors` / `stabilize.blockHosts`.
 */

/** Widely deployed consent / widget selectors. Kept sorted for reviewability. */
export const OVERLAY_SELECTORS = [
  // Consent management platforms
  '#CybotCookiebotDialog',
  '#onetrust-banner-sdk',
  '#onetrust-consent-sdk',
  '#truste-consent-track',
  '#trustarc-notice',
  '.cc-window',
  '.cc-banner',
  '.cookie-banner',
  '.cookie-consent',
  '.cookie-notice',
  '.cpnb-panel',
  '.gdpr-banner',
  '.osano-cm-window',
  '.ot-sdk-container',
  '.qc-cmp2-container',
  '[aria-label="cookie banner"]',
  '[aria-label="cookie consent"]',
  '[data-cookiebanner]',
  '[data-testid="cookie-banner"]',
  '[id*="cookie"][id*="banner"]',
  '[id*="cookie"][id*="consent"]',
  'div[class*="cookie"][class*="banner"]',
  // Chat / support widgets (dock to a corner; hide, never click, to avoid opens)
  '#drift-widget',
  '#hubspot-messages-iframe-container',
  '#intercom-container',
  '.crisp-client',
  '.drift-frame',
  '.intercom-launcher-frame',
  '[id*="chat-widget"]',
  '[id*="zendesk"]',
  'iframe[title*="chat" i]',
  // Newsletter / promo modals
  '[aria-label="newsletter signup"]',
  '[data-testid="newsletter-modal"]',
  '.newsletter-modal',
  '.newsletter-popup',
  '.promo-modal',
] as const;

/** Third-party widget hosts worth blocking at the request level (optional). */
export const OVERLAY_HOSTS = [
  'intercom.io',
  'drift.com',
  'zendesk.com',
  'hubspot.com',
  'crisp.chat',
  'livechat.com',
] as const;

export type DismissResult = {
  dismissed: number;
  hidden: number;
  selectors: string[];
};

/**
 * Click "accept/close" inside known banners, hide surviving widgets.
 *
 * Strategy per candidate, in order: (1) click an accept/close button inside it,
 * (2) hide the element. Clicking first matters: some banners reappear when
 * merely hidden, and some pages gate scrolling behind consent. Everything is
 * wrapped so a hostile DOM cannot fail the capture.
 */
export async function dismissOverlays(
  page: Page,
  extraSelectors: string[] = [],
  warn: (message: string, fields?: Record<string, unknown>) => void = () => undefined,
): Promise<DismissResult> {
  const selectors = [...OVERLAY_SELECTORS, ...extraSelectors];
  try {
    return await page.evaluate((sels: string[]) => {
      let dismissed = 0;
      let hidden = 0;
      const hit: string[] = [];
      const closePattern =
        /accept|agree|consent|allow all|got it|ok|close|dismiss|no thanks|reject/i;
      for (const sel of sels) {
        let els: Element[] = [];
        try {
          els = Array.from(document.querySelectorAll(sel));
        } catch {
          continue;
        }
        for (const el of els) {
          const html = el as HTMLElement;
          if (html.offsetParent === null && html.style.position !== 'fixed') continue;
          hit.push(sel);
          const btn = Array.from(el.querySelectorAll('button, a, [role="button"]')).find((b) =>
            closePattern.test(b.textContent?.trim() ?? ''),
          ) as HTMLElement | undefined;
          if (btn) {
            try {
              btn.click();
              dismissed++;
              continue;
            } catch {
              /* fall through to hide */
            }
          }
          try {
            html.setAttribute('data-capturekit-hidden', '1');
            html.style.setProperty('display', 'none', 'important');
            html.style.setProperty('visibility', 'hidden', 'important');
            hidden++;
          } catch {
            /* ignore */
          }
        }
      }
      return { dismissed, hidden, selectors: [...new Set(hit)].slice(0, 20) };
    }, selectors);
  } catch (err) {
    warn('overlay dismissal failed; capturing with overlays in place', {
      error: (err as Error).message,
    });
    return { dismissed: 0, hidden: 0, selectors: [] };
  }
}

/**
 * Hide elements matching user-supplied selectors (manual mask fallback for
 * overlays the library does not know, PRD risk table row 2).
 */
export async function hideSelectors(page: Page, selectors: string[]): Promise<number> {
  if (selectors.length === 0) return 0;
  try {
    return await page.evaluate((sels: string[]) => {
      let count = 0;
      for (const sel of sels) {
        let els: Element[] = [];
        try {
          els = Array.from(document.querySelectorAll(sel));
        } catch {
          continue;
        }
        for (const el of els) {
          (el as HTMLElement).style.setProperty('display', 'none', 'important');
          count++;
        }
      }
      return count;
    }, selectors);
  } catch {
    return 0;
  }
}
