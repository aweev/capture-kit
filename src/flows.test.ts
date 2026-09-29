import { describe, it, expect } from 'vitest';
import { flowSchema, flowSlug, runFlowSteps } from './flows.ts';

describe('flows.ts', () => {
  it('validates a checkout-style flow', () => {
    const flow = flowSchema.parse({
      name: 'Checkout',
      steps: [
        { goto: '/products' },
        { click: 'text=Add to cart' },
        { waitFor: 'text=Order summary' },
      ],
    });
    expect(flow.name).toBe('Checkout');
    expect(flow.steps).toHaveLength(3);
  });

  it('rejects empty steps and unknown keys', () => {
    expect(() => flowSchema.parse({ name: 'x', steps: [] })).toThrow();
    expect(() => flowSchema.parse({ name: 'x', steps: [{ click: 'a', evil: 1 }] })).toThrow();
  });

  it('flowSlug is filename-safe', () => {
    expect(flowSlug('Checkout Flow!')).toBe('checkout-flow');
    expect(flowSlug('  ')).toBe('flow');
  });

  it('runFlowSteps executes goto/click/scroll in order', async () => {
    const calls: string[] = [];
    const page = {
      goto: async (url: string) => {
        calls.push(`goto:${url}`);
      },
      click: async (sel: string) => {
        calls.push(`click:${sel}`);
      },
      fill: async () => {
        calls.push('fill');
      },
      hover: async () => {
        calls.push('hover');
      },
      locator: () => ({
        press: async () => {
          calls.push('press');
        },
        first: () => ({
          waitFor: async () => {
            calls.push('wait');
          },
        }),
      }),
      waitForSelector: async (sel: string) => {
        calls.push(`wait:${sel}`);
      },
      waitForTimeout: async () => undefined,
      evaluate: async () => undefined,
    };
    const flow = flowSchema.parse({
      name: 'demo',
      steps: [{ goto: '/a' }, { click: '#b' }, { scroll: 'bottom' }],
    });
    await runFlowSteps(page as never, flow, { base: new URL('http://localhost:3000') });
    expect(calls[0]).toBe('goto:http://localhost:3000/a');
    expect(calls[1]).toBe('click:#b');
  });

  it('runFlowSteps names the failing step', async () => {
    const page = {
      goto: async () => undefined,
      click: async () => {
        throw new Error('no such element');
      },
      evaluate: async () => undefined,
      waitForTimeout: async () => undefined,
    };
    const flow = flowSchema.parse({ name: 'broken', steps: [{ click: '#missing' }] });
    await expect(
      runFlowSteps(page as never, flow, { base: new URL('http://x.test') }),
    ).rejects.toThrow(/step 1\/1/);
  });
});
