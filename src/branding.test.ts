import { describe, it, expect } from 'vitest';
import { resolveBrand, themedShell, assetGrid, markdownSnippet } from './branding.ts';

describe('branding.ts', () => {
  it('resolveBrand defaults accent and title', () => {
    expect(resolveBrand(undefined)).toEqual({ title: 'Capturekit gallery', accent: '#0F62FE' });
  });

  it('themedShell escapes brand input', () => {
    const html = themedShell({ title: '<Acme>', accent: '#0F62FE', client: 'A&B' }, '<p>grid</p>');
    expect(html).toContain('&lt;Acme&gt;');
    expect(html).toContain('A&amp;B');
    expect(html).not.toContain('<Acme>');
  });

  it('assetGrid renders accessible images', () => {
    const html = assetGrid([{ path: 's/a.png', page: '/', viewport: 'mobile' }]);
    expect(html).toContain('alt="Screenshot of / on mobile"');
  });

  it('markdownSnippet lists assets and truncates', () => {
    const assets = Array.from({ length: 8 }, (_, i) => ({
      path: `s/${i}.png`,
      page: `/p${i}`,
      viewport: 'mobile',
    }));
    const md = markdownSnippet(assets, { target: 'http://x', runDirName: 'run1' });
    expect(md).toContain('…and 2 more');
    expect(md).toContain('8 assets');
  });
});
