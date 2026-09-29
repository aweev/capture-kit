import { describe, it, expect } from 'vitest';
import { parseConfig, buildConfig } from './config.ts';

describe('M1 wiring', () => {
  it('video and discovery default on (PRD zero-config promise)', () => {
    const config = parseConfig({ target: 'http://localhost:3000' }, 'test');
    expect(config.video.walkthrough).toBe(true);
    expect(config.video.formats).toEqual(['mp4']);
    expect(config.discovery.mode).toBe('auto');
    expect(config.discovery.depth).toBe(2);
    expect(config.discovery.maxPages).toBe(20);
  });

  it('accepts discovery + video configuration', () => {
    const config = parseConfig(
      {
        target: 'http://localhost:3000',
        discovery: { mode: 'off', depth: 1, maxPages: 5, exclude: ['/admin/**'] },
        video: { walkthrough: true, formats: ['mp4', 'gif'], maxSizeMB: 3, durationMs: 3000 },
      },
      'test',
    );
    expect(config.discovery.mode).toBe('off');
    expect(config.video.formats).toEqual(['mp4', 'gif']);
    expect(config.video.maxSizeMB).toBe(3);
  });

  it('--no-video and --no-discover flags reach the config', async () => {
    const config = await buildConfig({
      url: 'http://localhost:3000',
      noConfig: true,
      cwd: '/tmp',
      discover: false,
      videoWalkthrough: false,
    });
    expect(config.discovery.mode).toBe('off');
    expect(config.video.walkthrough).toBe(false);
  });
});
