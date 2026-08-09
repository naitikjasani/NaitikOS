/**
 * The §1.4 metrics, computed.
 *
 * ## Why these live in `core` and not in a dashboard component
 *
 * §12's V1 phase is thirty days with **no new features**, instrumented for four
 * things: "capture latency, Daily Close completion, drop-off points, sync
 * failures". The gate at the end of it — Compounding Days ≥ 25 of 30 — decides
 * whether October is spent on capture friction or on V2, and §12 says the
 * discipline to honour it "is the difference between a system that lasts and a
 * graveyard of half-built modules."
 *
 * A gate that decides that much cannot be arithmetic inside a chart. It is a
 * domain rule, it is tested against literals, and it lives here.
 *
 * ## The counter-metric is the interesting one
 *
 * §1.4: "Time in app — median daily foreground minutes — **≤ 6 min, and
 * falling**. The counter-metric is not decorative. If daily time-in-app is
 * rising, the system is failing... Treat a sustained rise as a P1 defect."
 *
 * And §1.5's anti-goal: "the North Star must never be pursued by making the
 * Daily Close longer or richer. If Compounding Days rises while median capture
 * latency also rises, the metric has been gamed against its own purpose."
 *
 * {@link detectGaming} is that sentence as a function. It is the only thing in
 * this file that returns a judgement, and it is a judgement about the *system*,
 * never about the operator.
 */

/* -------------------------------------------------------------------------
 * Distributions
 * ---------------------------------------------------------------------- */

export type Distribution = {
  readonly count: number;
  readonly p50: number | null;
  readonly p90: number | null;
  readonly min: number | null;
  readonly max: number | null;
};

export const EMPTY_DISTRIBUTION: Distribution = Object.freeze({
  count: 0,
  p50: null,
  p90: null,
  min: null,
  max: null,
});

/**
 * Percentiles by nearest-rank, and `null` rather than 0 for an empty sample.
 *
 * Nearest-rank rather than interpolated: an interpolated p50 of a two-sample
 * set invents a latency that was never measured, and §1.4's budget is checked
 * against real captures. `null` for empty because "no captures recorded" and
 * "every capture took 0 ms" are different facts, and a dashboard that showed
 * 0 ms for the first would report the health metric as passing on a day nothing
 * was logged.
 */
export function distributionOf(samples: readonly number[]): Distribution {
  const usable = samples.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (usable.length === 0) return EMPTY_DISTRIBUTION;

  return {
    count: usable.length,
    p50: percentile(usable, 0.5),
    p90: percentile(usable, 0.9),
    min: usable[0] ?? null,
    max: usable.at(-1) ?? null,
  };
}

function percentile(sorted: readonly number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil(fraction * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] ?? null;
}

/* -------------------------------------------------------------------------
 * The §1.4 table
 * ---------------------------------------------------------------------- */

/** §1.4's health budget for capture, at p50. */
export const CAPTURE_LATENCY_BUDGET_MS = 5_000;

/** §1.4's counter-metric ceiling, in minutes per day. */
export const TIME_IN_APP_CEILING_MINUTES = 6;

/** §1.4's trust bound: corrections divided by facts. */
export const CORRECTION_RATE_CEILING = 0.02;

/** §1.4's day-180 target for observations arriving from import or derivation. */
export const DERIVED_FACT_TARGET = 0.6;

export type MetricStatus = 'within' | 'over' | 'unknown';

export type BudgetedMetric = {
  readonly value: number | null;
  readonly budget: number;
  readonly status: MetricStatus;
  /** The sample size behind the value. A p50 of two captures is not a p50. */
  readonly n: number;
  readonly sentence: string;
};

/**
 * Median capture latency against §1.4's budget.
 *
 * The `n` travels with it because a p50 over three captures is noise wearing a
 * statistic's clothes, and a dashboard that showed "4.1 s ✓" without it would
 * be the same over-claiming P5 forbids everywhere else.
 */
export function captureLatency(samplesMs: readonly number[]): BudgetedMetric {
  const distribution = distributionOf(samplesMs);
  const value = distribution.p50;

  if (value === null) {
    return {
      value: null,
      budget: CAPTURE_LATENCY_BUDGET_MS,
      status: 'unknown',
      n: 0,
      sentence: 'No captures measured in this window.',
    };
  }

  return {
    value,
    budget: CAPTURE_LATENCY_BUDGET_MS,
    status: value <= CAPTURE_LATENCY_BUDGET_MS ? 'within' : 'over',
    n: distribution.count,
    sentence: `Median ${formatSeconds(value)} over ${String(distribution.count)} captures, against a budget of ${formatSeconds(CAPTURE_LATENCY_BUDGET_MS)}. p90 ${formatSeconds(distribution.p90 ?? value)}.`,
  };
}

/**
 * The counter-metric.
 *
 * §1.4 wants it "≤ 6 min, **and falling**". Only the first half is checkable
 * from one window, so this reports the level and {@link detectGaming} handles
 * the direction — a metric that is under budget and climbing is the failure
 * §1.4 describes, and neither half detects it alone.
 */
export function timeInApp(minutesPerDay: readonly number[]): BudgetedMetric {
  const distribution = distributionOf(minutesPerDay);
  const value = distribution.p50;

  if (value === null) {
    return {
      value: null,
      budget: TIME_IN_APP_CEILING_MINUTES,
      status: 'unknown',
      n: 0,
      sentence: 'No foreground time measured in this window.',
    };
  }

  return {
    value,
    budget: TIME_IN_APP_CEILING_MINUTES,
    status: value <= TIME_IN_APP_CEILING_MINUTES ? 'within' : 'over',
    n: distribution.count,
    sentence: `Median ${value.toFixed(1)} minutes a day across ${String(distribution.count)} days with any use, against a ceiling of ${String(TIME_IN_APP_CEILING_MINUTES)}.`,
  };
}

/**
 * Corrections divided by facts.
 *
 * The numerator is superseded observations (§9.1 makes a correction a
 * supersession, never an update), so this is exactly countable rather than
 * estimated. `null` when nothing has been recorded: 0/0 is not 0%.
 */
export function correctionRate(totalFacts: number, correctedFacts: number): BudgetedMetric {
  if (totalFacts <= 0) {
    return {
      value: null,
      budget: CORRECTION_RATE_CEILING,
      status: 'unknown',
      n: 0,
      sentence: 'No facts recorded in this window.',
    };
  }

  const value = correctedFacts / totalFacts;
  return {
    value,
    budget: CORRECTION_RATE_CEILING,
    status: value <= CORRECTION_RATE_CEILING ? 'within' : 'over',
    n: totalFacts,
    sentence: `${String(correctedFacts)} of ${String(totalFacts)} facts corrected after entry (${(value * 100).toFixed(1)}%), against a ceiling of ${(CORRECTION_RATE_CEILING * 100).toFixed(0)}%.`,
  };
}

/**
 * Observations arriving from import or derivation, over all observations.
 *
 * §1.4's day-180 target is ≥ 0.6, and the MVP will be nowhere near it — there
 * are no imports, and the only derivation is the nightly session volume. That
 * is *expected*, and the sentence says so rather than rendering a red bar for
 * six months.
 */
export function derivedFactRatio(bySource: Readonly<Record<string, number>>): BudgetedMetric {
  const total = Object.values(bySource).reduce((sum, count) => sum + count, 0);
  if (total === 0) {
    return {
      value: null,
      budget: DERIVED_FACT_TARGET,
      status: 'unknown',
      n: 0,
      sentence: 'No observations in this window.',
    };
  }

  const manual = bySource['manual'] ?? 0;
  const value = (total - manual) / total;

  return {
    value,
    budget: DERIVED_FACT_TARGET,
    /*
     * A *floor*, not a ceiling — this is the one §1.4 metric where higher is
     * better, and treating it like the others would report a healthy system as
     * failing. It stays `unknown` in the MVP rather than `over`, because there
     * is no import path yet and flagging its absence every day would train the
     * operator to ignore the whole dashboard.
     */
    status: 'unknown',
    n: total,
    sentence: `${String(total - manual)} of ${String(total)} observations derived or imported (${(value * 100).toFixed(0)}%). The §1.4 target of ${String(Math.round(DERIVED_FACT_TARGET * 100))}% is a day-180 figure and imports do not exist yet, so this is context rather than a verdict.`,
  };
}

/* -------------------------------------------------------------------------
 * Sessionising, for the counter-metric
 * ---------------------------------------------------------------------- */

/** A gap longer than this ends a foreground session. */
export const SESSION_GAP_MINUTES = 5;

export type TimedEvent = {
  readonly dayKey: string;
  readonly atMillis: number;
};

/**
 * Foreground minutes per day, approximated from route transitions.
 *
 * **This is an approximation and the dashboard says so.** A browser gives no
 * reliable foreground timer, so the method is: sort a day's route transitions,
 * split them wherever more than {@link SESSION_GAP_MINUTES} elapsed, and sum
 * the spans.
 *
 * Two known biases, both stated rather than corrected for:
 *
 * - **A single-transition session counts as zero.** Opening the app, reading
 *   Today, and closing it registers no span. That is the most common session
 *   shape in a system whose counter-metric wants to be small, so the figure
 *   understates.
 * - **A tab left open counts up to five minutes past the last interaction.**
 *   That overstates, in the opposite direction.
 *
 * The two do not cancel, and pretending they do would be worse than the
 * approximation. The figure is useful for its *trend*, which is what §1.4
 * actually asks for ("≤ 6 min, and falling").
 */
export function foregroundMinutesByDay(
  events: readonly TimedEvent[],
  gapMinutes: number = SESSION_GAP_MINUTES,
): ReadonlyMap<string, number> {
  const byDay = new Map<string, number[]>();
  for (const event of events) {
    if (!Number.isFinite(event.atMillis)) continue;
    const existing = byDay.get(event.dayKey);
    if (existing === undefined) byDay.set(event.dayKey, [event.atMillis]);
    else existing.push(event.atMillis);
  }

  const gapMs = gapMinutes * 60_000;
  const minutes = new Map<string, number>();

  for (const [dayKey, stamps] of byDay) {
    const sorted = [...stamps].sort((a, b) => a - b);
    let total = 0;
    for (let index = 1; index < sorted.length; index += 1) {
      const previous = sorted[index - 1];
      const current = sorted[index];
      if (previous === undefined || current === undefined) continue;
      const delta = current - previous;
      if (delta > gapMs) continue; // A new session, not time spent.
      total += delta;
    }
    minutes.set(dayKey, total / 60_000);
  }

  return minutes;
}

/* -------------------------------------------------------------------------
 * Drop-off
 * ---------------------------------------------------------------------- */

export type CompletionFunnel = {
  readonly started: number;
  readonly completed: number;
  /** `completed / started`, or `null` when nothing was started. */
  readonly rate: number | null;
  readonly abandoned: number;
  readonly sentence: string;
};

/**
 * §12's "drop-off points", for the one flow that matters.
 *
 * A Close that was opened and not submitted is the single most informative
 * event in the validation window: it is the operator meeting the ritual and
 * deciding against it, which is precisely the friction the thirty days exist to
 * find.
 *
 * Reported without any framing about the operator. "3 opened and not submitted"
 * is a fact about the *form*.
 */
export function closeFunnel(started: number, completed: number): CompletionFunnel {
  if (started <= 0) {
    return {
      started: 0,
      completed,
      rate: null,
      abandoned: 0,
      sentence: 'The Daily Close was not opened in this window.',
    };
  }

  const abandoned = Math.max(0, started - completed);
  return {
    started,
    completed,
    rate: Math.min(1, completed / started),
    abandoned,
    sentence:
      abandoned === 0
        ? `The Close was opened ${String(started)} times and submitted every time.`
        : `The Close was opened ${String(started)} times and submitted ${String(completed)}. ${String(abandoned)} were opened and left.`,
  };
}

/* -------------------------------------------------------------------------
 * §1.5's anti-goal, as a check
 * ---------------------------------------------------------------------- */

export type GamingVerdict = {
  readonly gamed: boolean;
  readonly sentence: string;
};

/**
 * "If Compounding Days rises while median capture latency also rises, the
 * metric has been gamed against its own purpose." (§1.5)
 *
 * The check nobody would write unprompted, which is why it is in the blueprint
 * and therefore here. Both figures moving up together means the ritual is being
 * completed *more* and costing *more*, which is the North Star eating the
 * counter-metric.
 *
 * Deliberately conservative: it needs both windows populated and both movements
 * material, because a false positive on this would have the operator "fixing"
 * a system that is working.
 */
export function detectGaming(input: {
  readonly compoundingDaysNow: number;
  readonly compoundingDaysBefore: number;
  readonly latencyP50Now: number | null;
  readonly latencyP50Before: number | null;
  readonly timeInAppNow: number | null;
  readonly timeInAppBefore: number | null;
}): GamingVerdict {
  const { latencyP50Now, latencyP50Before, timeInAppNow, timeInAppBefore } = input;

  const daysRose = input.compoundingDaysNow > input.compoundingDaysBefore;
  const latencyRose =
    latencyP50Now !== null && latencyP50Before !== null && latencyP50Now > latencyP50Before * 1.1;
  const timeRose =
    timeInAppNow !== null && timeInAppBefore !== null && timeInAppNow > timeInAppBefore * 1.1;

  if (!daysRose || !(latencyRose || timeRose)) {
    return { gamed: false, sentence: 'Compounding Days and the cost of capture are not both rising.' };
  }

  return {
    gamed: true,
    sentence:
      'Compounding Days rose and so did the cost of capture. §1.5 names this: the North Star must never be pursued by making the ritual longer or richer. Worth looking at what was added to the Close.',
  };
}

function formatSeconds(milliseconds: number): string {
  return `${(milliseconds / 1000).toFixed(1)} s`;
}
