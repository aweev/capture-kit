import { describe, it, expect } from 'vitest';
import { buildGalleryHtml } from './gallery.ts';
import type { Manifest } from './manifest.ts';

function manifest(): Manifest {
  return {
    schemaVersion: 1,
    runId: 'r1',
    startedAt: '2026-01-01T00:00:00Z',
    finishedAt: '2026-01-01T00:00:01Z',
    durationMs: 1000,
    target: 'http://x',
    tool: { name: 'capturekit', version: '0', chromium: 'c' },
    config: { source: 't', concurrency: 1, viewports: ['mobile'] },
    summary: { planned: 1, succeeded: 2, failed: 0, retried: 0, durationMs: 1000 },
    assets: [
      {
        page: '/',
        viewport: 'mobile',
        type: 'screenshot',
        path: 'screenshots/home/mobile.png',
        width: 390,
        height: 844,
        deviceScaleFactor: 3,
        fullPage: true,
        format: 'png',
        bytes: 10,
        contentHeight: 900,
        attempts: 1,
        durationMs: 10,
        strategy: 's',
      },
      {
        page: '/',
        viewport: 'mobile',
        type: 'video',
        path: 'videos/home/mobile.mp4',
        width: 390,
        height: 844,
        format: 'mp4',
        kind: 'walkthrough',
        bytes: 20,
        durationMs: 100,
        attempts: 1,
      },
    ],
    failures: [],
  };
}

describe('gallery.ts', () => {
  it('renders a self-contained page with screenshot, video, and tabs', () => {
    const html = buildGalleryHtml(manifest());
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('screenshots/home/mobile.png');
    expect(html).toContain('<video src="videos/home/mobile.mp4"');
    expect(html).toContain('id="ck-manifest"');
    expect(html).not.toContain('<script src=');
    expect(html).not.toContain('<link rel=');
  });

  it('renders GIF walkthroughs as images', () => {
    const m = manifest();
    const video = m.assets[1];
    if (!video || video.type !== 'video') throw new Error('fixture shape changed');
    m.assets[1] = { ...video, path: 'videos/home/mobile.gif', format: 'gif' };
    const html = buildGalleryHtml(m);
    expect(html).toContain('<img src="videos/home/mobile.gif"');
  });

  it('applies alt text and branding', () => {
    const html = buildGalleryHtml(manifest(), {
      brand: { title: 'Acme', accent: '#FF0000' },
      altText: { 'screenshots/home/mobile.png': { alt: 'Custom alt', caption: 'Cap' } },
    });
    expect(html).toContain('alt="Custom alt"');
    expect(html).toContain('Acme');
    expect(html).toContain('#FF0000');
  });

  it('escapes hostile page paths', () => {
    const m = manifest();
    const shot = m.assets[0];
    if (!shot || shot.type !== 'screenshot') throw new Error('fixture shape changed');
    m.assets[0] = { ...shot, page: '/"><script>alert(1)</script>' };
    const html = buildGalleryHtml(m);
    expect(html).not.toContain('/"><script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
