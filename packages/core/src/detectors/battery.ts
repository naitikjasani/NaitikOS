/**
 * The nightly battery — the one place §10.6's five controls are applied.
 *
 * A detector on its own cannot be honest. Minimum-N is per-detector, but
 * false-discovery-rate control is explicitly "across the full nightly detector
 * battery, not per-detector", out-of-sample confirmation needs to see the
 * previous run, and the baseline gate is a property of the system's age rather
 * than of any one detector. All four of those live here, and the detectors
 * stay pure functions over their own data.
 *
 * ## The five controls, and where each one is
 *
 * | Control | Where |
 * |---|---|
 * | 1. Minimum-N gates | in each detector, reported as `InsufficientData` |
 * | 2. Benjamini–Hochberg across the battery | {@link runBattery}, over every p-valued finding |
 * | 3. Pre-registered hypotheses | {@link PRE_REGISTERED} — see below |
 * | 4. Out-of-sample confirmation | {@link runBattery}, via `heldFindingIds` |
 * | 5. No insights before day 60 | {@link baselineState} |
 *
 * ## Control 5 does not apply to a count, and this is a deliberate reading
 *
 * §10.6 states the sixty-day gate without qualification, and its stated reason
 * is inferential: "An early wrong insight costs more trust than sixty days of
 * silence." Applied to the whole surface it produces a contradiction with §2.1,
 * whose MVP contains exactly one insight family — adherence and streak — and
 * whose definition of done is "thirty consecutive days of real use". A gate that
 * suppressed adherence for sixty days would make the MVP's only insight family
 * dead code for the entire validation window that the MVP exists to run, and
 * §12's V1 gate (Compounding Days ≥ 25 of 30 by 29 September) would be assessed
 * against a surface that had never rendered anything.
 *
 * The resolution taken here: **the gate applies to inference, not to
 * description.** A count of logged doses cannot be an "early wrong insight" —
 * there is nothing in it to be wrong. A deviation finding *is* an inference,
 * carries a p-value, and is suppressed until day 60 along with every future
 * correlation, changepoint and divergence detector.
 *
 * This is a deviation from the literal text of a control §10.6 calls mandatory,
 * and it is recorded as one in `docs/insights.md` rather than being quietly
 * implemented. If the reading is wrong, the fix is one boolean here.
 *
 * ## Control 3, now that there is a correlation detector to constrain
 *
 * {@link PRE_REGISTERED} was written holding one row — adherence deviation —
 * before any correlation detector existed, precisely so that it could not be
 * "written to justify a detector that already exists". {@link CORRELATION_PAIRS}
 * is now added under the same discipline: each entry names a mechanism, and a
 * pair with no mechanism worth writing down is a pair that does not go in.
 *
 * Six pairs, not sixty. §10.6's whole argument is that every comparison is paid
 * for by every other finding through the FDR correction — a registry padded
 * with plausible-sounding pairs makes the ones that matter harder to detect. The
 * three §10.6 names explicitly (sleep/mood, training volume/skin state,
 * nutrition/energy) are here; the other three are the ones this operator's
 * record actually supports.
 */

import { benjaminiHochberg, DEFAULT_ALPHA } from '../statistics/fdr';
import type { AdherenceSeries } from './adherence';
import { detectAdherence } from './adherence';
import type { CorrelationPair, MetricSeries } from './correlation';
import { detectCorrelation } from './correlation';
import type { StreakSeries } from './streak';
import { detectStreak } from './streak';
import type { DetectorId, Finding, InsufficientData } from './types';

/** §10.6 control 5. */
export const BASELINE_DAYS = 60;

export type BaselineState = {
  readonly daysOfHistory: number;
  readonly baselineDays: number;
  /** Whether p-valued findings may be produced at all. */
  readonly inferentialAllowed: boolean;
  readonly daysRemaining: number;
  /** Displayed while gathering. §10.6: "The system explicitly states it is still gathering baseline." */
  readonly message: string;
};

export function baselineState(daysOfHistory: number): BaselineState {
  const days = Number.isFinite(daysOfHistory) ? Math.max(0, Math.floor(daysOfHistory)) : 0;
  const remaining = Math.max(0, BASELINE_DAYS - days);
  return {
    daysOfHistory: days,
    baselineDays: BASELINE_DAYS,
    inferentialAllowed: remaining === 0,
    daysRemaining: remaining,
    message:
      remaining === 0
        ? 'Comparisons against a baseline are enabled.'
        : `Still gathering baseline. Comparisons against a baseline begin after ${String(BASELINE_DAYS)} days of history — ${String(remaining)} to go. Counts are shown throughout.`,
  };
}

/* -------------------------------------------------------------------------
 * Control 3 — the hypothesis registry
 * ---------------------------------------------------------------------- */

export type PreRegisteredHypothesis = {
  readonly id: string;
  readonly detector: DetectorId;
  /** The plausible mechanism §10.6 requires a pair to be declared on. */
  readonly mechanism: string;
};

export const PRE_REGISTERED: readonly PreRegisteredHypothesis[] = Object.freeze([
  Object.freeze({
    id: 'adherence.deviation',
    detector: 'adherence' as DetectorId,
    mechanism:
      'A run of scheduled doses or routine steps completed at a materially lower rate than the established rate for the same subject. Mechanism: a change in circumstance, side effects, or in logging behaviour. Tested one-sided, downwards only.',
  }),
]);

/**
 * The metric pairs eligible for correlation testing.
 *
 * §10.6 control 3, and the reason the list is short is control 2: these are
 * comparisons, and Benjamini–Hochberg divides the available significance among
 * all of them. Adding a seventh pair makes the other six harder to detect,
 * which is the correct incentive and the reason a registry beats all-pairs
 * exploration.
 *
 * Every `mechanism` is a claim someone could argue with. That is the test for
 * whether an entry belongs: "these are both numbers I have" is not a mechanism.
 */
export const CORRELATION_PAIRS: readonly CorrelationPair[] = Object.freeze([
  Object.freeze({
    id: 'sleep_duration.mood',
    x: 'body.sleep.duration',
    y: 'mind.mood',
    mechanism:
      'Sleep restriction has a well-established effect on next-day affect. Named explicitly in §10.6 as a pre-registrable pair. Tested with a lag, because the effect is on the following day rather than the same one.',
    provenance: 'pre_registered' as const,
  }),
  Object.freeze({
    id: 'training_volume.skin_state',
    x: 'gym.volume',
    y: 'skin.state',
    mechanism:
      'Training raises sweat, sebum and cortisol, all three of which are plausible skin irritants. §4.9 puts the expected lag at 48–72 hours, which is inside the search window. Named in §10.6.',
    provenance: 'pre_registered' as const,
  }),
  Object.freeze({
    id: 'protein.energy',
    x: 'nutrition.protein',
    y: 'mind.energy',
    mechanism:
      'Nutrition against energy, named in §10.6. Protein specifically rather than calories, because intake is the variable the operator manipulates and total energy on a bulk is nearly constant by construction.',
    provenance: 'pre_registered' as const,
  }),
  Object.freeze({
    id: 'sleep_duration.anxiety',
    x: 'body.sleep.duration',
    y: 'mind.anxiety',
    mechanism:
      'Short sleep is associated with elevated next-day anxiety. Distinct from the mood pair rather than redundant with it: the operator has a diagnosed anxiety disorder, and mood and anxiety are separately recorded because they move separately.',
    provenance: 'pre_registered' as const,
  }),
  Object.freeze({
    id: 'training_volume.sleep_duration',
    x: 'gym.volume',
    y: 'body.sleep.duration',
    mechanism:
      'Training load is plausibly related to sleep in either direction — exertion promoting it, or late training and elevated arousal suppressing it. Registered because the sign is genuinely unknown in advance, which is what makes it worth testing rather than assuming.',
    provenance: 'pre_registered' as const,
  }),
  Object.freeze({
    id: 'anxiety.skin_state',
    x: 'mind.anxiety',
    y: 'skin.state',
    mechanism:
      'A stress–skin relationship is commonly reported and physiologically plausible via cortisol. Registered with the direction unassumed, and it carries the shared-day caveat harder than any other pair here: both readings are self-reported taps on the same evening.',
    provenance: 'pre_registered' as const,
  }),
]);

/* -------------------------------------------------------------------------
 * The run
 * ---------------------------------------------------------------------- */

export type BatteryInput = {
  readonly dayKey: string;
  /** Days between the first recorded observation and today. Drives control 5. */
  readonly daysOfHistory: number;
  readonly adherence: readonly AdherenceSeries[];
  readonly streaks: readonly StreakSeries[];
  /**
   * Daily series per metric key, for the correlation pairs.
   *
   * A pair whose metrics are not both present is skipped silently rather than
   * reported as insufficient — a metric the operator does not record is not a
   * gap in their data, it is a module they do not use, and reporting it every
   * night would be the system asking for more logging (P6).
   */
  readonly series?: readonly MetricSeries[];
  /** Overridable so a test can register a pair without editing the registry. */
  readonly pairs?: readonly CorrelationPair[];
  /**
   * Finding ids held by the previous run.
   *
   * §10.6 control 4: "A correlation is not surfaced on first detection. It is
   * held, and re-tested against subsequent data. Only a finding that survives a
   * second independent window is promoted to the inbox."
   */
  readonly heldFindingIds?: readonly string[];
  readonly alpha?: number;
};

export type BatteryOutcome = {
  readonly baseline: BaselineState;
  /** Ready for the inbox. */
  readonly surfaced: readonly Finding[];
  /** Detected once, awaiting confirmation by a later run. Never displayed. */
  readonly held: readonly Finding[];
  /** Did not survive FDR control. Kept so the comparison count is auditable. */
  readonly discarded: readonly Finding[];
  readonly insufficient: readonly InsufficientData[];
  /** The size of the correction — every p-valued finding the night produced. */
  readonly comparisons: number;
  readonly fdrThreshold: number | null;
};

export function runBattery(input: BatteryInput): BatteryOutcome {
  const baseline = baselineState(input.daysOfHistory);
  const held = new Set(input.heldFindingIds ?? []);

  const produced: Finding[] = [];
  const insufficient: InsufficientData[] = [];

  for (const series of input.adherence) {
    const outcome = detectAdherence(series, input.dayKey, {
      inferentialAllowed: baseline.inferentialAllowed,
    });
    produced.push(...outcome.findings);
    insufficient.push(...outcome.insufficient);
  }

  for (const series of input.streaks) {
    const outcome = detectStreak(series, input.dayKey);
    produced.push(...outcome.findings);
    insufficient.push(...outcome.insufficient);
  }

  const byMetric = new Map((input.series ?? []).map((entry) => [entry.metricKey, entry]));
  for (const pair of input.pairs ?? CORRELATION_PAIRS) {
    const x = byMetric.get(pair.x);
    const y = byMetric.get(pair.y);
    if (x === undefined || y === undefined) continue;

    const outcome = detectCorrelation({
      pair,
      x,
      y,
      dayKey: input.dayKey,
      inferentialAllowed: baseline.inferentialAllowed,
    });
    produced.push(...outcome.findings);
    insufficient.push(...outcome.insufficient);
  }

  const descriptive = produced.filter((finding) => finding.pValue === null);
  const inferential = produced.filter((finding) => finding.pValue !== null);

  /*
   * Control 2. The correction is over `inferential` — the whole night's set of
   * p-valued findings — not over one detector's. See `statistics/fdr.ts`.
   */
  const fdr = benjaminiHochberg(
    inferential.map((finding) => finding.pValue ?? 1),
    input.alpha ?? DEFAULT_ALPHA,
  );

  const surfaced: Finding[] = [...descriptive];
  const holding: Finding[] = [];
  const discarded: Finding[] = [];

  for (const [index, finding] of inferential.entries()) {
    if (!(fdr.rejected[index] ?? false)) {
      discarded.push(finding);
      continue;
    }
    /*
     * Control 4. A finding is promoted only if the same finding id was held by
     * a previous run — that is, it was detected on data that did not include
     * today's window alone.
     */
    if (held.has(finding.id)) surfaced.push({ ...finding, confidence: 'confirmed' });
    else holding.push(finding);
  }

  return {
    baseline,
    surfaced: sortFindings(surfaced),
    held: sortFindings(holding),
    discarded: sortFindings(discarded),
    insufficient,
    comparisons: fdr.comparisons,
    fdrThreshold: fdr.threshold,
  };
}

/**
 * Confirmed before exploratory, then by detector and subject.
 *
 * Deliberately *not* by p-value. Ranking an insight list by significance
 * teaches the operator to read the top item as the most important thing, and a
 * p-value is a statement about surprise, not about importance.
 */
const CONFIDENCE_ORDER: Readonly<Record<Finding['confidence'], number>> = Object.freeze({
  confirmed: 0,
  exploratory: 1,
  descriptive: 2,
});

function sortFindings(findings: readonly Finding[]): readonly Finding[] {
  return [...findings].sort((a, b) => {
    const byConfidence = CONFIDENCE_ORDER[a.confidence] - CONFIDENCE_ORDER[b.confidence];
    if (byConfidence !== 0) return byConfidence;
    if (a.detector !== b.detector) return a.detector.localeCompare(b.detector);
    return a.subject.localeCompare(b.subject);
  });
}
