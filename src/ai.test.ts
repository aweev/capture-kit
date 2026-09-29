import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateAltText } from './ai-alt.ts';
import { suggestFlows } from './ai-flows.ts';
import { generateClientSummary } from './ai-summary.ts';
import type { AiConfig } from './ai-config.ts';
import type { ManifestAsset } from './manifest.ts';

function config(): AiConfig {
  return {
    enabled: true,
    provider: 'openai-compatible',
    baseUrl: 'https://api.example.com/v1',
    model: 'test-model',
    apiKey: 'k',
    timeoutMs: 5000,
    maxImageBytes: 2_000_000,
    maxAltAssets: 20,
  };
}

function asset(partial: Partial<ManifestAsset> = {}): ManifestAsset {
  return {
    page: '/',
    viewport: 'mobile',
    type: 'screenshot',
    path: 'screenshots/home/mobile.png',
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    fullPage: true,
    mode: undefined,
    format: 'png',
    bytes: 100,
    contentHeight: 900,
    attempts: 1,
    durationMs: 10,
    strategy: 'standard waits',
    ...partial,
  };
}

describe('ai-alt.ts', () => {
  it('maps model output to asset paths and skips oversized images', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ck-alt-'));
    try {
      await writeFile(path.join(dir, 'tiny.png'), Buffer.alloc(100, 7));
      const fetchFn = (async () => ({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ 0: { alt: 'A page', caption: 'Nice' } }) } }],
        }),
      })) as unknown as typeof fetch;
      const out = await generateAltText(
        config(),
        dir,
        [asset({ path: 'tiny.png', bytes: 100 }), asset({ path: 'huge.png', bytes: 99_000_000 })],
        { fetchFn },
      );
      expect(out['tiny.png']).toEqual({ alt: 'A page', caption: 'Nice' });
      expect(out['huge.png']).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns {} when nothing is describable', async () => {
    const fetchFn = (async () => {
      throw new Error('should not be called');
    }) as unknown as typeof fetch;
    await expect(generateAltText(config(), '/nonexistent', [], { fetchFn })).resolves.toEqual({});
  });
});

describe('ai-flows.ts', () => {
  it('validates suggested flows against the schema', async () => {
    const fetchFn = (async () => ({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                flows: [{ name: 'Signup', steps: [{ goto: '/signup' }, { click: 'text=Go' }] }],
              }),
            },
          },
        ],
      }),
    })) as unknown as typeof fetch;
    const flows = await suggestFlows(config(), { url: 'http://x', goal: 'show signup', fetchFn });
    expect(flows).toHaveLength(1);
    expect(flows[0]!.name).toBe('Signup');
  });

  it('rejects invalid suggested steps', async () => {
    const fetchFn = (async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ flows: [{ name: 'Bad', steps: [{ nope: 1 }] }] }) } }],
      }),
    })) as unknown as typeof fetch;
    await expect(suggestFlows(config(), { url: 'http://x', goal: 'g', fetchFn })).rejects.toThrow(
      'invalid',
    );
  });
});

describe('ai-summary.ts', () => {
  it('returns model text built from manifest (git optional)', async () => {
    const fetchFn = (async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '## Update\n- things' } }] }),
    })) as unknown as typeof fetch;
    const out = await generateClientSummary(
      config(),
      {
        runId: 'r',
        startedAt: '',
        finishedAt: '',
        durationMs: 1,
        target: 'http://x',
        tool: { name: 'capturekit', version: '0', chromium: 'c' },
        config: { source: 't', concurrency: 1, viewports: ['mobile'] },
        summary: { planned: 1, succeeded: 1, failed: 0, retried: 0, durationMs: 1 },
        assets: [asset()],
        failures: [],
        schemaVersion: 1,
      },
      { cwd: tmpdir(), fetchFn },
    );
    expect(out).toContain('## Update');
  });
});
