import type { Page } from 'playwright';

/**
 * Determinism controls (FR-16).
 *
 * Two runs on unchanged content must differ by <0.5% pixels after masking
 * (NFR Determinism). Three small mechanisms get most of the way there:
 * freezing time, seeding `Math.random`, and masking/blur-ring dynamic regions
 * (timestamps, ads, avatars). All are opt-in via config so zero-config runs
 * stay faithful to the live page.
 */

export const MASK_CSS_CLASS = 'capturekit-mask';

/** CSS that blacks out masked regions so they compress identically run to run. */
export function maskCss(selectors: string[], mode: 'black' | 'blur'): string {
  if (selectors.length === 0) return '';
  const body =
    mode === 'blur'
      ? 'filter: blur(8px) !important;'
      : 'background: #000 !important; color: transparent !important; box-shadow: none !important;';
  return selectors.map((sel) => `${sel} { ${body} } ${sel} * { ${body} }`).join('\n');
}

export async function applyMask(
  page: Page,
  selectors: string[],
  mode: 'black' | 'blur' = 'black',
): Promise<void> {
  if (selectors.length === 0) return;
  await page.addStyleTag({ content: maskCss(selectors, mode) }).catch(() => undefined);
}

/**
 * Freeze `Date` and monotonic clocks at `isoTime`, and seed `Math.random`
 * with a deterministic PRNG when `seed` is set. Runs before page scripts
 * wherever possible (`addInitScript`), re-applied after navigation.
 *
 * `page.clock` (Playwright's clock API) is intentionally not used: it only
 * affects timers after installation and misses `Date.now()` calls made during
 * initial script evaluation. Overriding the globals via init script covers the
 * whole page lifecycle.
 */
export async function applyDeterminism(
  page: Page,
  options: { freezeTime?: string; seedRandom?: boolean },
): Promise<void> {
  const { freezeTime, seedRandom } = options;
  if (!freezeTime && !seedRandom) return;
  const frozenMs = freezeTime ? Date.parse(freezeTime) : NaN;
  const validFreeze = freezeTime === undefined || !Number.isNaN(frozenMs);
  await page
    .addInitScript(
      ({ frozen, seed }: { frozen: number | null; seed: boolean }) => {
        try {
          if (frozen !== null) {
            const f: number = frozen;
            const RealDate = Date;
            const FrozenDate = class extends RealDate {
              constructor(...args: unknown[]) {
                if (args.length === 0) super(f);
                else super(...(args as ConstructorParameters<typeof RealDate>));
              }
              static override now() {
                return f;
              }
            } as unknown as typeof Date;
            (globalThis as unknown as { Date: unknown }).Date = FrozenDate;
            let now = frozen;
            (globalThis as unknown as { performance?: { now?: () => number } }).performance = {
              ...(globalThis.performance ?? {}),
              now: () => now - frozen,
            };
            const tick = () => {
              now += 16;
            };
            setInterval(tick, 16);
          }
          if (seed) {
            let s = 0x9e3779b9;
            (globalThis as unknown as { Math: typeof Math }).Math = {
              ...Math,
              random: () => {
                s ^= s << 13;
                s ^= s >>> 17;
                s ^= s << 5;
                s >>>= 0;
                return s / 0xffffffff;
              },
            };
          }
        } catch {
          /* a hostile page must not fail the capture */
        }
      },
      {
        frozen: validFreeze && freezeTime ? frozenMs : null,
        seed: seedRandom === true,
      },
    )
    .catch(() => undefined);
}

/** Validate an ISO freeze-time string at config load; returns ms or throws. */
export function parseFreezeTime(value: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`Invalid freezeTime ${JSON.stringify(value)}: not a date.`);
  return ms;
}
