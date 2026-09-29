import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Logger, describeError } from './log.ts';

describe('log.ts', () => {
  describe('Logger', () => {
    let consoleOutput: string[];
    let fileOutput: any[];

    beforeEach(() => {
      consoleOutput = [];
      fileOutput = [];

      const logger = new Logger({
        level: 'debug',
        console: (line) => consoleOutput.push(line),
        file: (record) => fileOutput.push(record),
      });
    });

    it('logs debug messages when level is debug', () => {
      const logger = new Logger({
        level: 'debug',
        console: (line) => consoleOutput.push(line),
        file: (record) => fileOutput.push(record),
      });

      logger.debug('debug message', { key: 'value' });

      expect(consoleOutput).toHaveLength(1);
      expect(consoleOutput[0]).toContain('debug message');
      expect(consoleOutput[0]).toContain('key');
      expect(fileOutput).toHaveLength(1);
      expect(fileOutput[0].level).toBe('debug');
    });

    it('does not log debug messages when level is info', () => {
      const logger = new Logger({
        level: 'info',
        console: (line) => consoleOutput.push(line),
        file: (record) => fileOutput.push(record),
      });

      logger.debug('debug message');

      expect(consoleOutput).toHaveLength(0);
      expect(fileOutput).toHaveLength(1);
    });

    it('logs info messages', () => {
      const logger = new Logger({
        level: 'info',
        console: (line) => consoleOutput.push(line),
        file: (record) => fileOutput.push(record),
      });

      logger.info('info message');

      expect(consoleOutput).toHaveLength(1);
      expect(consoleOutput[0]).toContain('info message');
    });

    it('logs warn messages', () => {
      const logger = new Logger({
        level: 'info',
        console: (line) => consoleOutput.push(line),
        file: (record) => fileOutput.push(record),
      });

      logger.warn('warn message');

      expect(consoleOutput).toHaveLength(1);
      expect(consoleOutput[0]).toContain('warn message');
    });

    it('logs error messages', () => {
      const logger = new Logger({
        level: 'info',
        console: (line) => consoleOutput.push(line),
        file: (record) => fileOutput.push(record),
      });

      logger.error('error message');

      expect(consoleOutput).toHaveLength(1);
      expect(consoleOutput[0]).toContain('error message');
    });

    it('includes fields in file output', () => {
      const logger = new Logger({
        level: 'info',
        console: () => {},
        file: (record) => fileOutput.push(record),
      });

      logger.info('test', { foo: 'bar', count: 42 });

      expect(fileOutput[0].fields).toEqual({ foo: 'bar', count: 42 });
    });

    it('includes timestamp in file output', () => {
      const logger = new Logger({
        level: 'info',
        console: () => {},
        file: (record) => fileOutput.push(record),
      });

      logger.info('test');

      expect(fileOutput[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    describe('withFile', () => {
      it('creates a new logger with file sink', () => {
        const logger = new Logger({
          level: 'info',
          console: (line) => consoleOutput.push(line),
          file: () => {},
        });

        const newFileOutput: any[] = [];
        const loggerWithFile = logger.withFile((record) => newFileOutput.push(record));

        loggerWithFile.info('test with file');

        expect(newFileOutput).toHaveLength(1);
        expect(newFileOutput[0].msg).toBe('test with file');
        expect(consoleOutput).toHaveLength(1);
      });

      it('preserves threshold and quiet settings', () => {
        const logger = new Logger({
          level: 'warn',
          quiet: true,
          console: (line) => consoleOutput.push(line),
          file: () => {},
        });

        const newFileOutput: any[] = [];
        const loggerWithFile = logger.withFile((record) => newFileOutput.push(record));

        loggerWithFile.debug('should not appear in console');
        loggerWithFile.info('should not appear in console');
        loggerWithFile.warn('should appear in console');

        expect(consoleOutput).toHaveLength(1);
        expect(consoleOutput[0]).toContain('should appear in console');
      });
    });

    describe('quiet option', () => {
      it('suppresses debug and info in console when quiet', () => {
        const logger = new Logger({
          level: 'debug',
          quiet: true,
          console: (line) => consoleOutput.push(line),
          file: (record) => fileOutput.push(record),
        });

        logger.debug('debug');
        logger.info('info');
        logger.warn('warn');
        logger.error('error');

        expect(consoleOutput).toHaveLength(2);
        expect(consoleOutput.some((l) => l.includes('warn'))).toBe(true);
        expect(consoleOutput.some((l) => l.includes('error'))).toBe(true);
      });

      it('still writes all levels to file when quiet', () => {
        const logger = new Logger({
          level: 'debug',
          quiet: true,
          console: (line) => consoleOutput.push(line),
          file: (record) => fileOutput.push(record),
        });

        logger.debug('debug');
        logger.info('info');
        logger.warn('warn');
        logger.error('error');

        expect(fileOutput).toHaveLength(4);
      });
    });
  });

  describe('describeError', () => {
    it('extracts message and hint from CaptureKitError', () => {
      const error = new Error('test error');
      (error as any).hint = 'try this';

      const result = describeError(error);

      expect(result.message).toBe('test error');
      expect(result.hint).toBe('try this');
    });

    it('extracts message from regular Error', () => {
      const error = new Error('regular error');

      const result = describeError(error);

      expect(result.message).toBe('regular error');
      expect(result.hint).toBeUndefined();
    });

    it('handles non-Error objects', () => {
      const result = describeError('string error');

      expect(result.message).toBe('string error');
      expect(result.hint).toBeUndefined();
    });

    it('handles null', () => {
      const result = describeError(null);

      expect(result.message).toBe('null');
    });
  });
});
