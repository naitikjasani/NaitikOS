/**
 * OKLCH → sRGB → WCAG contrast.
 *
 * §8.13 requires this to be enforced rather than reviewed:
 *
 *   "WCAG 2.2 AA minimum; AAA for body text (7:1). Contrast is verified in CI —
 *    token pairings are computed and asserted, in both themes, so a failing
 *    pairing cannot be merged. **This is a test, not a review comment.**"
 *
 * Implemented here rather than pulled from a colour library for two reasons.
 * The conversion is about sixty lines of well-specified arithmetic, and a
 * dependency that computes the contrast of the tokens is a dependency that can
 * silently change what "AA" means in a health application. And §5.14 keeps the
 * dependency budget deliberately small — "every new runtime dependency is a
 * decision".
 *
 * The maths is standard and the sources are worth naming: OKLab is Björn
 * Ottosson's 2020 definition, the sRGB transfer function is IEC 61966-2-1, and
 * the relative-luminance and contrast formulae are WCAG 2.2.
 */

/** A colour in the OKLCH space as authored in the token JSON. */
export type Oklch = {
  /** Perceptual lightness, 0–1. */
  readonly l: number;
  /** Chroma, 0–~0.4. */
  readonly c: number;
  /** Hue angle in degrees. */
  readonly h: number;
};

export type Rgb = { readonly r: number; readonly g: number; readonly b: number };

/**
 * Parse `oklch(62.2% 0.188 265)`.
 *
 * Also accepts the two literals the primitives use — `transparent` returns
 * null, because a transparent colour has no contrast of its own and asserting
 * against one would be meaningless rather than merely wrong.
 */
export function parseOklch(value: string): Oklch | null {
  const trimmed = value.trim();
  if (trimmed === 'transparent') return null;

  const match = /^oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(trimmed);
  if (match === null) return null;

  const [, lRaw, cRaw, hRaw] = match;
  return {
    l: Number(lRaw) / 100,
    c: Number(cRaw),
    h: Number(hRaw),
  };
}

/** Parse `#3987e5` or `#39f`. */
export function parseHex(value: string): Rgb | null {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (match === null) return null;

  const digits = match[1] as string;
  const full =
    digits.length === 3
      ? digits
          .split('')
          .map((d) => d + d)
          .join('')
      : digits;

  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
  };
}

/**
 * Parse either notation to sRGB.
 *
 * The token file is mixed on purpose: the interface palette is OKLCH because
 * §8.1 wants perceptually-uniform theming, while the chart palette is hex
 * because §8.9 requires adopting the dataviz slot values *exactly as
 * validated*. Re-expressing those in OKLCH would round them, and a rounded
 * value is no longer the value the validator passed.
 */
export function parseColor(value: string): Rgb | null {
  const hex = parseHex(value);
  if (hex !== null) return hex;

  const oklch = parseOklch(value);
  return oklch === null ? null : oklchToRgb(oklch);
}

/**
 * OKLCH → linear sRGB.
 *
 * Two steps: polar OKLCH to cartesian OKLab, then the OKLab → LMS → linear RGB
 * matrices from Ottosson's reference implementation.
 */
function oklchToLinearRgb(color: Oklch): { r: number; g: number; b: number } {
  const hRad = (color.h * Math.PI) / 180;
  const a = color.c * Math.cos(hRad);
  const bComponent = color.c * Math.sin(hRad);

  // OKLab → LMS (cube roots).
  const lCube = color.l + 0.3963377774 * a + 0.2158037573 * bComponent;
  const mCube = color.l - 0.1055613458 * a - 0.0638541728 * bComponent;
  const sCube = color.l - 0.0894841775 * a - 1.291485548 * bComponent;

  const lLms = lCube ** 3;
  const mLms = mCube ** 3;
  const sLms = sCube ** 3;

  // LMS → linear sRGB.
  return {
    r: 4.0767416621 * lLms - 3.3077115913 * mLms + 0.2309699292 * sLms,
    g: -1.2684380046 * lLms + 2.6097574011 * mLms - 0.3413193965 * sLms,
    b: -0.0041960863 * lLms - 0.7034186147 * mLms + 1.707614701 * sLms,
  };
}

/** IEC 61966-2-1 transfer function, linear → gamma-encoded. */
function encodeGamma(channel: number): number {
  const clamped = Math.max(0, Math.min(1, channel));
  return clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055;
}

/**
 * OKLCH → sRGB, each channel 0–255.
 *
 * Out-of-gamut colours are clamped per channel. That is a simplification —
 * proper gamut mapping reduces chroma while preserving lightness — and it is
 * acceptable here because every token in the palette is already inside sRGB.
 * {@link isInSrgbGamut} exists so a future token that is not fails loudly
 * rather than being silently clamped into a different colour than authored.
 */
export function oklchToRgb(color: Oklch): Rgb {
  const linear = oklchToLinearRgb(color);
  return {
    r: Math.round(encodeGamma(linear.r) * 255),
    g: Math.round(encodeGamma(linear.g) * 255),
    b: Math.round(encodeGamma(linear.b) * 255),
  };
}

/** Whether a colour survives the round trip without clamping. */
export function isInSrgbGamut(color: Oklch, tolerance = 0.001): boolean {
  const linear = oklchToLinearRgb(color);
  return [linear.r, linear.g, linear.b].every(
    (channel) => channel >= -tolerance && channel <= 1 + tolerance,
  );
}

/** WCAG 2.2 relative luminance. */
export function relativeLuminance(rgb: Rgb): number {
  const linearise = (channel8Bit: number): number => {
    const channel = channel8Bit / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  };

  return (
    0.2126 * linearise(rgb.r) + 0.7152 * linearise(rgb.g) + 0.0722 * linearise(rgb.b)
  );
}

/** WCAG 2.2 contrast ratio, 1–21. Order-independent. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const luminanceA = relativeLuminance(a);
  const luminanceB = relativeLuminance(b);
  const lighter = Math.max(luminanceA, luminanceB);
  const darker = Math.min(luminanceA, luminanceB);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Contrast between two authored colours, in either notation. */
export function contrastBetween(foreground: string, background: string): number | null {
  const fg = parseColor(foreground);
  const bg = parseColor(background);
  if (fg === null || bg === null) return null;
  return contrastRatio(fg, bg);
}

/**
 * The thresholds §8.13 sets.
 *
 * `bodyText` is 7:1 — AAA — and is the one worth defending when it becomes
 * inconvenient. This application is read "at 6am half-awake… and in bed at
 * night with a dimmed screen", which is precisely the condition AA was not
 * designed for.
 */
export const CONTRAST_THRESHOLDS = Object.freeze({
  /** AAA. Body copy and anything a user reads for comprehension. */
  bodyText: 7,
  /** AA. Secondary and tertiary text, which is glanced at rather than read. */
  secondaryText: 4.5,
  /** AA for large text — ≥24px, or ≥18.66px semibold. */
  largeText: 3,
  /** AA for UI components and graphical objects (WCAG 1.4.11). */
  nonText: 3,
});

export type ContrastCheck = {
  readonly label: string;
  readonly foreground: string;
  readonly background: string;
  readonly required: number;
  readonly actual: number;
  readonly passes: boolean;
};

/** Evaluate one pairing. */
export function checkContrast(
  label: string,
  foreground: string,
  background: string,
  required: number,
): ContrastCheck {
  const actual = contrastBetween(foreground, background);

  if (actual === null) {
    return { label, foreground, background, required, actual: 0, passes: false };
  }

  return {
    label,
    foreground,
    background,
    required,
    // Rounded to two places so a reported figure matches what a designer would
    // read off a contrast tool, rather than differing in the ninth decimal.
    actual: Math.round(actual * 100) / 100,
    passes: actual >= required,
  };
}
