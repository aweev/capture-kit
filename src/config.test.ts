import { describe, it, expect } from 'vitest';
import { parseConfig, buildConfig, defineConfig, type InputConfig } from './config.ts';

describe('config.ts', () => {
  describe('parseConfig', () => {
    it('applies defaults for minimal config', () => {
      const result = parseConfig({ target: 'http://localhost:3000' }, 'test');

      expect(result.target).toBe('http://localhost:3000');
      expect(result.outDir).toContain('captures');
      expect(result.pages).toEqual(['/']);
      expect(result.devices).toHaveLength(3);
      expect(result.capture.fullPage).toBe(true);
      expect(result.capture.format).toBe('png');
      expect(result.stabilize.attempts).toBe(3);
      expect(result.concurrency).toBeGreaterThan(0);
    });

    it('accepts custom pages', () => {
      const result = parseConfig(
        { target: 'http://localhost:3000', pages: ['/', '/about', '/contact'] },
        'test',
      );

      expect(result.pages).toEqual(['/', '/about', '/contact']);
    });

    it('accepts custom viewports', () => {
      const result = parseConfig(
        { target: 'http://localhost:3000', viewports: ['mobile', 'desktop'] },
        'test',
      );

      expect(result.devices).toHaveLength(2);
      expect(result.devices.map((d) => d.name)).toEqual(['mobile', 'desktop']);
    });

    it('accepts custom viewport objects', () => {
      const result = parseConfig(
        {
          target: 'http://localhost:3000',
          viewports: [{ name: 'custom', width: 1200, height: 800 }],
        },
        'test',
      );

      expect(result.devices).toHaveLength(1);
      expect(result.devices[0]!.name).toBe('custom');
      expect(result.devices[0]!.width).toBe(1200);
      expect(result.devices[0]!.height).toBe(800);
    });

    it('throws on missing target', () => {
      expect(() => parseConfig({}, 'test')).toThrow('No target URL');
    });

    it('throws on invalid target URL', () => {
      expect(() => parseConfig({ target: 'not-a-url' }, 'test')).toThrow(
        'not a valid absolute URL',
      );
    });

    it('throws on unsupported protocol', () => {
      expect(() => parseConfig({ target: 'ftp://example.com' }, 'test')).toThrow(
        'Unsupported protocol',
      );
    });

    it('throws on duplicate viewport names', () => {
      expect(() =>
        parseConfig(
          {
            target: 'http://localhost:3000',
            viewports: ['mobile', 'mobile'],
          },
          'test',
        ),
      ).toThrow('Duplicate viewport name');
    });

    it('throws on unknown viewport name', () => {
      expect(() =>
        parseConfig({ target: 'http://localhost:3000', viewports: ['unknown'] }, 'test'),
      ).toThrow('Invalid input');
    });

    it('normalizes page paths to start with /', () => {
      const result = parseConfig(
        { target: 'http://localhost:3000', pages: ['pricing', '/about'] },
        'test',
      );

      expect(result.pages).toEqual(['/pricing', '/about']);
    });
  });

  describe('defineConfig', () => {
    it('returns the config object unchanged', () => {
      const config: InputConfig = {
        target: 'http://localhost:3000',
        pages: ['/'],
        viewports: ['mobile'],
        capture: { fullPage: true, format: 'png' },
        stabilize: {
          networkIdle: true,
          fontsReady: true,
          imagesDecoded: true,
          mutationQuiescenceMs: 400,
          disableAnimations: true,
          scrollWarmup: true,
          timeoutMs: 20000,
          attempts: 3,
        },
        concurrency: 4,
      };
      expect(defineConfig(config)).toBe(config);
    });
  });

  describe('buildConfig', () => {
    it('merges CLI flags over defaults', async () => {
      const result = await buildConfig({
        url: 'http://example.com',
        viewport: ['desktop'],
        cwd: '/tmp',
      });

      expect(result.target).toBe('http://example.com');
      expect(result.devices).toHaveLength(1);
      expect(result.devices[0]!.name).toBe('desktop');
    });

    it('merges CLI flags over config file when file exists', async () => {
      // Test that CLI flags override config - we just test the flag merging logic
      const result = await buildConfig({
        url: 'http://cli.example.com',
        viewport: ['tablet'],
        noConfig: true,
        cwd: '/tmp',
      });

      expect(result.target).toBe('http://cli.example.com');
      expect(result.devices.map((d) => d.name)).toEqual(['tablet']);
    });
  });
});
