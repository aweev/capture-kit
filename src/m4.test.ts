import { describe, it, expect } from 'vitest';
import { parseConfig, buildConfig } from './config.ts';

describe('M4 wiring', () => {
  it('AI and QA default to off', () => {
    const config = parseConfig({ target: 'http://localhost:3000' }, 'test');
    expect(config.ai.enabled).toBe(false);
    expect(config.qa.enabled).toBe(false);
  });

  it('accepts AI + QA configuration', () => {
    const config = parseConfig(
      {
        target: 'http://localhost:3000',
        ai: { enabled: true, apiKey: '$ENV:KEY', model: 'gpt-4o' },
        qa: { enabled: true, maxPerRule: 5 },
      },
      'test',
    );
    expect(config.ai.model).toBe('gpt-4o');
    expect(config.qa.maxPerRule).toBe(5);
  });

  it('--ai and --ai-key flags enable the layer', async () => {
    const config = await buildConfig({
      url: 'http://localhost:3000',
      noConfig: true,
      ai: true,
      aiKey: '$ENV:KEY',
      cwd: '/tmp',
    });
    expect(config.ai.enabled).toBe(true);
    expect(config.ai.apiKey).toBe('$ENV:KEY');
  });
});
