import { describe, it, expect } from 'vitest';
import { maskCss, applyMask, parseFreezeTime } from './determinism.ts';

describe('determinism.ts', () => {
  it('maskCss emits blackout rules per selector', () => {
    const css = maskCss(['.timestamp', '[data-ad]'], 'black');
    expect(css).toContain('.timestamp');
    expect(css).toContain('[data-ad]');
    expect(css).toContain('#000');
  });

  it('maskCss emits blur rules in blur mode', () => {
    expect(maskCss(['.ad'], 'blur')).toContain('blur(8px)');
  });

  it('maskCss is empty without selectors', () => {
    expect(maskCss([], 'black')).toBe('');
  });

  it('applyMask is a no-op without selectors', async () => {
    const page = {
      addStyleTag: async () => {
        throw new Error('should not be called');
      },
    };
    await expect(applyMask(page as never, [])).resolves.toBeUndefined();
  });

  it('parseFreezeTime accepts ISO dates and rejects garbage', () => {
    expect(parseFreezeTime('2026-01-01T00:00:00Z')).toBe(Date.parse('2026-01-01T00:00:00Z'));
    expect(() => parseFreezeTime('not-a-date')).toThrow();
  });
});
