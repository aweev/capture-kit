import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * Dependency-free static server for the fixture site used in PRD section 16
 * ("fixture sites served locally"). Started by `npm run fixture`.
 *
 * Intentionally minimal: it only serves files under fixtures/, resolves a
 * directory to its index.html, and never touches the network.
 */
const ROOT = path.join(process.cwd(), 'fixtures');
const PORT = Number(process.env.PORT ?? 4111);

/** @type {Record<string, string>} */
const TYPES = {
  '.html': 'text/html; charset=utf8',
  '.svg': 'image/svg+xml',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.png': 'image/png',
  '.json': 'application/json',
};

createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${PORT}`);
  const pathname = decodeURIComponent(url.pathname);

  // Discovery fixtures (FR-1): the origin is whatever port this run picked, so
  // these two are generated rather than static files on disk.
  const origin = `http://127.0.0.1:${PORT}`;
  if (pathname === '/robots.txt') {
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf8', 'cache-control': 'no-store' });
    response.end(
      ['User-agent: *', 'Disallow: /admin', 'Crawl-delay: 0', `Sitemap: ${origin}/sitemap.xml`, ''].join(
        '\n',
      ),
    );
    return;
  }
  if (pathname === '/sitemap.xml') {
    const locs = ['/', '/pricing', '/blog', '/blog/1', '/blog/2']
      .map((p) => `  <url><loc>${origin}${p}</loc></url>`)
      .join('\n');
    response.writeHead(200, {
      'content-type': 'application/xml; charset=utf8',
      'cache-control': 'no-store',
    });
    response.end(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${locs}\n</urlset>\n`,
    );
    return;
  }
  if (pathname.startsWith('/admin')) {
    response.writeHead(403, { 'content-type': 'text/plain' }).end('forbidden by robots');
    return;
  }

  let file = path.join(ROOT, pathname);

  // Containment guard: only paths inside fixtures/ are reachable, so `/../`
  // cannot escape the root.
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
    response.writeHead(403).end('forbidden');
    return;
  }

  try {
    // A directory is served as its index.html, and a path that names one is
    // redirected, so /pricing and /pricing/ both work (as any real host does).
    const info = await stat(file).catch(() => null);
    if (info?.isDirectory()) {
      if (!pathname.endsWith('/')) {
        response.writeHead(301, { location: pathname + '/' + (url.search ?? '') }).end();
        return;
      }
      file = path.join(file, 'index.html');
    }
    const body = await readFile(file);
    const type = TYPES[path.extname(file)] ?? 'application/octet-stream';
    response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    response.end(body);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }
}).listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`fixtures at http://127.0.0.1:${PORT}\n`);
});
