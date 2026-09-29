import { describe, it, expect } from 'vitest';
import { OVERLAY_SELECTORS, hideSelectors, dismissOverlays } from './overlays.ts';

describe('overlays.ts', () => {
  it('ships a non-empty selector library', () => {
    expect(OVERLAY_SELECTORS.length).toBeGreaterThan(10);
    expect(OVERLAY_SELECTORS).toContain('#onetrust-banner-sdk');
  });

  it('hideSelectors returns 0 for empty list without touching the page', async () => {
    const page = {
      evaluate: async () => {
        throw new Error('should not be called');
      },
    };
    await expect(hideSelectors(page as never, [])).resolves.toBe(0);
  });

  it('hideSelectors hides matching elements', async () => {
    const hidden: string[] = [];
    const page = {
      evaluate: async (fn: (sels: string[]) => number, sels: string[]) => {
        expect(sels).toEqual(['.promo']);
        hidden.push(...sels);
        return fn.length >= 0 ? 1 : 0;
      },
    };
    await expect(hideSelectors(page as never, ['.promo'])).resolves.toBe(1);
  });

  it('dismissOverlays degrades to empty result when evaluate throws', async () => {
    const page = {
      evaluate: async () => {
        throw new Error('boom');
      },
    };
    await expect(dismissOverlays(page as never)).resolves.toEqual({
      dismissed: 0,
      hidden: 0,
      selectors: [],
    });
  });
});
