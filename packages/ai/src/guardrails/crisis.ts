/**
 * Crisis handling — §10.10, §4.7.
 *
 *   "Detected crisis indicators route to **exactly one behaviour**: display the
 *    user's own stored crisis plan (§9.2). **No model call. No generated
 *    message. No suggestion.** The system's entire contribution in that moment
 *    is to show the person what they wrote for themselves when they were well —
 *    which is both safer and more useful than anything a model could produce."
 *
 * ## Why this lives in the guardrail layer and not in Mind
 *
 * Because it is a *veto over the AI layer*, not a feature of the mood module.
 * Any surface that is about to call a model asks this first, and a positive
 * answer means the call does not happen — including calls that have nothing to
 * do with mood. Someone in crisis should not receive a cheerful nightly
 * narration about their protein intake.
 *
 * ## The detection is deliberately crude, and that is correct
 *
 * A sensitive detector that occasionally shows the operator their own crisis
 * plan when they were merely having a bad week costs them one dismissible
 * screen. A specific detector that occasionally misses costs something that
 * does not have a price. The asymmetry is total, so the thresholds below are
 * set to over-trigger and the return path is one tap.
 *
 * It is also **not a diagnosis and not a risk score**. There is no number here,
 * nothing is stored, and nothing is reported anywhere. It is a routing
 * decision — model, or plan — and that is the whole of its authority.
 */

/**
 * Consecutive days at or below this on a 1–5 scale.
 *
 * Two, not five. §4.7's phrasing is "sustained severe readings", and two days
 * at the bottom of the scale is sustained enough given the asymmetry above.
 */
export const SEVERE_MOOD_MAX = 1;
export const SUSTAINED_DAYS = 2;

/** Anxiety at or above this on a 1–5 scale, on the same sustained window. */
export const SEVERE_ANXIETY_MIN = 5;

export type DayReading = {
  readonly dayKey: string;
  readonly mood: number | null;
  readonly anxiety: number | null;
};

export type CrisisRouting =
  | { readonly route: 'model' }
  | {
      readonly route: 'crisis_plan';
      /** Which readings triggered it, so the surface can say "the last two days". */
      readonly dayKeys: readonly string[];
    };

export const ROUTE_TO_MODEL: CrisisRouting = Object.freeze({ route: 'model' });

/**
 * Decide where this moment routes.
 *
 * Reads the most recent {@link SUSTAINED_DAYS} days with a recording. Days with
 * nothing logged are **skipped, not treated as zero** — a person who did not
 * open the app is not a person in crisis, and §8.9(3)'s "gaps are gaps" applies
 * to a safety decision at least as strongly as it does to a chart.
 */
export function routeForReadings(readings: readonly DayReading[]): CrisisRouting {
  const recorded = readings
    .filter((entry) => entry.mood !== null || entry.anxiety !== null)
    .sort((a, b) => b.dayKey.localeCompare(a.dayKey))
    .slice(0, SUSTAINED_DAYS);

  if (recorded.length < SUSTAINED_DAYS) return ROUTE_TO_MODEL;

  const allSevere = recorded.every(
    (entry) =>
      (entry.mood !== null && entry.mood <= SEVERE_MOOD_MAX) ||
      (entry.anxiety !== null && entry.anxiety >= SEVERE_ANXIETY_MIN),
  );

  return allSevere ? { route: 'crisis_plan', dayKeys: recorded.map((entry) => entry.dayKey) } : ROUTE_TO_MODEL;
}

/**
 * The text shown above the plan.
 *
 * A constant, not a template and not a model call. §4.7 permits exactly one
 * behaviour here, and a sentence assembled at runtime is one that could be
 * assembled wrongly at the worst possible moment.
 *
 * It says what happened and why, and it does not ask a question, offer a
 * suggestion, or express concern — an app expressing concern is a category
 * error, and the person reading this knows more about their own situation than
 * the software does.
 */
export const CRISIS_PLAN_PREFACE =
  'This is what you wrote for yourself, when you were well.';
