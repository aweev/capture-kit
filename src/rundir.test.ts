import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRun, writeLatestPointer, readLatestPointer, stamp } from './rundir.ts';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

describe('rundir.ts', () => {
  const testOutDir = join(process.cwd(), 'test-rundir-tmp');

  beforeEach(async () => {
    await rm(testOutDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    await rm(testOutDir, { recursive: true, force: true });
  });

  describe('stamp', () => {
    it('formats date as UTC without colons', () => {
      const date = new Date('2024-01-15T14:30:45.123Z');
      expect(stamp(date)).toBe('2024-01-15T14-30-45');
    });

    it('handles different dates', () => {
      const date = new Date('2026-12-31T23:59:59.999Z');
      expect(stamp(date)).toBe('2026-12-31T23-59-59');
    });
  });

  describe('createRun', () => {
    it('creates run directory with correct structure', async () => {
      const run = await createRun(testOutDir);

      expect(run.runId).toMatch(/^[0-9a-f]{6}$/);
      expect(run.dirName).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}_[0-9a-f]{6}$/);
      expect(run.dir).toBe(join(testOutDir, run.dirName));
      expect(run.screenshotsDir).toBe(join(run.dir, 'screenshots'));
      expect(run.logsDir).toBe(join(run.dir, 'logs'));
      expect(run.tracesDir).toBe(join(run.dir, 'logs', 'traces'));
      expect(run.startedAt).toBeInstanceOf(Date);
    });

    it('creates all required directories', async () => {
      const run = await createRun(testOutDir);

      const { stat } = await import('node:fs/promises');
      await expect(stat(run.screenshotsDir)).resolves.toBeTruthy();
      await expect(stat(run.logsDir)).resolves.toBeTruthy();
      await expect(stat(run.tracesDir)).resolves.toBeTruthy();
    });

    it('generates unique runIds', async () => {
      const run1 = await createRun(testOutDir);
      const run2 = await createRun(testOutDir);

      expect(run1.runId).not.toBe(run2.runId);
      expect(run1.dirName).not.toBe(run2.dirName);
    });
  });

  describe('writeLatestPointer/readLatestPointer', () => {
    it('writes and reads the latest pointer', async () => {
      const run = await createRun(testOutDir);
      await writeLatestPointer(testOutDir, run);

      const latest = await readLatestPointer(testOutDir);
      expect(latest).toBe(run.dirName);
    });

    it('returns null when pointer does not exist', async () => {
      const latest = await readLatestPointer(join(testOutDir, 'nonexistent'));
      expect(latest).toBeNull();
    });

    it('returns null for empty pointer', async () => {
      const { writeFile, mkdir } = await import('node:fs/promises');
      await mkdir(testOutDir, { recursive: true });
      await writeFile(join(testOutDir, '.latest'), '', 'utf8');

      const latest = await readLatestPointer(testOutDir);
      expect(latest).toBeNull();
    });

    it('trims whitespace from pointer', async () => {
      const run = await createRun(testOutDir);
      await writeLatestPointer(testOutDir, run);

      const latest = await readLatestPointer(testOutDir);
      expect(latest).toBe(run.dirName.trim());
    });
  });
});
