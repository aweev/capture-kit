import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { detectFramework, detectRoutes, rankPages, segmentsToPath } from './routes.ts';

let root: string;

beforeEach(async () => {
  root = await import('node:fs/promises').then((fs) =>
    fs.mkdtemp(path.join(tmpdir(), 'ck-routes-')),
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function project(files: Record<string, string>): Promise<string> {
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(root, name);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
  }
  return root;
}

describe('routes.ts', () => {
  it('segmentsToPath samples dynamics and drops groups', () => {
    expect(segmentsToPath(['blog', '[slug]'])).toEqual({ path: '/blog/1', sampled: true });
    expect(segmentsToPath(['(marketing)', 'about'])).toEqual({ path: '/about', sampled: false });
    expect(segmentsToPath([])).toEqual({ path: '/', sampled: false });
  });

  it('detects Next.js app routes, skipping layouts and colocated components', async () => {
    await project({
      'package.json': JSON.stringify({ dependencies: { next: '15.0.0' } }),
      'app/page.tsx': 'x',
      'app/about/page.tsx': 'x',
      'app/blog/[slug]/page.tsx': 'x',
      'app/blog/[slug]/button.tsx': 'x',
      'app/layout.tsx': 'x',
    });
    expect(await detectFramework(root)).toBe('nextjs');
    const { routes } = await detectRoutes(root);
    expect(routes.map((r) => r.path).sort()).toEqual(['/', '/about', '/blog/1']);
    expect(routes.find((r) => r.path === '/blog/1')!.sampled).toBe(true);
  });

  it('reads the Next.js routes manifest when present', async () => {
    await project({
      'package.json': JSON.stringify({ dependencies: { next: '15.0.0' } }),
      '.next/routes-manifest.json': JSON.stringify({
        staticRoutes: [{ page: '/' }, { page: '/pricing' }, { page: '/api/health' }],
      }),
    });
    const { routes } = await detectRoutes(root);
    expect(routes.map((r) => r.path).sort()).toEqual(['/', '/pricing']);
    expect(routes[0]!.source).toBe('manifest');
  });

  it('detects Nuxt, SvelteKit, Astro, and React Router projects', async () => {
    await project({
      'package.json': JSON.stringify({ dependencies: { nuxt: '3.0.0' } }),
      'pages/index.vue': 'x',
      'pages/blog/[slug].vue': 'x',
    });
    expect(await detectFramework(root)).toBe('nuxt');

    const root2 = await import('node:fs/promises').then((fs) =>
      fs.mkdtemp(path.join(tmpdir(), 'ck-routes2-')),
    );
    try {
      await mkdir(path.join(root2, 'src/routes/docs'), { recursive: true });
      await writeFile(
        path.join(root2, 'package.json'),
        JSON.stringify({ dependencies: { '@sveltejs/kit': '2.0.0' } }),
      );
      await writeFile(path.join(root2, 'src/routes/+page.svelte'), 'x');
      await writeFile(path.join(root2, 'src/routes/docs/+page.svelte'), 'x');
      expect(await detectFramework(root2)).toBe('sveltekit');
      const svelte = await detectRoutes(root2);
      expect(svelte.routes.map((r) => r.path).sort()).toEqual(['/', '/docs']);
    } finally {
      await rm(root2, { recursive: true, force: true });
    }

    const root3 = await import('node:fs/promises').then((fs) =>
      fs.mkdtemp(path.join(tmpdir(), 'ck-routes3-')),
    );
    try {
      await mkdir(path.join(root3, 'src/pages'), { recursive: true });
      await writeFile(
        path.join(root3, 'package.json'),
        JSON.stringify({ dependencies: { 'react-router': '7.0.0', react: '19.0.0' } }),
      );
      await writeFile(
        path.join(root3, 'src/router.tsx'),
        `createBrowserRouter([{ path: "/", element: <A/> }, { path: "/users/:id", element: <B/> }])`,
      );
      expect(await detectFramework(root3)).toBe('react-router');
      const rr = await detectRoutes(root3);
      expect(rr.routes.map((r) => r.path).sort()).toEqual(['/', '/users/1']);
    } finally {
      await rm(root3, { recursive: true, force: true });
    }
  });

  it('returns unknown with no routes for empty projects', async () => {
    await project({});
    expect(await detectFramework(root)).toBe('unknown');
    await expect(detectRoutes(root)).resolves.toEqual({ framework: 'unknown', routes: [] });
    await expect(detectRoutes(path.join(root, 'missing'))).resolves.toEqual({
      framework: 'unknown',
      routes: [],
    });
  });

  it('rankPages orders home, nav, inbound, then short paths', () => {
    expect(
      rankPages(['/z', '/pricing', '/', '/about'], {
        navLinks: ['/pricing'],
        inbound: { '/z': 5 },
      }),
    ).toEqual(['/', '/pricing', '/z', '/about']);
  });
});
