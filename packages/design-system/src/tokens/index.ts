/**
 * The token API.
 *
 * `generated/tokens.ts` is derived from the JSON and is gitignored; it is
 * re-exported here so consumers import from a stable path rather than from a
 * build artifact.
 */

export * from './generated/tokens';

export type { Oklch, Rgb, ContrastCheck } from './contrast';
export {
  CONTRAST_THRESHOLDS,
  parseOklch,
  parseHex,
  parseColor,
  oklchToRgb,
  relativeLuminance,
  contrastRatio,
  contrastBetween,
  checkContrast,
  isInSrgbGamut,
} from './contrast';
