import { describe, it, expect, afterEach } from 'vitest';

import { blockHosts, measureLayoutShift, stagingName } from './capture.ts';
import type { Job } from './jobs.ts';

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: '/@mobile',
    pagePath: '/',
    pageSlug: 'home',
    url: 'http://localhost:3000/',
    device: { name: 'mobile', width: 390, height: 844, deviceScaleFactor: 3, mobile: true },
    mode: 'fullPage',
    format: 'png',
    relPath: 'screenshots/home/mobile.png',
    ...overrides,
  } as Job;
}

describe('capture.ts helpers', () => {
  describe('stagingName', () => {
    it('is stable and distinct per identity', () => {
      expect(stagingName(job())).toBe('home-mobile');
      expect(stagingName(job({ scheme: 'dark' }))).toBe('home-mobile-dark');
      expect(stagingName(job({ flowName: 'Checkout!' }))).toBe('home-mobile-checkout');
      expect(stagingName(job())).not.toBe(stagingName(job({ scheme: 'dark' })));
    });

    it('sanitizes hostile characters', () => {
      expect(stagingName(job({ pageSlug: 'a/../b c' }))).toBe('a_.._b_c-mobile');
    });
  });

  describe('measureLayoutShift', () => {
    const performanceHost = globalThis.performance as unknown as {
      getEntriesByType?: (type: string) => unknown[];
    };
    const realEntriesByType = performanceHost.getEntriesByType;
    // The in-page callback reads the global `performance`, so the fake page
    // runs the real callback while the test swaps in canned entries.
    const page = { evaluate: async (fn: () => unknown) => fn() };
    afterEach(() => {
      if (realEntriesByType === undefined) delete performanceHost.getEntriesByType;
      else performanceHost.getEntriesByType = realEntriesByType;
    });

    it('sums non-input shifts from performance entries', async () => {
      performanceHost.getEntriesByType = () => [
        { value: 0.12, hadRecentInput: false },
        { value: 0.5, hadRecentInput: true },
        { value: 0.3, hadRecentInput: false },
      ];
      // CLS def: only shifts without recent input count -> 0.12 + 0.3 = 0.42
      await expect(measureLayoutShift(page as never)).resolves.toBeCloseTo(0.42, 5);
    });

    it('returns 0 when the page has no layout-shift support', async () => {
      const broken = {
        evaluate: async () => {
          throw new Error('unsupported');
        },
      };
      await expect(measureLayoutShift(broken as never)).resolves.toBe(0);
    });

    it('returns 0 when there were no shifts', async () => {
      performanceHost.getEntriesByType = () => [];
      await expect(measureLayoutShift(page as never)).resolves.toBe(0);
    });
  });

  describe('blockHosts', () => {
    function routeContext(seen: { aborted: string[]; continued: string[] }) {
      return {
        route: async (_pattern: string, handler: (route: unknown) => void) => {
          const cases = [
            'https://js.intercom.io/widget',
            'https://app.example.com/app.js',
            'https://deep.drift.com/embed',
            'https://intercom.io.evil.com/x',
          ];
          for (const url of cases) {
            let aborted = false;
            handler({
              request: () => ({ url: () => url }),
              abort: () => {
                aborted = true;
              },
              continue: () => undefined,
            });
            (aborted ? seen.aborted : seen.continued).push(url);
          }
        },
      };
    }

    it('aborts matching hosts and their subdomains only', async () => {
      const seen: { aborted: string[]; continued: string[] } = { aborted: [], continued: [] };
      await blockHosts(routeContext(seen) as never, ['intercom.io', 'drift.com']);
      expect(seen.aborted).toEqual(['https://js.intercom.io/widget', 'https://deep.drift.com/embed']);
      expect(seen.continued).toEqual(['https://app.example.com/app.js', 'https://intercom.io.evil.com/x']);
    });

    it('registers no route when there is nothing to block', async () => {
      let registered = 0;
      const ctx = { route: async () => registered++ };
      await blockHosts(ctx as never, ['   ', '']);
      expect(registered).toBe(0);
    });

    it('warns instead of throwing when routing is unavailable', async () => {
      const ctx = {
        route: async () => {
          throw new Error('nope');
        },
      };
      const warnings: string[] = [];
      await blockHosts(ctx as never, ['x.io'], (message) => warnings.push(message));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('request blocking unavailable');
    });
  });
});
