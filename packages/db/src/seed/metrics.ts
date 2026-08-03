/**
 * The MVP metric registry — Week 1's "metric registry seeded with the MVP's
 * metrics" (§12).
 *
 * §9.2 calls `metric` "the most important table in the system" and explains
 * what these rows are actually for:
 *
 *   "It is the thing that makes the data self-describing in year fifteen — a
 *    bare `74.2` is meaningless, but `74.2` joined to its metric row is a
 *    complete fact."
 *
 * Which means the `description` field below is not documentation of the code.
 * It is data, it travels in the export (§9.10), and it is what a person reading
 * this archive in 2046 will use to understand the numbers. Write it for them.
 *
 * ## The Daily Close budget
 *
 * §4.0 caps the Close at "never more than eleven interactive elements" and adds
 * that "adding a field requires removing a field. The Close is a fixed budget,
 * not a growing form." Seven metrics below carry `inDailyClose`, leaving room
 * for the per-medication adherence toggles, which are generated from the active
 * medication register rather than registered here.
 */

import type { Aggregation, Domain, MetricValueType } from '../schema/enums';

export type MetricSeed = {
  readonly key: string;
  readonly domain: Domain;
  readonly displayName: string;
  readonly description: string;
  readonly valueType: MetricValueType;
  readonly canonicalUnit: string;
  readonly minValue?: string;
  readonly maxValue?: string;
  readonly aggregation: Aggregation;
  readonly inDailyClose?: boolean;
};

/**
 * Every metric the MVP can write.
 *
 * §9.2: "Unregistered metric keys are rejected on write." So this list is not a
 * convenience — it is the complete vocabulary of the MVP, and adding a metric
 * to the application means adding it here first.
 */
export const MVP_METRICS: readonly MetricSeed[] = [
  /* ---------------------------------------------------------------------
   * Mind (§4.7)
   *
   * Mood, energy and anxiety are plain observations, not entities — §9.2:
   * "Only things with internal structure become entities."
   * ------------------------------------------------------------------ */
  {
    key: 'mind.mood',
    domain: 'mind',
    displayName: 'Mood',
    description:
      'Self-reported overall mood on the day, 1 (worst) to 5 (best). Recorded in the Daily Close. A single subjective scale, deliberately coarse: finer granularity is not more accurate, it is just harder to answer in under five seconds.',
    valueType: 'integer',
    canonicalUnit: '',
    minValue: '1',
    maxValue: '5',
    aggregation: 'mean',
    inDailyClose: true,
  },
  {
    key: 'mind.energy',
    domain: 'mind',
    displayName: 'Energy',
    description:
      'Self-reported physical and mental energy, 1 (depleted) to 5 (high). Tracked separately from mood because they dissociate — low energy with stable mood is a different state from both being low, and the difference matters clinically.',
    valueType: 'integer',
    canonicalUnit: '',
    minValue: '1',
    maxValue: '5',
    aggregation: 'mean',
    inDailyClose: true,
  },
  {
    key: 'mind.anxiety',
    domain: 'mind',
    displayName: 'Anxiety level',
    description:
      'Self-reported anxiety, 1 (none) to 5 (severe). This is the day-level baseline; discrete episodes with triggers and coping responses are recorded separately as anxiety_episode entities.',
    valueType: 'integer',
    canonicalUnit: '',
    minValue: '1',
    maxValue: '5',
    aggregation: 'mean',
    inDailyClose: true,
  },

  /* ---------------------------------------------------------------------
   * Sleep (§4.6)
   *
   * "Sleep is the highest-leverage cross-domain variable in the entire system
   * and is therefore in the MVP's Daily Close despite Sleep not being a full
   * module until later."
   * ------------------------------------------------------------------ */
  {
    key: 'body.sleep.duration',
    domain: 'body',
    displayName: 'Sleep duration',
    description:
      'Hours slept, as estimated by the user on waking. Manual in the MVP; imported from a wearable in V3. An estimate, not a measurement — treat a 30-minute difference as noise.',
    valueType: 'duration',
    canonicalUnit: 'hours',
    minValue: '0',
    maxValue: '24',
    aggregation: 'mean',
    inDailyClose: true,
  },
  {
    key: 'body.sleep.quality',
    domain: 'body',
    displayName: 'Sleep quality',
    description:
      'Self-reported restedness on waking, 1 (unrested) to 5 (fully rested). Recorded alongside duration because they diverge often, and the divergence is usually the interesting signal.',
    valueType: 'integer',
    canonicalUnit: '',
    minValue: '1',
    maxValue: '5',
    aggregation: 'mean',
    inDailyClose: true,
  },

  /* ---------------------------------------------------------------------
   * Skin (§4.2)
   * ------------------------------------------------------------------ */
  {
    key: 'body.skin.state',
    domain: 'body',
    displayName: 'Skin state',
    description:
      'Overall skin condition, 1 (worst) to 5 (clear). A single daily judgement across all affected regions. Per-region detail lives in skin_region_state; this is the number that trends.',
    valueType: 'integer',
    canonicalUnit: '',
    minValue: '1',
    maxValue: '5',
    aggregation: 'mean',
    inDailyClose: true,
  },
  {
    key: 'body.skin.region.state',
    domain: 'body',
    displayName: 'Skin state by region',
    description:
      'Skin condition for a single region (face, chest, back), 1 (worst) to 5 (clear). Subject-referenced to the skin_region_state row. Tracked per region because an aggregate hides a chest flare during a good face week.',
    valueType: 'integer',
    canonicalUnit: '',
    minValue: '1',
    maxValue: '5',
    aggregation: 'mean',
  },
  {
    key: 'body.skin.lesion_count',
    domain: 'body',
    displayName: 'Active lesion count',
    description:
      'Count of active inflammatory lesions in a region. Counted manually in the MVP. Deliberately separate from scarring, which changes on a different timescale and responds to different things.',
    valueType: 'integer',
    canonicalUnit: 'count',
    minValue: '0',
    aggregation: 'last',
  },

  /* ---------------------------------------------------------------------
   * Composition (§4.6)
   * ------------------------------------------------------------------ */
  {
    key: 'body.weight',
    domain: 'body',
    displayName: 'Bodyweight',
    description:
      'Bodyweight in kilograms, ideally measured on waking before eating. Day-to-day variation of 1–2 kg is water, not tissue: §4.6 specifies that the honest number for a bulk is the seven-day moving average, not the raw reading.',
    valueType: 'numeric',
    canonicalUnit: 'kg',
    minValue: '20',
    maxValue: '400',
    aggregation: 'mean',
  },

  /* ---------------------------------------------------------------------
   * Gym (§4.1)
   *
   * These are what let Skin query training load "without knowing Gym exists"
   * (P3). The set entity carries the structure; these carry the numbers.
   * ------------------------------------------------------------------ */
  {
    key: 'gym.set.load',
    domain: 'body',
    displayName: 'Set load',
    description:
      'External load for a single set, in kilograms. Subject-referenced to the workout_set row. Excludes bodyweight even for bodyweight movements — the exercise definition records whether bodyweight should be added for relative-strength work.',
    valueType: 'numeric',
    canonicalUnit: 'kg',
    minValue: '0',
    aggregation: 'max',
  },
  {
    key: 'gym.set.reps',
    domain: 'body',
    displayName: 'Set repetitions',
    description:
      'Repetitions completed in a single set. Subject-referenced to the workout_set row.',
    valueType: 'integer',
    canonicalUnit: 'count',
    minValue: '0',
    aggregation: 'sum',
  },
  {
    key: 'gym.set.rpe',
    domain: 'body',
    displayName: 'Set RPE',
    description:
      'Rate of perceived exertion for a set, 1–10, half-points permitted. 10 means no further repetitions were possible. Subjective and known to be unreliable in novice lifters — treat early values as directional.',
    valueType: 'numeric',
    canonicalUnit: '',
    minValue: '1',
    maxValue: '10',
    aggregation: 'mean',
  },
  {
    key: 'gym.session.volume',
    domain: 'body',
    displayName: 'Session volume',
    description:
      'Total load × repetitions across all working sets in a session, in kilograms. Derived by the nightly job, never entered. Warm-up sets are excluded. This is the training-load signal the insight engine consumes for cross-domain work.',
    valueType: 'numeric',
    canonicalUnit: 'kg',
    minValue: '0',
    aggregation: 'sum',
  },
  {
    key: 'gym.session.duration',
    domain: 'body',
    displayName: 'Session duration',
    description:
      'Elapsed time from first to last set, in minutes. Derived from the session record. Includes rest, so it measures time in the gym rather than time under load.',
    valueType: 'duration',
    canonicalUnit: 'minutes',
    minValue: '0',
    aggregation: 'sum',
  },

  /* ---------------------------------------------------------------------
   * Adherence (§2.1) — "one deterministic insight family", the only one in
   * the MVP. No LLM in the MVP path at all.
   * ------------------------------------------------------------------ */
  {
    key: 'medication.adherence',
    domain: 'body',
    displayName: 'Medication adherence',
    description:
      'Doses taken divided by doses scheduled, for one medication on one day. Derived from medication_event rows by the nightly job. A day with no record is not counted as a missed dose — absence of data is not evidence of non-adherence, and conflating them makes every figure quietly wrong.',
    valueType: 'numeric',
    canonicalUnit: 'ratio',
    minValue: '0',
    maxValue: '1',
    aggregation: 'mean',
  },
  {
    key: 'routine.adherence',
    domain: 'body',
    displayName: 'Routine adherence',
    description:
      'Required steps completed divided by required steps scheduled, for one routine on one day. Optional steps are excluded from both sides. Applies to skincare, dental hygiene, and supplements through the shared routine engine.',
    valueType: 'numeric',
    canonicalUnit: 'ratio',
    minValue: '0',
    maxValue: '1',
    aggregation: 'mean',
  },

  /* ---------------------------------------------------------------------
   * The Close itself (§1.5)
   * ------------------------------------------------------------------ */
  {
    key: 'system.daily_close.completed',
    domain: 'system',
    displayName: 'Daily Close completed',
    description:
      'One per day on which a Daily Close was submitted, complete or partial. This is the North Star input: Compounding Days is the count of these in the trailing 90. A partial close counts — §4.0 makes every field optional on purpose, because a system that rejects incomplete data trains you to skip it on a bad day.',
    valueType: 'boolean',
    canonicalUnit: '',
    minValue: '0',
    maxValue: '1',
    aggregation: 'count',
  },
  {
    key: 'system.capture.latency',
    domain: 'system',
    displayName: 'Capture latency',
    description:
      'Milliseconds from cold start to a persisted observation. The §1.4 health metric, budgeted at under five seconds at p50. A sustained rise is a P1 defect, not a performance nice-to-have.',
    valueType: 'duration',
    canonicalUnit: 'milliseconds',
    minValue: '0',
    aggregation: 'median',
  },
];

/** The Daily Close subset, in presentation order. Asserted against §4.0's cap. */
export const DAILY_CLOSE_METRICS = MVP_METRICS.filter((m) => m.inDailyClose === true);
