import { describe, it, expect } from 'vitest';
import { frameFor, frameHtml, frameCss } from './frames.ts';

describe('frames.ts', () => {
  it('none disables framing', () => {
    expect(frameFor('mobile', 'none').kind).toBe('none');
  });

  it('auto gives phones a bezel and desktops browser chrome', () => {
    expect(frameFor('mobile', 'auto').kind).toBe('phone');
    expect(frameFor('desktop', 'auto').kind).toBe('browser');
  });

  it('explicit kinds win over device', () => {
    expect(frameFor('desktop', 'phone').kind).toBe('phone');
    expect(frameFor('mobile', 'browser').kind).toBe('browser');
  });

  it('frameHtml wraps browser and phone, passes none through', () => {
    const img = '<img src="a.png" />';
    expect(frameHtml(frameFor('desktop', 'browser'), img, '/')).toContain('ck-frame-browser');
    expect(frameHtml(frameFor('mobile', 'phone'), img, '/')).toContain('ck-frame-phone');
    expect(frameHtml(frameFor('mobile', 'none'), img, '/')).toBe(img);
  });

  it('frameCss is non-empty', () => {
    expect(frameCss()).toContain('.ck-frame-browser');
  });
});
