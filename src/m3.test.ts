import { describe, it, expect } from 'vitest';
import { parseConfig, buildConfig } from './config.ts';

describe('M3 wiring', () => {
  it('config defaults to no managed app', () => {
    const config = parseConfig({ target: 'http://localhost:3000' }, 'test');
    expect(config.start).toBeUndefined();
  });

  it('config accepts a start block', () => {
    const config = parseConfig(
      {
        target: 'http://localhost:3000',
        start: { command: 'npm run dev', waitOn: 'http://localhost:3000/health' },
      },
      'test',
    );
    expect(config.start?.command).toBe('npm run dev');
    expect(config.start?.timeoutMs).toBe(60000);
  });

  it('config rejects a start block without a command', () => {
    expect(() =>
      parseConfig(
        { target: 'http://localhost:3000', start: { waitOn: 'http://localhost:3000/health' } },
        'test',
      ),
    ).toThrow();
  });

  it('CLI flags feed the start block', async () => {
    const config = await buildConfig({
      url: 'http://localhost:3000',
      noConfig: true,
      startCommand: 'npm run dev',
      waitOn: 'http://localhost:3000/health',
      cwd: '/tmp',
    });
    expect(config.start?.command).toBe('npm run dev');
    expect(config.start?.waitOn).toBe('http://localhost:3000/health');
  });
});
