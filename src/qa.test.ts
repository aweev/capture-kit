import { describe, it, expect } from 'vitest';
import { runQaChecks, qaPageFrom, type QaPage } from './qa.ts';

function fakePage(
  raw: { rule: string; selector: string; message: string }[] | null | 'throw',
): QaPage {
  return {
    evaluate: async () => {
      if (raw === 'throw') throw new Error('hostile dom');
      return raw;
    },
  };
}

describe('qa.ts', () => {
  it('maps known rules to warn findings', async () => {
    const findings = await runQaChecks(
      fakePage([
        { rule: 'horizontal-overflow', selector: 'div.wide', message: 'too wide' },
        { rule: 'clipped-text', selector: 'h1', message: 'clipped' },
        { rule: 'overlap', selector: 'span', message: 'overlap' },
        { rule: 'something-else', selector: 'x', message: 'ignored' },
      ]),
    );
    expect(findings).toHaveLength(3);
    expect(findings.every((f) => f.severity === 'warn')).toBe(true);
  });

  it('returns [] when evaluation throws or yields null', async () => {
    await expect(runQaChecks(fakePage('throw'))).resolves.toEqual([]);
    await expect(runQaChecks(fakePage(null))).resolves.toEqual([]);
  });

  it('qaPageFrom adapts a page-like object', async () => {
    const adapted = qaPageFrom({
      evaluate: (async (fn: (arg: { sample: number; perRule: number }) => unknown) =>
        fn({ sample: 1, perRule: 1 })) as never,
    });
    await expect(
      adapted.evaluate(() => [{ rule: 'overlap', selector: 's', message: 'm' }], {
        sample: 1,
        perRule: 1,
      }),
    ).resolves.toHaveLength(1);
  });
});
