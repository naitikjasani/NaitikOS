/**
 * Intake targets — §4.3's "macro and calorie targets tied to a bulking phase".
 *
 * ## Setting a target closes the old one; it never updates it
 *
 * `nutrition_target` carries `effectiveFrom`/`effectiveTo` for a reason the
 * schema states: "a bulk and a cut have different ones, and §4.10 needs to
 * detect that a bulk target and a visible-abs goal are in tension."
 *
 * An update would erase the phase. Six months later the question "what was I
 * eating towards in March" would have no answer, and the trends screen could not
 * band the chart by phase — which matters, because a trend line drawn straight
 * across a bulk-to-cut transition is a line through two different intentions.
 *
 * ## There is no default tolerance band
 *
 * A target with no tolerance renders as a bar and a number, not as a verdict.
 * Inventing a ±10% band that reads "within" is a claim the operator never made,
 * and P5's whole point is that this system does not manufacture judgements to
 * fill a gap in a UI.
 *
 * ## `remaining` is the number that gets the next meal logged
 *
 * "87 g protein left" all afternoon is the reason to open the log screen. It is
 * computed here rather than in the screen so the overview, the log surface and
 * the quick-capture sheet cannot disagree about it.
 */

import type { Decimal } from '../../units/decimal';
import { compareDecimal, parseDecimal, subtractDecimal } from '../../units/decimal';

export type NutritionTarget = {
  readonly id: string;
  /** `bulk`, `cut`, `maintenance` — free text in the schema, and it stays free. */
  readonly phase: string | null;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly metricKey: string;
  readonly targetValue: string;
  readonly unit: string;
  readonly toleranceLow: string | null;
  readonly toleranceHigh: string | null;
};

export type TargetStatus =
  /** Below the target, or below its tolerance band where one exists. */
  | 'under'
  /** Inside the band. Only ever reported when a band was actually set. */
  | 'within'
  | 'over'
  /** Nothing recorded for this metric today. Not the same as zero. */
  | 'unknown';

export type TargetEvaluation = {
  readonly metricKey: string;
  readonly target: Decimal;
  readonly unit: string;
  readonly actual: Decimal | null;
  /** `target − actual`, floored at zero. The number the screen shows all day. */
  readonly remaining: Decimal | null;
  readonly status: TargetStatus;
  /** True when a tolerance band was set, so the screen knows not to imply one. */
  readonly hasBand: boolean;
};

/**
 * The targets in force at an instant, one per metric.
 *
 * Latest `effectiveFrom` wins where two overlap — which should not happen if
 * every write closes its predecessor, but a row hand-edited in year nine is not
 * hypothetical and picking deterministically beats picking whichever the query
 * planner returned first.
 */
export function activeTargets(targets: readonly NutritionTarget[], at: string): readonly NutritionTarget[] {
  const byMetric = new Map<string, NutritionTarget>();

  for (const target of targets) {
    if (target.effectiveFrom > at) continue;
    if (target.effectiveTo !== null && target.effectiveTo <= at) continue;

    const existing = byMetric.get(target.metricKey);
    if (existing === undefined || target.effectiveFrom > existing.effectiveFrom) {
      byMetric.set(target.metricKey, target);
    }
  }

  return [...byMetric.values()].sort((a, b) => a.metricKey.localeCompare(b.metricKey));
}

/** The phase in force, or `null`. Used to band the trends chart. */
export function phaseFor(targets: readonly NutritionTarget[], at: string): string | null {
  for (const target of activeTargets(targets, at)) {
    if (target.phase !== null && target.phase.trim() !== '') return target.phase;
  }
  return null;
}

/**
 * Compare a day's totals against the targets in force.
 *
 * A metric with a target and no total is `unknown`, **not** `under`. Nothing
 * logged is not the same as nothing eaten, and reporting a blank morning as a
 * shortfall is the guilt framing §4.7 and §14.1 both rule out.
 */
export function evaluateTargets(
  dayTotals: ReadonlyMap<string, Decimal>,
  targets: readonly NutritionTarget[],
): readonly TargetEvaluation[] {
  const evaluations: TargetEvaluation[] = [];

  for (const target of targets) {
    const value = parseDecimal(target.targetValue);
    if (value === null) continue;

    const actual = dayTotals.get(target.metricKey) ?? null;
    const low = target.toleranceLow === null ? null : parseDecimal(target.toleranceLow);
    const high = target.toleranceHigh === null ? null : parseDecimal(target.toleranceHigh);
    const hasBand = low !== null || high !== null;

    if (actual === null) {
      evaluations.push({
        metricKey: target.metricKey,
        target: value,
        unit: target.unit,
        actual: null,
        remaining: value,
        status: 'unknown',
        hasBand,
      });
      continue;
    }

    const shortfall = subtractDecimal(value, actual);
    const remaining = compareDecimal(shortfall, { unscaled: 0n, scale: 0 }) < 0 ? null : shortfall;

    evaluations.push({
      metricKey: target.metricKey,
      target: value,
      unit: target.unit,
      actual,
      remaining,
      status: statusFor(actual, value, low, high),
      hasBand,
    });
  }

  return evaluations.sort((a, b) => a.metricKey.localeCompare(b.metricKey));
}

/**
 * `within` is only ever returned when a band was set.
 *
 * Without one, the comparison is against the bare number: at or above is `over`
 * for a ceiling metric and met for a floor metric — and since this system does
 * not know which a target is, it reports the *fact* (under or over) and leaves
 * the reading to the operator. That is deliberately less helpful than a verdict
 * and considerably more honest.
 */
function statusFor(actual: Decimal, target: Decimal, low: Decimal | null, high: Decimal | null): TargetStatus {
  if (low !== null && compareDecimal(actual, low) < 0) return 'under';
  if (high !== null && compareDecimal(actual, high) > 0) return 'over';
  if (low !== null || high !== null) return 'within';

  return compareDecimal(actual, target) < 0 ? 'under' : 'over';
}

export const TARGET_STATUS_LABELS: Readonly<Record<TargetStatus, string>> = Object.freeze({
  under: 'Under',
  within: 'Within',
  over: 'Over',
  unknown: 'Nothing logged',
});
