import { describe, it, expect } from 'vitest';
import { DEVICES, DEFAULT_VIEWPORTS, DEVICE_NAMES, isDeviceName } from './devices.ts';

describe('devices.ts', () => {
  describe('DEVICES', () => {
    it('has 4 built-in profiles', () => {
      expect(Object.keys(DEVICES)).toHaveLength(4);
    });

    it('has mobile profile with correct properties', () => {
      const mobile = DEVICES.mobile;
      expect(mobile.name).toBe('mobile');
      expect(mobile.width).toBe(390);
      expect(mobile.height).toBe(844);
      expect(mobile.deviceScaleFactor).toBe(3);
      expect(mobile.mobile).toBe(true);
    });

    it('has tablet profile with correct properties', () => {
      const tablet = DEVICES.tablet;
      expect(tablet.name).toBe('tablet');
      expect(tablet.width).toBe(834);
      expect(tablet.height).toBe(1112);
      expect(tablet.deviceScaleFactor).toBe(2);
      expect(tablet.mobile).toBe(true);
    });

    it('has laptop profile with correct properties', () => {
      const laptop = DEVICES.laptop;
      expect(laptop.name).toBe('laptop');
      expect(laptop.width).toBe(1440);
      expect(laptop.height).toBe(900);
      expect(laptop.deviceScaleFactor).toBe(2);
      expect(laptop.mobile).toBe(false);
    });

    it('has desktop profile with correct properties', () => {
      const desktop = DEVICES.desktop;
      expect(desktop.name).toBe('desktop');
      expect(desktop.width).toBe(1920);
      expect(desktop.height).toBe(1080);
      expect(desktop.deviceScaleFactor).toBe(2);
      expect(desktop.mobile).toBe(false);
    });
  });

  describe('DEFAULT_VIEWPORTS', () => {
    it('includes mobile, tablet, desktop', () => {
      expect(DEFAULT_VIEWPORTS).toEqual(['mobile', 'tablet', 'desktop']);
    });
  });

  describe('DEVICE_NAMES', () => {
    it('lists all device names', () => {
      expect(DEVICE_NAMES).toEqual(['mobile', 'tablet', 'laptop', 'desktop']);
    });
  });

  describe('isDeviceName', () => {
    it('returns true for valid device names', () => {
      expect(isDeviceName('mobile')).toBe(true);
      expect(isDeviceName('tablet')).toBe(true);
      expect(isDeviceName('laptop')).toBe(true);
      expect(isDeviceName('desktop')).toBe(true);
    });

    it('returns false for invalid device names', () => {
      expect(isDeviceName('unknown')).toBe(false);
      expect(isDeviceName('')).toBe(false);
      expect(isDeviceName('iphone')).toBe(false);
    });
  });
});
