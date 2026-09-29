import { describe, it, expect, afterEach } from 'vitest';
import { resolveSecret, redactSecrets, resolveAuth } from './auth.ts';

describe('auth.ts', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('resolveSecret passes plain values through', () => {
    expect(resolveSecret('plain-value')).toBe('plain-value');
  });

  it('resolveSecret resolves $ENV: refs', () => {
    process.env.CAPTUREKIT_TEST_TOKEN = 's3cret';
    expect(resolveSecret('$ENV:CAPTUREKIT_TEST_TOKEN')).toBe('s3cret');
  });

  it('resolveSecret throws on missing env', () => {
    delete process.env.CAPTUREKIT_DEFINITELY_MISSING;
    expect(() => resolveSecret('$ENV:CAPTUREKIT_DEFINITELY_MISSING')).toThrow();
  });

  it('redactSecrets scrubs tokens and env refs', () => {
    expect(redactSecrets('token: abc123 password= hunter2')).toContain('[redacted]');
    expect(redactSecrets('Authorization: Bearer abcdefgh1234')).toContain('Bearer [redacted]');
    expect(redactSecrets('uses $ENV:MY_TOKEN here')).toContain('[env-secret]');
  });

  it('resolveAuth resolves header secrets and reports recipe', () => {
    process.env.CAPTUREKIT_TEST_TOKEN = 'tok';
    const auth = resolveAuth(
      {
        storageState: '.auth/state.json',
        headers: { Authorization: '$ENV:CAPTUREKIT_TEST_TOKEN' },
        cookies: [],
      },
      '/tmp',
    );
    expect(auth.headers.Authorization).toBe('tok');
    expect(auth.hasRecipe).toBe(false);
  });
});
