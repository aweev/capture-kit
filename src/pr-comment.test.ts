import { describe, it, expect } from 'vitest';
import {
  buildPrComment,
  parseGitHubRef,
  postOrUpdateComment,
  PR_COMMENT_MARKER,
} from './pr-comment.ts';
import type { Manifest } from './manifest.ts';

function manifest(): Manifest {
  return {
    schemaVersion: 1,
    runId: 'a1b2c3',
    startedAt: '2026-09-29T14:32:10Z',
    finishedAt: '2026-09-29T14:32:48Z',
    durationMs: 38000,
    target: 'http://localhost:3000',
    tool: { name: 'capturekit', version: '0.0.1', chromium: '120' },
    config: { source: 'test', concurrency: 4, viewports: ['mobile'] },
    summary: { planned: 3, succeeded: 2, failed: 1, retried: 0, durationMs: 38000 },
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
        durationMs: 100,
        strategy: 'standard waits',
      },
      {
        page: '/pricing',
        viewport: 'mobile',
        type: 'screenshot',
        path: 'screenshots/pricing/mobile-dark.png',
        width: 390,
        height: 844,
        deviceScaleFactor: 3,
        fullPage: true,
        format: 'png',
        scheme: 'dark',
        bytes: 10,
        contentHeight: 900,
        attempts: 1,
        durationMs: 100,
        strategy: 'standard waits',
      },
    ],
    failures: [
      {
        page: '/broken',
        viewport: 'mobile',
        type: 'screenshot',
        reason: 'HTTP 404',
        attempts: 3,
        attemptLog: [],
        durationMs: 100,
      },
    ],
  };
}

describe('pr-comment.ts', () => {
  it('starts with the idempotency marker and a summary', () => {
    const body = buildPrComment(manifest());
    expect(body.startsWith(`${PR_COMMENT_MARKER}\n`)).toBe(true);
    expect(body).toContain('2/3 succeeded');
    expect(body).toContain('screenshots/home/mobile.png');
    expect(body).toContain('HTTP 404');
  });

  it('renders inline thumbnails when a preview URL is given', () => {
    const body = buildPrComment(manifest(), { previewUrl: 'https://preview.example.com/cap/' });
    expect(body).toContain(
      '![/ · mobile](https://preview.example.com/cap/screenshots/home/mobile.png)',
    );
  });

  it('collapses overflow assets', () => {
    const m = manifest();
    m.assets = Array.from({ length: 15 }, (_, i) => ({ ...m.assets[0]!, path: `s/${i}.png` }));
    const body = buildPrComment(m, { maxRows: 5 });
    expect(body).toContain('…and 10 more assets');
  });

  it('parseGitHubRef accepts owner/repo#123', () => {
    expect(parseGitHubRef('acme/shop#42')).toEqual({ owner: 'acme', repo: 'shop', pr: 42 });
    expect(() => parseGitHubRef('nope')).toThrow();
  });

  it('creates when no marker comment exists', async () => {
    const calls: { url: string; method?: string }[] = [];
    const fetchFn = (async (url: string, init?: { method?: string }) => {
      calls.push({ url, method: init?.method ?? 'GET' });
      if ((init?.method ?? 'GET') === 'GET') {
        return { ok: true, json: async () => [{ id: 1, body: 'unrelated' }] };
      }
      return { ok: true, json: async () => ({ id: 7 }) };
    }) as unknown as typeof fetch;
    const result = await postOrUpdateComment(
      { owner: 'a', repo: 'b', pr: 3 },
      'body',
      'token',
      fetchFn,
    );
    expect(result).toEqual({ created: true, id: 7 });
    expect(calls.some((c) => c.method === 'POST')).toBe(true);
  });

  it('updates the marker comment in place', async () => {
    const calls: { url: string; method?: string }[] = [];
    const fetchFn = (async (url: string, init?: { method?: string }) => {
      calls.push({ url, method: init?.method ?? 'GET' });
      if ((init?.method ?? 'GET') === 'GET') {
        return { ok: true, json: async () => [{ id: 9, body: `hi\n${PR_COMMENT_MARKER}` }] };
      }
      return { ok: true, json: async () => ({}) };
    }) as unknown as typeof fetch;
    const result = await postOrUpdateComment(
      { owner: 'a', repo: 'b', pr: 3 },
      'new body',
      'token',
      fetchFn,
    );
    expect(result).toEqual({ created: false, id: 9 });
    expect(calls.some((c) => c.method === 'PATCH' && c.url.endsWith('/issues/comments/9'))).toBe(
      true,
    );
  });

  it('throws on API errors', async () => {
    const fetchFn = (async () => ({ ok: false, status: 403 })) as unknown as typeof fetch;
    await expect(
      postOrUpdateComment({ owner: 'a', repo: 'b', pr: 3 }, 'b', 't', fetchFn),
    ).rejects.toThrow('HTTP 403');
  });
});
