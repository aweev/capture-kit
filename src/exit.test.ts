import { describe, it, expect } from 'vitest';
import { ExitCode, CaptureKitError, isCaptureKitError } from './exit.ts';

describe('exit.ts', () => {
  describe('ExitCode', () => {
    it('has correct values', () => {
      expect(ExitCode.Ok).toBe(0);
      expect(ExitCode.CaptureFailed).toBe(1);
      expect(ExitCode.Usage).toBe(2);
      expect(ExitCode.Config).toBe(3);
      expect(ExitCode.Environment).toBe(4);
      expect(ExitCode.Interrupted).toBe(130);
    });
  });

  describe('CaptureKitError', () => {
    it('creates error with message, code, and hint', () => {
      const error = new CaptureKitError(
        'Something went wrong',
        ExitCode.Config,
        'Check your config',
      );

      expect(error.message).toBe('Something went wrong');
      expect(error.code).toBe(ExitCode.Config);
      expect(error.hint).toBe('Check your config');
      expect(error.name).toBe('CaptureKitError');
    });

    it('creates error without hint', () => {
      const error = new CaptureKitError('Something went wrong', ExitCode.Usage);

      expect(error.message).toBe('Something went wrong');
      expect(error.code).toBe(ExitCode.Usage);
      expect(error.hint).toBeUndefined();
    });

    it('is instanceof Error', () => {
      const error = new CaptureKitError('test', ExitCode.Ok);
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe('isCaptureKitError', () => {
    it('returns true for CaptureKitError', () => {
      const error = new CaptureKitError('test', ExitCode.Ok);
      expect(isCaptureKitError(error)).toBe(true);
    });

    it('returns false for regular Error', () => {
      const error = new Error('regular error');
      expect(isCaptureKitError(error)).toBe(false);
    });

    it('returns false for plain objects', () => {
      expect(isCaptureKitError({ message: 'test' })).toBe(false);
    });

    it('returns false for null/undefined', () => {
      expect(isCaptureKitError(null)).toBe(false);
      expect(isCaptureKitError(undefined)).toBe(false);
    });

    it('returns false for strings', () => {
      expect(isCaptureKitError('error string')).toBe(false);
    });

    it('returns false for numbers', () => {
      expect(isCaptureKitError(123)).toBe(false);
    });
  });
});
