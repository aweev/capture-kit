import { describe, it, expect, vi } from 'vitest';
import {
  FREEZE_CSS,
  STRATEGY_LABEL,
  MULTIPLIER,
  isNearUniform,
  detectBrokenPage,
} from './stabilize.ts';

describe('stabilize.ts', () => {
  describe('FREEZE_CSS', () => {
    it('contains animation freeze rules', () => {
      expect(FREEZE_CSS).toContain('animation-duration: 0s !important');
      expect(FREEZE_CSS).toContain('transition-duration: 0s !important');
      expect(FREEZE_CSS).toContain('scroll-behavior: auto !important');
    });

    it('contains universal selectors', () => {
      expect(FREEZE_CSS).toContain('*, *::before, *::after');
    });
  });

  describe('STRATEGY_LABEL', () => {
    it('has labels for all strategies', () => {
      expect(STRATEGY_LABEL.standard).toBe('standard waits');
      expect(STRATEGY_LABEL.patient).toBe('longer settle + scroll warm-up');
      expect(STRATEGY_LABEL.fallback).toBe('cache cleared + domcontentloaded');
    });
  });

  describe('MULTIPLIER', () => {
    it('has increasing multipliers', () => {
      expect(MULTIPLIER.standard).toBe(1);
      expect(MULTIPLIER.patient).toBe(1.75);
      expect(MULTIPLIER.fallback).toBe(2.5);
    });
  });

  describe('isNearUniform', () => {
    it('returns true for very small buffers (< 100 bytes)', async () => {
      const mockPage = {
        evaluate: vi.fn().mockResolvedValue({ colours: 1, stddev: 0 }),
      };

      const result = await isNearUniform(mockPage as any, Buffer.from('small'));
      expect(result).toBe(true);
    });

    it('returns false for non-PNG buffers (>= 100 bytes)', async () => {
      const mockPage = {
        evaluate: vi.fn(),
      };

      // Create a buffer >= 100 bytes that's not a PNG
      const buffer = Buffer.alloc(100, 0xff);
      const result = await isNearUniform(mockPage as any, buffer);
      expect(result).toBe(false);
    });

    it('delegates to page.evaluate for PNG analysis', async () => {
      const mockPage = {
        evaluate: vi.fn().mockResolvedValue({ colours: 2, stddev: 1.0 }),
      };

      // Valid PNG header + enough bytes
      const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const buffer = Buffer.concat([pngHeader, Buffer.alloc(100)]);
      const result = await isNearUniform(mockPage as any, buffer);

      expect(mockPage.evaluate).toHaveBeenCalled();
      expect(result).toBe(true);
    });

    it('returns false when colours > 3', async () => {
      const mockPage = {
        evaluate: vi.fn().mockResolvedValue({ colours: 5, stddev: 10.0 }),
      };

      const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const buffer = Buffer.concat([pngHeader, Buffer.alloc(100)]);
      const result = await isNearUniform(mockPage as any, buffer);

      expect(result).toBe(false);
    });

    it('returns false when stddev >= 1.5', async () => {
      const mockPage = {
        evaluate: vi.fn().mockResolvedValue({ colours: 2, stddev: 2.0 }),
      };

      const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const buffer = Buffer.concat([pngHeader, Buffer.alloc(100)]);
      const result = await isNearUniform(mockPage as any, buffer);

      expect(result).toBe(false);
    });

    it('handles evaluate errors gracefully', async () => {
      const mockPage = {
        evaluate: vi.fn().mockRejectedValue(new Error('evaluate failed')),
      };

      const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const buffer = Buffer.concat([pngHeader, Buffer.alloc(100)]);
      const result = await isNearUniform(mockPage as any, buffer);

      expect(result).toBe(false);
    });
  });

  describe('detectBrokenPage', () => {
    it('detects Next.js error overlay', async () => {
      const mockPage = {
        evaluate: vi.fn().mockResolvedValue('framework error overlay present'),
      };

      const result = await detectBrokenPage(mockPage as any);
      expect(result).toBe('framework error overlay present');
    });

    it('detects Vite error overlay', async () => {
      const mockPage = {
        evaluate: vi.fn().mockResolvedValue('framework error overlay present'),
      };

      const result = await detectBrokenPage(mockPage as any);
      expect(result).toBe('framework error overlay present');
    });

    it('detects error page by heading', async () => {
      const mockPage = {
        evaluate: vi.fn().mockResolvedValue('error page: 404 not found'),
      };

      const result = await detectBrokenPage(mockPage as any);
      expect(result).toBe('error page: 404 not found');
    });

    it('detects empty page', async () => {
      const mockPage = {
        evaluate: vi.fn().mockResolvedValue('page has no content'),
      };

      const result = await detectBrokenPage(mockPage as any);
      expect(result).toBe('page has no content');
    });

    it('returns null for healthy page', async () => {
      const mockPage = {
        evaluate: vi.fn().mockResolvedValue(null),
      };

      const result = await detectBrokenPage(mockPage as any);
      expect(result).toBeNull();
    });

    it('handles evaluate errors gracefully', async () => {
      const mockPage = {
        evaluate: vi.fn().mockRejectedValue(new Error('evaluate failed')),
      };

      const result = await detectBrokenPage(mockPage as any);
      expect(result).toBeNull();
    });
  });
});
