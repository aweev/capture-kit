import { describe, it, expect } from 'vitest';
import { parseConfig } from './config.ts';
import { planJobs } from './jobs.ts';
import { DEVICES } from './devices.ts';

describe('M2 wiring', () => {
  it('config defaults preserve M0 behavior', () => {
    const c = parseConfig({ target: 'http://localhost:3000' }, 'test');
    expect(c.schemes).toEqual(['light']);
    expect(c.capture.format).toBe('png');
    expect(c.capture.frame).toBe('none');
    expect(c.stabilize.dismissOverlays).toBe(true);
    expect(c.stabilize.mask).toEqual([]);
    expect(c.flows).toEqual([]);
    expect(c.gallery.title).toBe('Capturekit gallery');
    expect(c.export.zip).toBe(false);
  });

  it('config accepts dark scheme + webp + flows + auth + branding', () => {
    const c = parseConfig(
      {
        target: 'http://localhost:3000',
        schemes: ['light', 'dark'],
        capture: { fullPage: true, format: 'webp', quality: 75, frame: 'browser' },
        stabilize: { mask: ['.timestamp'], maskMode: 'blur', freezeTime: '2026-01-01T00:00:00Z' },
        flows: [{ name: 'Checkout', steps: [{ goto: '/x' }] }],
        auth: { storageState: '.auth/state.json', headers: {}, cookies: [] },
        gallery: { title: 'Acme', client: 'Acme Inc.', brand: { accent: '#FF0000' } },
      },
      'test',
    );
    expect(c.schemes).toEqual(['light', 'dark']);
    expect(c.capture.format).toBe('webp');
    expect(c.flows).toHaveLength(1);
  });

  it('config rejects bad freezeTime and duplicate schemes', () => {
    expect(() =>
      parseConfig({ target: 'http://localhost:3000', stabilize: { freezeTime: 'nope' } }, 'test'),
    ).toThrow();
    expect(() =>
      parseConfig({ target: 'http://localhost:3000', schemes: ['light', 'light'] }, 'test'),
    ).toThrow();
  });

  it('planJobs keeps M0 paths for light/png', () => {
    const { jobs } = planJobs({
      base: new URL('http://localhost:3000'),
      pages: ['/'],
      devices: [DEVICES.mobile],
      fullPage: true,
    });
    expect(jobs[0]?.relPath).toBe('screenshots/home/mobile.png');
    expect(jobs[0]?.id).toBe('/@mobile');
  });

  it('planJobs fans out dark + webp with distinct paths', () => {
    const { jobs } = planJobs({
      base: new URL('http://localhost:3000'),
      pages: ['/'],
      devices: [DEVICES.mobile],
      fullPage: true,
      schemes: ['light', 'dark'],
      format: 'webp',
    });
    expect(jobs).toHaveLength(2);
    const paths = jobs.map((j) => j.relPath).sort();
    expect(paths).toEqual(['screenshots/home/mobile-dark.webp', 'screenshots/home/mobile.webp']);
    expect(new Set(jobs.map((j) => j.id)).size).toBe(2);
  });
});
