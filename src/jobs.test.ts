import { describe, it, expect } from 'vitest';
import { pageSlug, planJobs } from './jobs.ts';
import { DEVICES } from './devices.ts';

describe('jobs.ts', () => {
  describe('pageSlug', () => {
    it('converts root path to home', () => {
      expect(pageSlug('/')).toBe('home');
    });

    it('converts simple path', () => {
      expect(pageSlug('/pricing')).toBe('pricing');
    });

    it('handles nested paths', () => {
      expect(pageSlug('/blog/hello-world')).toBe('blog-hello-world');
    });

    it('removes query strings', () => {
      expect(pageSlug('/page?foo=bar')).toBe('page');
    });

    it('removes fragments', () => {
      expect(pageSlug('/page#section')).toBe('page');
    });

    it('handles trailing slashes', () => {
      expect(pageSlug('/pricing/')).toBe('pricing');
    });

    it('handles multiple slashes', () => {
      expect(pageSlug('///pricing///')).toBe('pricing');
    });

    it('handles special characters', () => {
      expect(pageSlug('/pricing-and-features')).toBe('pricing-and-features');
    });

    it('handles empty string', () => {
      expect(pageSlug('')).toBe('home');
    });
  });

  describe('planJobs', () => {
    const base = new URL('http://localhost:3000');
    const devices = [DEVICES.mobile!, DEVICES.desktop!];

    it('creates jobs for each page and device', () => {
      const { jobs } = planJobs({
        base,
        pages: ['/', '/pricing'],
        devices,
        fullPage: true,
      });

      expect(jobs).toHaveLength(4);
      expect(jobs.map((j) => j.id).sort()).toEqual([
        '/@desktop',
        '/@mobile',
        '/pricing@desktop',
        '/pricing@mobile',
      ]);
    });

    it('uses viewport mode when fullPage is false', () => {
      const { jobs } = planJobs({
        base,
        pages: ['/'],
        devices,
        fullPage: false,
      });

      expect(jobs[0]!.mode).toBe('viewport');
    });

    it('uses fullPage mode when fullPage is true', () => {
      const { jobs } = planJobs({
        base,
        pages: ['/'],
        devices,
        fullPage: true,
      });

      expect(jobs[0]!.mode).toBe('fullPage');
    });

    it('de-duplicates colliding slugs', () => {
      const { jobs, collisions } = planJobs({
        base,
        pages: ['/a-b', '/a_b'],
        devices: [DEVICES.mobile!],
        fullPage: true,
      });

      expect(collisions).toHaveLength(1);
      expect(jobs.map((j) => j.pageSlug)).toEqual(['a-b', 'a-b-2']);
    });

    it('generates correct relPath', () => {
      const { jobs } = planJobs({
        base,
        pages: ['/pricing'],
        devices: [DEVICES.mobile!],
        fullPage: true,
      });

      expect(jobs[0]!.relPath).toBe('screenshots/pricing/mobile.png');
    });

    it('generates correct URL', () => {
      const { jobs } = planJobs({
        base,
        pages: ['/pricing'],
        devices: [DEVICES.mobile!],
        fullPage: true,
      });

      expect(jobs[0]!.url).toBe('http://localhost:3000/pricing');
    });
  });
});
