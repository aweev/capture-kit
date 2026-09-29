import { describe, it, expect } from 'vitest';
import { discoverPages } from './discover.ts';

function response(html: string, contentType = 'text/html; charset=utf-8'): Response {
  return new Response(html, { status: 200, headers: { 'content-type': contentType } });
}

describe('discover.ts', () => {
  const base = new URL('http://localhost:3000');

  it('finds pages via sitemap, then robots, then crawl', async () => {
    const fetchImpl = async (url: string): Promise<Response | null> => {
      if (url.endsWith('/sitemap.xml')) {
        return response(`<?xml version="1.0"?><urlset><url><loc>http://localhost:3000/pricing</loc></url></urlset>`);
      }
      if (url.endsWith('/robots.txt')) return response('User-agent: *\nDisallow: /admin\n');
      if (url === 'http://localhost:3000/') {
        return response(`<html><body><nav><a href="/features">Features</a></nav><a href="/blog">Blog</a></body></html>`);
      }
      return response('<html><body>leaf</body></html>');
    };
    const result = await discoverPages({
      base,
      configPages: ['/'],
      include: [],
      exclude: [],
      maxDepth: 2,
      maxPages: 20,
    }, fetchImpl);
    expect(result.pages).toContain('/');
    expect(result.pages).toContain('/pricing');
    expect(result.pages).toContain('/features');
    expect(result.pages).toContain('/blog');
    expect(result.pages).not.toContain('/admin');
  });

  it('records inbound counts and nav links for ranking', async () => {
    const fetchImpl = async (url: string): Promise<Response | null> => {
      if (url.endsWith('/sitemap.xml') || url.endsWith('/robots.txt')) return null;
      if (url === 'http://localhost:3000/') {
        return response(`<nav><a href="/pricing">P</a><a href="/pricing">P2</a></nav><a href="/other">O</a>`);
      }
      return response('leaf');
    };
    const result = await discoverPages({
      base,
      configPages: ['/'],
      include: [],
      exclude: [],
      maxDepth: 1,
      maxPages: 20,
    }, fetchImpl);
    expect(result.navLinks).toContain('/pricing');
    expect(result.inbound['/pricing']).toBe(2);
    expect(result.inbound['/other']).toBe(1);
  });

  it('deduplicates parameterized routes to one representative', async () => {
    const fetchImpl = async (url: string): Promise<Response | null> => {
      if (url.endsWith('/sitemap.xml')) {
        return response(
          `<urlset><url><loc>http://localhost:3000/post/1</loc></url><url><loc>http://localhost:3000/post/2</loc></url></urlset>`,
        );
      }
      if (url.endsWith('/robots.txt')) return null;
      return response('leaf');
    };
    const result = await discoverPages({
      base,
      configPages: ['/'],
      include: [],
      exclude: [],
      maxDepth: 0,
      maxPages: 20,
    }, fetchImpl);
    const posts = result.pages.filter((p) => p.startsWith('/post/'));
    expect(posts).toHaveLength(1);
  });

  it('include/exclude globs override discovery', async () => {
    const fetchImpl = async (url: string): Promise<Response | null> => {
      if (url.endsWith('/sitemap.xml')) {
        return response(
          `<urlset><url><loc>http://localhost:3000/admin/stats</loc></url><url><loc>http://localhost:3000/about</loc></url></urlset>`,
        );
      }
      if (url.endsWith('/robots.txt')) return null;
      return response('leaf');
    };
    const result = await discoverPages({
      base,
      configPages: ['/'],
      include: [],
      exclude: ['/admin/**'],
      maxDepth: 0,
      maxPages: 20,
    }, fetchImpl);
    expect(result.pages).toContain('/about');
    expect(result.pages).not.toContain('/admin/stats');
    expect(result.skipped.some((s) => s.path === '/admin/stats')).toBe(true);
  });

  it('survives unreachable sitemap and robots', async () => {
    const result = await discoverPages({
      base,
      configPages: ['/'],
      include: [],
      exclude: [],
      maxDepth: 1,
      maxPages: 20,
    }, async () => null);
    expect(result.pages).toEqual(['/']);
  });
});
