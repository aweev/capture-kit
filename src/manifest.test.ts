import { describe, it, expect } from 'vitest';
import {
  buildManifest,
  assetFromJob,
  writeManifest,
  readManifest,
  type ManifestAsset,
} from './manifest.ts';
import { join } from 'node:path';
import { mkdir, rm } from 'node:fs/promises';

describe('manifest.ts', () => {
  const mockAssets: ManifestAsset[] = [
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
      bytes: 12345,
      contentHeight: 1000,
      attempts: 1,
      durationMs: 500,
      strategy: 'standard waits',
    },
  ];

  const mockFailures = [
    {
      page: '/broken',
      viewport: 'desktop',
      type: 'screenshot' as const,
      reason: 'HTTP 404',
      attempts: 3,
      attemptLog: [],
      durationMs: 5000,
    },
  ];

  describe('buildManifest', () => {
    it('creates a valid manifest with correct schema', () => {
      const manifest = buildManifest({
        runId: 'abc123',
        startedAt: new Date('2024-01-01T00:00:00Z'),
        finishedAt: new Date('2024-01-01T00:01:00Z'),
        target: 'http://localhost:3000',
        version: '0.0.1',
        chromium: '120.0.0',
        configSource: 'defaults and CLI flags',
        concurrency: 4,
        viewports: ['mobile', 'desktop'],
        planned: 2,
        assets: mockAssets,
        failures: mockFailures,
      });

      expect(manifest.schemaVersion).toBe(1);
      expect(manifest.runId).toBe('abc123');
      expect(manifest.target).toBe('http://localhost:3000');
      expect(manifest.tool.name).toBe('capturekit');
      expect(manifest.tool.version).toBe('0.0.1');
      expect(manifest.tool.chromium).toBe('120.0.0');
      expect(manifest.config.source).toBe('defaults and CLI flags');
      expect(manifest.config.concurrency).toBe(4);
      expect(manifest.config.viewports).toEqual(['mobile', 'desktop']);
      expect(manifest.summary.planned).toBe(2);
      expect(manifest.summary.succeeded).toBe(1);
      expect(manifest.summary.failed).toBe(1);
      expect(manifest.assets).toHaveLength(1);
      expect(manifest.failures).toHaveLength(1);
    });

    it('calculates duration correctly', () => {
      const manifest = buildManifest({
        runId: 'abc123',
        startedAt: new Date('2024-01-01T00:00:00Z'),
        finishedAt: new Date('2024-01-01T00:00:30Z'),
        target: 'http://localhost:3000',
        version: '0.0.1',
        chromium: '120.0.0',
        configSource: 'test',
        concurrency: 4,
        viewports: ['mobile'],
        planned: 1,
        assets: mockAssets,
        failures: [],
      });

      expect(manifest.durationMs).toBe(30000);
    });

    it('counts retried assets', () => {
      const assetsWithRetry: ManifestAsset[] = [
        { ...mockAssets[0]!, attempts: 2 },
        { ...mockAssets[0]!, page: '/about', attempts: 1 },
      ];

      const manifest = buildManifest({
        runId: 'abc123',
        startedAt: new Date('2024-01-01T00:00:00Z'),
        finishedAt: new Date('2024-01-01T00:01:00Z'),
        target: 'http://localhost:3000',
        version: '0.0.1',
        chromium: '120.0.0',
        configSource: 'test',
        concurrency: 4,
        viewports: ['mobile'],
        planned: 2,
        assets: assetsWithRetry,
        failures: [],
      });

      expect(manifest.summary.retried).toBe(1);
    });

    it('includes gitRef when provided', () => {
      const manifest = buildManifest({
        runId: 'abc123',
        startedAt: new Date('2024-01-01T00:00:00Z'),
        finishedAt: new Date('2024-01-01T00:01:00Z'),
        target: 'http://localhost:3000',
        version: '0.0.1',
        chromium: '120.0.0',
        gitRef: 'main@abc123',
        configSource: 'test',
        concurrency: 4,
        viewports: ['mobile'],
        planned: 1,
        assets: mockAssets,
        failures: [],
      });

      expect(manifest.gitRef).toBe('main@abc123');
    });
  });

  describe('assetFromJob', () => {
    it('creates asset from job with all fields', () => {
      const job = {
        id: '/@mobile',
        pagePath: '/',
        pageSlug: 'home',
        url: 'http://localhost:3000/',
        device: { name: 'mobile', width: 390, height: 844, deviceScaleFactor: 3, mobile: true },
        mode: 'fullPage' as const,
        relPath: 'screenshots/home/mobile.png',
      };

      const asset = assetFromJob(job, {
        bytes: 12345,
        contentHeight: 1000,
        attempts: 1,
        durationMs: 500,
        strategy: 'standard waits',
      });

      expect(asset.page).toBe('/');
      expect(asset.viewport).toBe('mobile');
      expect(asset.path).toBe('screenshots/home/mobile.png');
      expect(asset.width).toBe(390);
      expect(asset.height).toBe(844);
      expect(asset.deviceScaleFactor).toBe(3);
      expect(asset.fullPage).toBe(true);
      expect(asset.mode).toBeUndefined();
      expect(asset.selector).toBeUndefined();
      expect(asset.bytes).toBe(12345);
      expect(asset.contentHeight).toBe(1000);
      expect(asset.attempts).toBe(1);
      expect(asset.durationMs).toBe(500);
      expect(asset.strategy).toBe('standard waits');
    });

    it('records selector + clip for element mode', () => {
      const job = {
        id: '/@mobile',
        pagePath: '/',
        pageSlug: 'home',
        url: 'http://localhost:3000/',
        device: { name: 'mobile', width: 390, height: 844, deviceScaleFactor: 3, mobile: true },
        mode: 'element' as const,
        selector: '.hero',
        relPath: 'screenshots/home/mobile-element.png',
      };

      const asset = assetFromJob(job, {
        bytes: 5000,
        contentHeight: 844,
        attempts: 1,
        durationMs: 300,
        strategy: 'standard waits',
        clip: { x: 0, y: 0, width: 390, height: 300 },
      });

      expect(asset.mode).toBe('element');
      expect(asset.selector).toBe('.hero');
      expect(asset.clip).toEqual({ x: 0, y: 0, width: 390, height: 300 });
    });

    it('uses viewport height for contentHeight when not fullPage', () => {
      const job = {
        id: '/@mobile',
        pagePath: '/',
        pageSlug: 'home',
        url: 'http://localhost:3000/',
        device: { name: 'mobile', width: 390, height: 844, deviceScaleFactor: 3, mobile: true },
        mode: 'viewport' as const,
        relPath: 'screenshots/home/mobile.png',
      };

      const asset = assetFromJob(job, {
        bytes: 12345,
        contentHeight: 844,
        attempts: 1,
        durationMs: 500,
        strategy: 'standard waits',
      });

      expect(asset.contentHeight).toBe(844);
      expect(asset.fullPage).toBe(false);
    });
  });

  describe('writeManifest/readManifest', () => {
    const testDir = join(process.cwd(), 'test-manifest-tmp');

    it('round-trips a manifest', async () => {
      await mkdir(testDir, { recursive: true });

      const manifest = buildManifest({
        runId: 'abc123',
        startedAt: new Date('2024-01-01T00:00:00Z'),
        finishedAt: new Date('2024-01-01T00:01:00Z'),
        target: 'http://localhost:3000',
        version: '0.0.1',
        chromium: '120.0.0',
        configSource: 'test',
        concurrency: 4,
        viewports: ['mobile'],
        planned: 1,
        assets: mockAssets,
        failures: mockFailures,
      });

      await writeManifest(testDir, manifest);
      const read = await readManifest(testDir);

      expect(read.runId).toBe(manifest.runId);
      expect(read.target).toBe(manifest.target);
      expect(read.assets).toHaveLength(1);
      expect(read.failures).toHaveLength(1);

      await rm(testDir, { recursive: true, force: true });
    });
  });
});
