/**
 * Reference ranges — the other half of §4.4's registry, and the half that is
 * deliberately *not* a registry.
 *
 * ## The range is stored per result, never looked up
 *
 * §9.2 is unusually blunt about this:
 *
 *   "Reference ranges are stored per result, not looked up — ranges vary by
 *    laboratory and change over time, and a 2027 result compared against a 2035
 *    range is a clinical error."
 *
 * So there is no table of canonical ranges in this file and there never will
 * be. Everything here operates on the range *as printed on that report*, which
 * arrives with the result and stays with it forever.
 *
 * ## The printed flag wins over any recomputation
 *
 * The same paragraph's reasoning applies to the flag: record what the
 * laboratory said. This module will recompute a flag when the report printed
 * none, and when it does the result is labelled `derived` all the way to the
 * screen — because a laboratory flags against rules this system does not have
 * (sex, age, fasting state, assay method), and a derived `normal` sitting
 * beside a printed one with the same styling is a small lie told confidently.
 *
 * ## The range shift is the thing that breaks trends quietly
 *
 * A person's ferritin is 42 in March against a range of 30–400, and 42 in
 * October against 20–250. Nothing about them changed; the laboratory changed
 * its assay. {@link rangeShifts} surfaces that as a fact on the analyte's trend,
 * because the alternative is a chart where the line is flat and the shaded band
 * moves, and nobody notices which one moved.
 */

import type { Decimal } from '../../units/decimal';
import { compareDecimal, formatDecimal, parseDecimal } from '../../units/decimal';

/** Mirrors the `lab_flag` pgEnum exactly. A value added there is added here. */
export const LAB_FLAGS = Object.freeze([
  'normal',
  'low',
  'high',
  'critical_low',
  'critical_high',
  'abnormal',
  'indeterminate',
] as const);

export type LabFlag = (typeof LAB_FLAGS)[number];

export const LAB_FLAG_LABELS: Readonly<Record<LabFlag, string>> = Object.freeze({
  normal: 'Within range',
  low: 'Below range',
  high: 'Above range',
  critical_low: 'Critically low',
  critical_high: 'Critically high',
  abnormal: 'Abnormal',
  indeterminate: 'Indeterminate',
});

/**
 * P5, rendered wherever a range is shown.
 *
 * A reference range is the interval containing the central 95% of a reference
 * population. It is not a target, one result outside it is not a diagnosis, and
 * this system is not qualified to say which case applies.
 */
export const RANGE_CAVEAT =
  'A reference range describes most of a reference population, not a target for you. One result outside it is a question for your doctor, not an answer.';

export type PrintedRange = {
  /** Decimal text exactly as printed. `null` when the report gave no bound. */
  readonly low: string | null;
  readonly high: string | null;
  /** `< 0.5`, `Not detected`, `Negative` — ranges with no numeric form. */
  readonly text: string | null;
  /** The unit the range is printed in, which must match the result's. */
  readonly unit: string | null;
};

export type FlagSource = 'printed' | 'derived' | 'none';

export type EffectiveFlag = {
  readonly flag: LabFlag | null;
  readonly source: FlagSource;
};

/**
 * Recompute a flag from a value and its printed bounds.
 *
 * Returns `null` — not `normal` — when there is nothing to compare against. A
 * result with no printed range is *unclassified*, and defaulting it to normal
 * would turn every range-less line on a report into reassurance.
 *
 * Only `low`, `high` and `normal` are ever produced. The critical variants
 * require thresholds this system does not have, and `abnormal` is a judgement
 * rather than an arithmetic outcome; all three are printed-only.
 */
export function classifyAgainstRange(value: string, range: PrintedRange): LabFlag | null {
  const parsed = parseDecimal(value);
  if (parsed === null) return null;

  const low = range.low === null ? null : parseDecimal(range.low);
  const high = range.high === null ? null : parseDecimal(range.high);
  if (low === null && high === null) return null;

  if (low !== null && compareDecimal(parsed, low) < 0) return 'low';
  if (high !== null && compareDecimal(parsed, high) > 0) return 'high';
  return 'normal';
}

/**
 * The flag to render, and where it came from.
 *
 * The `source` is not decoration. The screen renders a derived flag in a
 * different, quieter form and says so, which is the only honest way to show a
 * number the laboratory declined to classify.
 */
export function effectiveFlag(printed: LabFlag | null, value: string | null, range: PrintedRange): EffectiveFlag {
  if (printed !== null) return { flag: printed, source: 'printed' };
  if (value === null) return { flag: null, source: 'none' };
  const derived = classifyAgainstRange(value, range);
  return derived === null ? { flag: null, source: 'none' } : { flag: derived, source: 'derived' };
}

/** True for the flags a person should carry into an appointment. */
export function isOutOfRange(flag: LabFlag | null): boolean {
  return flag === 'low' || flag === 'high' || flag === 'critical_low' || flag === 'critical_high' || flag === 'abnormal';
}

/** True for the two that warrant being read today rather than at the next visit. */
export function isCritical(flag: LabFlag | null): boolean {
  return flag === 'critical_low' || flag === 'critical_high';
}

/** `30 – 100 ng/mL`, `< 0.5`, or `not printed`. */
export function describeRange(range: PrintedRange): string {
  if (range.text !== null && range.text.trim() !== '') return range.text.trim();
  const unit = range.unit === null || range.unit === '' ? '' : ` ${range.unit}`;
  const low = range.low === null ? null : tidy(range.low);
  const high = range.high === null ? null : tidy(range.high);
  if (low !== null && high !== null) return `${low} – ${high}${unit}`;
  if (low !== null) return `≥ ${low}${unit}`;
  if (high !== null) return `≤ ${high}${unit}`;
  return 'not printed';
}

/**
 * A stored measurement, as a person reads it.
 *
 * `numeric(20, 6)` comes back as `14.200000`, which is correct storage and
 * wrong prose — and these strings end up in a question read aloud in a
 * consulting room, where "fourteen point two zero zero zero zero zero" is not
 * what anybody says. Trailing zeros are stripped; nothing is rounded, because
 * rounding a lab value for display is how a 0.95 becomes a 1.
 */
export function formatMeasured(text: string): string {
  const parsed = parseDecimal(text);
  return parsed === null ? text : formatDecimal(stripTrailingZeros(parsed));
}

function tidy(text: string): string {
  return formatMeasured(text);
}

function stripTrailingZeros(value: Decimal): Decimal {
  let { unscaled, scale } = value;
  while (scale > 0 && unscaled % 10n === 0n) {
    unscaled /= 10n;
    scale -= 1;
  }
  return { unscaled, scale };
}

/* -------------------------------------------------------------------------
 * Range shifts
 * ---------------------------------------------------------------------- */

export type RangedResult = {
  readonly panelId: string;
  /** ISO instant of collection, used only for ordering and for the sentence. */
  readonly collectedAt: string | null;
  readonly low: string | null;
  readonly high: string | null;
  readonly unit: string | null;
};

export type RangeShift = {
  /** The range in force from this point, described. */
  readonly range: string;
  readonly firstPanelId: string;
  readonly firstSeenAt: string | null;
};

/**
 * The distinct printed ranges for one analyte, in the order they first appear.
 *
 * Returns an empty array when every report printed the same range — which is
 * the common case, and the case where saying anything would be noise. Two or
 * more entries mean the shaded band on that analyte's chart is not one band,
 * and the chart says so.
 *
 * A change of *unit* counts as a change of range even when the numbers are
 * equivalent, because the printed range is compared as printed. That is the
 * conservative direction: it reports a shift that is only cosmetic rather than
 * hiding one that is not.
 */
export function rangeShifts(results: readonly RangedResult[]): readonly RangeShift[] {
  const ordered = [...results].sort((a, b) => {
    if (a.collectedAt === null) return b.collectedAt === null ? 0 : 1;
    if (b.collectedAt === null) return -1;
    return a.collectedAt < b.collectedAt ? -1 : a.collectedAt > b.collectedAt ? 1 : 0;
  });

  const shifts: RangeShift[] = [];
  let previous: string | null = null;

  for (const result of ordered) {
    if (result.low === null && result.high === null) continue;
    const key = `${result.low ?? ''}|${result.high ?? ''}|${result.unit ?? ''}`;
    if (key === previous) continue;
    previous = key;
    shifts.push({
      range: describeRange({ low: result.low, high: result.high, text: null, unit: result.unit }),
      firstPanelId: result.panelId,
      firstSeenAt: result.collectedAt,
    });
  }

  return shifts.length > 1 ? shifts : [];
}
