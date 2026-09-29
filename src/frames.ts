/**
 * Device frames (FR-9: "optional device-frame mockups").
 *
 * No image post-processing dependency: frames are a gallery-level presentation
 * concern. `frameFor(deviceName)` picks the right chrome (browser window for
 * laptop/desktop, phone bezel for mobile, tablet bezel for tablet, none when
 * disabled), and `frameCss()` / `frameHtml()` render it with zero external
 * dependencies so the gallery stays self-contained (FR-30). Baking pixels with
 * sharp is a future optimization that this data model already supports: the
 * manifest records `frame`, so a post-processor can composite later without
 * changing the contract.
 */

export type FrameKind = 'none' | 'browser' | 'phone';

export type FrameSpec = {
  kind: FrameKind;
  /** Corner radius / bezel width in px for the CSS renderer. */
  radius: number;
  bezel: number;
  /** Whether to render a browser URL bar (browser kind only). */
  urlBar: boolean;
};

export function frameFor(
  deviceName: string,
  frame: 'none' | 'browser' | 'phone' | 'auto',
): FrameSpec {
  if (frame === 'none') return { kind: 'none', radius: 0, bezel: 0, urlBar: false };
  if (frame === 'browser') return { kind: 'browser', radius: 10, bezel: 0, urlBar: true };
  if (frame === 'phone') return { kind: 'phone', radius: 28, bezel: 10, urlBar: false };
  // auto: phones/tablets get bezels, larger screens get browser chrome
  if (deviceName === 'mobile' || deviceName === 'tablet') {
    return { kind: 'phone', radius: 28, bezel: 10, urlBar: false };
  }
  return { kind: 'browser', radius: 10, bezel: 0, urlBar: true };
}

export function frameCss(): string {
  return [
    '.ck-frame-browser { border-radius: 10px; overflow: hidden; box-shadow: 0 8px 30px rgba(0,0,0,.18); border: 1px solid rgba(0,0,0,.12); background: #fff; }',
    '.ck-frame-bar { display: flex; align-items: center; gap: 6px; padding: 8px 12px; background: #eef0f3; border-bottom: 1px solid rgba(0,0,0,.08); }',
    '.ck-frame-dot { width: 10px; height: 10px; border-radius: 50%; }',
    '.ck-frame-url { flex: 1; font: 12px/1.4 system-ui; color: #555; background: #fff; border-radius: 6px; padding: 3px 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
    '.ck-frame-phone { border-radius: 30px; padding: 10px; background: #111; box-shadow: 0 8px 30px rgba(0,0,0,.28); }',
    '.ck-frame-phone img, .ck-frame-browser img { display: block; width: 100%; height: auto; border-radius: 6px; }',
    '.ck-frame-phone img { border-radius: 20px; }',
  ].join('\n');
}

export function frameHtml(spec: FrameSpec, imgTag: string, pagePath: string): string {
  const esc = pagePath.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  if (spec.kind === 'browser') {
    return `<div class="ck-frame-browser" role="img" aria-label="Screenshot of ${esc} in a browser window"><div class="ck-frame-bar" aria-hidden="true"><span class="ck-frame-dot" style="background:#ff5f57"></span><span class="ck-frame-dot" style="background:#febc2e"></span><span class="ck-frame-dot" style="background:#28c840"></span><span class="ck-frame-url">${esc}</span></div>${imgTag}</div>`;
  }
  if (spec.kind === 'phone') {
    return `<div class="ck-frame-phone" role="img" aria-label="Screenshot of ${esc} in a phone frame">${imgTag}</div>`;
  }
  return imgTag;
}
