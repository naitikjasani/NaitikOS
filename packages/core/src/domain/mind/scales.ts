/**
 * The Mind scales, their labels, and the rule that governs how they are said.
 *
 * ## Why this file exists at all
 *
 * A 1–5 integer needs no domain module. What needs a domain module is §4.7's
 * first design principle, which is a constraint on *language*, not on storage:
 *
 *   "**No negative framing, ever.** No red. No 'you missed.' No
 *    downward-arrow-in-alarm-colour. State is reported neutrally; deterioration
 *    is reported factually and calmly."
 *
 * A rule that lives only in a design document is a rule that survives until the
 * first person writes `mood < 3 ? 'Low' : 'Good'` in a component. So the labels
 * are here, in `core`, where every surface has to read them from one place and
 * where a test can assert the vocabulary. {@link SCALE_TONE} exists for the same
 * reason: it is the only sanctioned mapping from a Mind value to a visual tone,
 * and it never returns `critical`.
 *
 * ## The direction problem, and why `higherIsBetter` is not enough
 *
 * Mood and energy read up; anxiety reads down. A chart that draws all three with
 * "up is good" arrows is wrong for one of them, and a chart that decides using a
 * boolean gets the *arrow* right and the *tone* wrong — because for anxiety, a
 * rise is not a failure. It is information. {@link describeMovement} therefore
 * returns a direction and a plain sentence, and no judgement at all.
 *
 * That is P5 as much as it is §4.7: "the system does not claim more than the
 * data supports". A rise in a self-reported five-point scale over four days
 * supports "this went up". It does not support "this is bad".
 */

import type { DailyEstimate } from '../../statistics/types';

/* -------------------------------------------------------------------------
 * The scales
 * ---------------------------------------------------------------------- */

export const MIND_METRICS = Object.freeze({
  mood: 'mind.mood',
  energy: 'mind.energy',
  anxiety: 'mind.anxiety',
});

export type MindScaleId = 'mood' | 'energy' | 'anxiety';

export const MIND_SCALE_IDS: readonly MindScaleId[] = Object.freeze([
  'mood',
  'energy',
  'anxiety',
]);

/**
 * Which end of the scale the operator would rather be at.
 *
 * Used to orient a chart and nothing else. Deliberately *not* used to colour
 * one, because §4.7 forbids the alarm colour that would imply.
 */
export type ScaleDirection = 'up_is_better' | 'down_is_better';

export type MindScale = {
  readonly id: MindScaleId;
  readonly metricKey: string;
  readonly label: string;
  readonly min: 1;
  readonly max: 5;
  readonly direction: ScaleDirection;
  /**
   * One word per point, index 0 being value 1.
   *
   * Every one of the fifteen strings below is descriptive. None of them is a
   * verdict. "Depleted" says what the state is; "Bad" would say what the system
   * thinks of it, and §4.7 does not permit the system an opinion about the
   * operator's mental state.
   */
  readonly labels: readonly [string, string, string, string, string];
};

export const MIND_SCALES: Readonly<Record<MindScaleId, MindScale>> = Object.freeze({
  mood: {
    id: 'mood',
    metricKey: MIND_METRICS.mood,
    label: 'Mood',
    min: 1,
    max: 5,
    direction: 'up_is_better',
    labels: ['Very low', 'Low', 'Even', 'Good', 'Very good'],
  },
  energy: {
    id: 'energy',
    metricKey: MIND_METRICS.energy,
    label: 'Energy',
    min: 1,
    max: 5,
    direction: 'up_is_better',
    labels: ['Depleted', 'Low', 'Steady', 'High', 'Very high'],
  },
  anxiety: {
    id: 'anxiety',
    metricKey: MIND_METRICS.anxiety,
    label: 'Anxiety',
    min: 1,
    max: 5,
    /*
     * Down is better, and the chart is oriented accordingly — but the tone
     * mapping below still refuses to paint a 5 red. Orientation is a fact about
     * the scale; colour would be a judgement about the person.
     */
    direction: 'down_is_better',
    labels: ['None', 'Mild', 'Moderate', 'High', 'Severe'],
  },
});

/** The label for a value, or `null` if it is outside 1–5. */
export function scaleLabel(scale: MindScaleId, value: number): string | null {
  if (!Number.isInteger(value)) return null;
  const definition = MIND_SCALES[scale];
  if (value < definition.min || value > definition.max) return null;
  return definition.labels[value - 1] ?? null;
}

/**
 * The only sanctioned Mind value → visual tone mapping.
 *
 * Three tones, and `critical` is not among them. §4.7's "no downward-arrow-in-
 * alarm-colour" is enforced here rather than reviewed for in every component.
 * A severe reading is `attention`, which in the design system is a muted
 * amber — enough to be visible in a list, not enough to feel like an alarm
 * going off about your own head.
 */
export type ScaleTone = 'neutral' | 'accent' | 'attention';

export function toneFor(scale: MindScaleId, value: number): ScaleTone {
  if (!Number.isInteger(value) || value < 1 || value > 5) return 'neutral';
  const better = MIND_SCALES[scale].direction === 'up_is_better' ? value : 6 - value;
  if (better >= 4) return 'accent';
  if (better <= 2) return 'attention';
  return 'neutral';
}

/** Frozen so a caller cannot mutate the mapping into an alarm. */
export const SCALE_TONE = Object.freeze({ toneFor });

/* -------------------------------------------------------------------------
 * Movement — the sentence, not the verdict
 * ---------------------------------------------------------------------- */

export type Movement = {
  readonly direction: 'up' | 'down' | 'flat' | 'unknown';
  /** Recent mean minus baseline mean, or `null` when either is missing. */
  readonly delta: number | null;
  readonly recent: number | null;
  readonly baseline: number | null;
  readonly recentDays: number;
  readonly baselineDays: number;
  /**
   * A complete, neutral sentence. Rendered as-is.
   *
   * §4.7's example of the permitted register is exact: "'Your mood has averaged
   * 2.4 this week against a baseline of 3.5' is a fact." Everything this
   * function emits is that sentence with different numbers in it.
   */
  readonly sentence: string;
};

/**
 * The smallest difference in a five-point self-report worth calling a movement.
 *
 * A quarter of a point. Below that, day-to-day answering noise on a coarse
 * subjective scale dominates, and reporting it as a change would be the
 * over-claiming P5 exists to prevent.
 */
export const MOVEMENT_THRESHOLD = 0.25;

/** Minimum recorded days on each side before any movement is reported. */
export const MIN_MOVEMENT_DAYS = 3;

/**
 * Compare a recent window against the window before it.
 *
 * Both windows are taken from a day-indexed series with gaps, and *gaps are not
 * zeroes* — a day with no reading contributes to neither mean and is not
 * counted towards the minimum. That is the same rule as everywhere else in the
 * system: absence of a record is not a record of absence.
 */
export function describeMovement(
  scale: MindScaleId,
  series: readonly DailyEstimate[],
  options: { readonly recentDays?: number; readonly baselineDays?: number } = {},
): Movement {
  const recentDays = options.recentDays ?? 7;
  const baselineDays = options.baselineDays ?? 28;
  const definition = MIND_SCALES[scale];

  const ordered = [...series].sort((a, b) => (a.dayKey < b.dayKey ? -1 : a.dayKey > b.dayKey ? 1 : 0));
  const recentSlice = ordered.slice(-recentDays);
  const baselineSlice = ordered.slice(-(recentDays + baselineDays), -recentDays);

  const recent = meanOf(recentSlice);
  const baseline = meanOf(baselineSlice);

  if (recent === null || baseline === null || recent.count < MIN_MOVEMENT_DAYS || baseline.count < MIN_MOVEMENT_DAYS) {
    return {
      direction: 'unknown',
      delta: null,
      recent: recent?.mean ?? null,
      baseline: baseline?.mean ?? null,
      recentDays,
      baselineDays,
      sentence: `Not enough recorded days yet to compare ${definition.label.toLowerCase()} against a baseline.`,
    };
  }

  const delta = recent.mean - baseline.mean;
  const direction = Math.abs(delta) < MOVEMENT_THRESHOLD ? 'flat' : delta > 0 ? 'up' : 'down';

  const recentText = recent.mean.toFixed(1);
  const baselineText = baseline.mean.toFixed(1);
  const sentence =
    direction === 'flat'
      ? `${definition.label} has averaged ${recentText} over the last ${String(recent.count)} recorded days, level with a baseline of ${baselineText}.`
      : `${definition.label} has averaged ${recentText} over the last ${String(recent.count)} recorded days, against a baseline of ${baselineText}.`;

  return {
    direction,
    delta,
    recent: recent.mean,
    baseline: baseline.mean,
    recentDays,
    baselineDays,
    sentence,
  };
}

function meanOf(points: readonly DailyEstimate[]): { readonly mean: number; readonly count: number } | null {
  let sum = 0;
  let count = 0;
  for (const point of points) {
    if (point.value === null) continue;
    sum += point.value;
    count += 1;
  }
  return count === 0 ? null : { mean: sum / count, count };
}
