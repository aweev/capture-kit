import { describe, it, expect } from 'vitest';
import { resolveApiKey, chatCompletion } from './ai-client.ts';
import type { AiConfig } from './ai-config.ts';

function config(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    enabled: true,
    provider: 'openai-compatible',
    baseUrl: 'https://api.example.com/v1',
    model: 'test-model',
    timeoutMs: 5000,
    maxImageBytes: 2_000_000,
    maxAltAssets: 20,
    ...overrides,
  };
}

describe('ai-client.ts', () => {
  it('resolveApiKey resolves $ENV refs and rejects missing keys', () => {
    process.env.CK_TEST_AI_KEY = 'sk-test';
    expect(resolveApiKey(config({ apiKey: '$ENV:CK_TEST_AI_KEY' }))).toBe('sk-test');
    delete process.env.CK_TEST_AI_KEY;
    expect(() => resolveApiKey(config())).toThrow('API key');
    expect(() => resolveApiKey(config({ apiKey: '$ENV:CK_TEST_AI_KEY' }))).toThrow();
  });

  it('chatCompletion posts model + messages and returns content', async () => {
    const seen: { url: string; body: string; auth: string }[] = [];
    const fetchFn = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
      seen.push({ url, body: init.body, auth: init.headers.Authorization ?? '' });
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'hello' } }] }) };
    }) as unknown as typeof fetch;
    const out = await chatCompletion(
      config({ apiKey: 'sk-x' }),
      [{ role: 'user', content: 'hi' }],
      { fetchFn },
    );
    expect(out).toBe('hello');
    expect(seen[0]!.url).toBe('https://api.example.com/v1/chat/completions');
    expect(JSON.parse(seen[0]!.body).model).toBe('test-model');
    expect(seen[0]!.auth).toBe('Bearer sk-x');
  });

  it('chatCompletion redacts secrets in errors', async () => {
    const fetchFn = (async () => ({
      ok: false,
      status: 401,
      text: async () => 'invalid api key Bearer sk-live-secret-123',
    })) as unknown as typeof fetch;
    await expect(
      chatCompletion(config({ apiKey: 'sk-live-secret-123' }), [{ role: 'user', content: 'hi' }], {
        fetchFn,
      }),
    ).rejects.toThrow(/\[redacted\]/);
    await expect(
      chatCompletion(config({ apiKey: 'sk-live-secret-123' }), [{ role: 'user', content: 'hi' }], {
        fetchFn,
      }).catch((err: Error) => {
        if (err.message.includes('sk-live-secret-123')) throw new Error('leaked!');
        throw err;
      }),
    ).rejects.toThrow();
  });

  it('chatCompletion throws on empty choices', async () => {
    const fetchFn = (async () => ({
      ok: true,
      json: async () => ({ choices: [] }),
    })) as unknown as typeof fetch;
    await expect(
      chatCompletion(config({ apiKey: 'k' }), [{ role: 'user', content: 'hi' }], { fetchFn }),
    ).rejects.toThrow('no content');
  });
});
