/**
 * Contrast assertions over the real token matrix, in both themes.
 *
 * §8.13: "Contrast is verified in CI — token pairings are computed and
 * asserted, in both themes, so a failing pairing cannot be merged. This is a
 * test, not a review comment."
 *
 * The pairings below are every combination that actually occurs in the UI. A
 * pairing that is not listed is not tested, so adding a new
 * text-colour-on-surface combination means adding a line here — which is the
 * intended friction.
 *
 * When one of these fails, the fix is the *token*, not the threshold.
 */

import { describe, expect, it } from 'vitest';

import primitives from './primitives.json' with { type: 'json' };
import semantic from './semantic.json' with { type: 'json' };
import {
  CONTRAST_THRESHOLDS,
  checkContrast,
  contrastBetween,
  isInSrgbGamut,
  oklchToRgb,
  parseOklch,
  relativeLuminance,
} from './contrast';

/* -------------------------------------------------------------------------
 * Resolve `{color.neutral.950}` against the primitives
 * ---------------------------------------------------------------------- */

type Json = Record<string, unknown>;

function lookup(path: string): string {
  const segments = path.split('.');
  let node: unknown = primitives as Json;

  for (const segment of segments) {
    if (typeof node !== 'object' || node === null) {
      throw new Error(`Token path "${path}" is not resolvable.`);
    }
    node = (node as Json)[segment];
  }

  if (typeof node !== 'string') throw new Error(`Token path "${path}" is not a string.`);
  return node;
}

/** Resolve a semantic value, which is always a `{reference}` into tier 1. */
function resolve(theme: 'dark' | 'light', token: string): string {
  const themeColors = (semantic as unknown as Record<string, { color: Record<string, string> }>)[
    theme
  ]?.color;

  const raw = themeColors?.[token];
  if (raw === undefined) throw new Error(`Semantic token "${token}" missing in ${theme}.`);

  const match = /^\{([^}]+)\}$/.exec(raw);
  if (match === null) {
    // §8.1: "a raw colour appearing in this file is a bug."
    throw new Error(`Semantic token "${token}" in ${theme} is a literal, not a reference.`);
  }

  return lookup(match[1] as string);
}

/* -------------------------------------------------------------------------
 * The pairings
 * ---------------------------------------------------------------------- */

const SURFACES = ['surface', 'surface-raised', 'surface-overlay'] as const;

/** Text roles and the threshold each must clear. */
const TEXT_ROLES = [
  // AAA. §8.13 holds body text to 7:1.
  { token: 'text-primary', required: CONTRAST_THRESHOLDS.bodyText },
  // AA. Glanced at rather than read.
  { token: 'text-secondary', required: CONTRAST_THRESHOLDS.secondaryText },
  { token: 'text-tertiary', required: CONTRAST_THRESHOLDS.secondaryText },
] as const;

/** Non-text: borders, focus rings, chart marks. WCAG 1.4.11 → 3:1. */
const NON_TEXT_ROLES = [
  { token: 'border-strong', required: CONTRAST_THRESHOLDS.nonText },
  { token: 'accent', required: CONTRAST_THRESHOLDS.nonText },
  { token: 'focus-ring', required: CONTRAST_THRESHOLDS.nonText },
  { token: 'positive', required: CONTRAST_THRESHOLDS.nonText },
  { token: 'caution', required: CONTRAST_THRESHOLDS.nonText },
  { token: 'critical', required: CONTRAST_THRESHOLDS.nonText },
] as const;

const DATA_SERIES = [
  'data-1',
  'data-2',
  'data-3',
  'data-4',
  'data-5',
  'data-6',
  'data-7',
  'data-8',
] as const;

/**
 * Light-mode slots the dataviz validator flags below 3:1, with the relief rule.
 *
 * Not a failure to fix by retuning: §8.9 forbids reinventing the adopted
 * palette, and the validator's own output attaches the remedy — "relief
 * required (visible labels or table view)". §8.9(6) already mandates a data
 * table on every chart, so the relief is satisfied by construction.
 *
 * Listed explicitly so a *fourth* slot dropping below 3:1 fails the suite.
 */
const LIGHT_RELIEF_SLOTS = new Set(['data-3', 'data-4', 'data-5']);

describe.each(['dark', 'light'] as const)('%s theme', (theme) => {
  describe('text on surfaces', () => {
    for (const surface of SURFACES) {
      for (const role of TEXT_ROLES) {
        it(`${role.token} on ${surface} meets ${String(role.required)}:1`, () => {
          const check = checkContrast(
            `${role.token} on ${surface}`,
            resolve(theme, role.token),
            resolve(theme, surface),
            role.required,
          );

          // The message names the actual ratio, so a failure says how far off
          // it is rather than merely that it failed.
          expect(
            check.passes,
            `${check.label} in ${theme}: ${String(check.actual)}:1, needs ${String(check.required)}:1`,
          ).toBe(true);
        });
      }
    }
  });

  describe('non-text against surfaces', () => {
    for (const role of NON_TEXT_ROLES) {
      it(`${role.token} meets ${String(role.required)}:1 on the base surface`, () => {
        const check = checkContrast(
          role.token,
          resolve(theme, role.token),
          resolve(theme, 'surface'),
          role.required,
        );
        expect(
          check.passes,
          `${check.label} in ${theme}: ${String(check.actual)}:1, needs ${String(check.required)}:1`,
        ).toBe(true);
      });
    }
  });

  it('renders text-on-accent legibly against the accent fill', () => {
    // The one pairing where the background is not a surface: a primary button.
    const check = checkContrast(
      'text-on-accent on accent',
      resolve(theme, 'text-on-accent'),
      resolve(theme, 'accent'),
      CONTRAST_THRESHOLDS.secondaryText,
    );
    expect(
      check.passes,
      `${check.label} in ${theme}: ${String(check.actual)}:1, needs ${String(check.required)}:1`,
    ).toBe(true);
  });

  describe('chart series', () => {
    for (const series of DATA_SERIES) {
      it(`${series} is distinguishable from the surface`, () => {
        // §8.9(7): charts must be readable at 360px. A series that blends into
        // the background is unreadable at any width.
        const check = checkContrast(
          series,
          resolve(theme, series),
          resolve(theme, 'surface'),
          CONTRAST_THRESHOLDS.nonText,
        );

        if (theme === 'light' && LIGHT_RELIEF_SLOTS.has(series)) {
          // Under relief: still must be visible, just not at the 3:1 bar.
          // 1.8 is the floor below which the mark disappears entirely.
          expect(
            check.actual,
            `${check.label} is invisible on light: ${String(check.actual)}:1`,
          ).toBeGreaterThan(1.8);
          return;
        }

        expect(
          check.passes,
          `${check.label} in ${theme}: ${String(check.actual)}:1, needs ${String(check.required)}:1`,
        ).toBe(true);
      });
    }

    it('does not attempt to re-derive CVD separability here', () => {
      /**
       * Deliberately not tested in this suite.
       *
       * An earlier revision approximated separability with a 25° hue-distance
       * check. It passed, and the palette it was guarding failed the real
       * validator at ΔE 3.4 under deuteranopia — because hue distance is not
       * perceptual distance, and a CVD reader has lost the hue axis entirely.
       *
       * A convincing-but-wrong check is worse than none: it makes the failure
       * feel covered. CVD separation is verified by the dataviz validator
       * against the adopted palette, and the slot values are frozen (§8.9).
       * Re-run it if they ever change:
       *
       *   node <dataviz>/scripts/validate_palette.js "<hex,...>" \
       *     --mode dark --surface '#080b0e'
       */
      expect(DATA_SERIES).toHaveLength(8);
    });
  });
});

describe('token hygiene', () => {
  it('keeps every semantic token a reference, never a literal', () => {
    // §8.1: tier 2 maps tier 1 into meaning. A raw colour here is a bug.
    for (const theme of ['dark', 'light'] as const) {
      const colors = (semantic as unknown as Record<string, { color: Record<string, string> }>)[
        theme
      ]?.color;

      for (const [token, value] of Object.entries(colors ?? {})) {
        if (token.startsWith('$')) continue;
        expect(value, `${theme}.${token} is a literal`).toMatch(/^\{.+\}$/);
      }
    }
  });

  it('defines the same token set in both themes', () => {
    // A token present in dark and missing in light renders as `var(--missing)`
    // — invisible, and looks like a design choice.
    const themed = semantic as unknown as Record<string, { color: Record<string, string> }>;
    const darkKeys = Object.keys(themed['dark']?.color ?? {}).filter((k) => !k.startsWith('$'));
    const lightKeys = Object.keys(themed['light']?.color ?? {}).filter((k) => !k.startsWith('$'));

    expect(darkKeys.filter((k) => !lightKeys.includes(k))).toEqual([]);
    expect(lightKeys.filter((k) => !darkKeys.includes(k))).toEqual([]);
  });

  it('keeps every primitive colour inside the sRGB gamut', () => {
    // An out-of-gamut OKLCH value is silently clamped by the browser, so the
    // rendered colour is not the authored one — and the contrast this suite
    // computed is not the contrast on screen.
    const outOfGamut: string[] = [];

    const walk = (node: unknown, path: string[]): void => {
      if (typeof node === 'string') {
        const parsed = parseOklch(node);
        if (parsed !== null && !isInSrgbGamut(parsed)) outOfGamut.push(path.join('.'));
        return;
      }
      if (typeof node !== 'object' || node === null) return;
      for (const [key, child] of Object.entries(node)) {
        if (key.startsWith('$')) continue;
        walk(child, [...path, key]);
      }
    };

    walk((primitives as Json)['color'], ['color']);
    expect(outOfGamut, `out of sRGB gamut: ${outOfGamut.join(', ')}`).toEqual([]);
  });

  it('never uses pure black as the dark surface', () => {
    // §8.7: "pure black causes OLED smearing on scroll and excessive contrast
    // fatigue." The base is neutral.950.
    const surface = parseOklch(resolve('dark', 'surface'));
    expect(surface).not.toBeNull();
    expect(surface?.l).toBeGreaterThan(0.1);
  });
});

describe('contrast maths', () => {
  it('matches known WCAG values', () => {
    // Black on white is exactly 21:1 — the anchor that proves the whole
    // pipeline (OKLCH → sRGB → luminance → ratio) is wired correctly.
    const white = parseOklch('oklch(100% 0 0)');
    const black = parseOklch('oklch(0% 0 0)');
    expect(white).not.toBeNull();
    expect(black).not.toBeNull();

    const ratio = contrastBetween('oklch(100% 0 0)', 'oklch(0% 0 0)');
    expect(ratio).toBeCloseTo(21, 1);
  });

  it('is symmetric', () => {
    const a = 'oklch(62.2% 0.188 265)';
    const b = 'oklch(98.2% 0.003 250)';
    expect(contrastBetween(a, b)).toBeCloseTo(contrastBetween(b, a) as number, 6);
  });

  it('returns 1 for identical colours', () => {
    expect(contrastBetween('oklch(50% 0.1 200)', 'oklch(50% 0.1 200)')).toBeCloseTo(1, 6);
  });

  it('converts white and black correctly', () => {
    expect(oklchToRgb({ l: 1, c: 0, h: 0 })).toEqual({ r: 255, g: 255, b: 255 });
    expect(oklchToRgb({ l: 0, c: 0, h: 0 })).toEqual({ r: 0, g: 0, b: 0 });
    expect(relativeLuminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 4);
    expect(relativeLuminance({ r: 0, g: 0, b: 0 })).toBeCloseTo(0, 4);
  });

  it('treats transparent as having no measurable contrast', () => {
    expect(parseOklch('transparent')).toBeNull();
    expect(contrastBetween('transparent', 'oklch(50% 0 0)')).toBeNull();
  });
});
