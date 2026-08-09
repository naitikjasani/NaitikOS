/**
 * The routine engine — §9.2's "one implementation, three consumers".
 *
 *   "A generic routine engine reused by skincare, dental hygiene, and
 *    supplements. One implementation, three consumers — the alternative is
 *    three near-identical adherence systems."
 *
 * Only skincare has a surface in the MVP. The engine is generic anyway, because
 * the cost of writing it generic now is a `kind` field, and the cost of not
 * doing so is discovering in V2 that dental hygiene needs the same fifteen
 * functions with different names.
 *
 * ## Three decisions
 *
 * **Optional steps are excluded from both sides of the ratio.** Straight from
 * the registry description of `routine.adherence`. A routine with eight steps of
 * which three are nice-to-have is a five-step routine for adherence purposes,
 * and including the optional three would make a perfectly adherent night look
 * like 62%.
 *
 * **A `partial` step counts as completed.** The question adherence answers is
 * "did the routine happen", and a step done imperfectly is a step that
 * happened. The alternative — half credit — invents a precision the record does
 * not have, in the same way `SECONDARY_MUSCLE_SHARE` does in Gym, and unlike
 * that constant it would buy nothing. The partial count is reported separately
 * for anyone who wants it.
 *
 * **A day with no log is not a missed routine.** Identical to the medication
 * rule, for identical reasons: absence of a record is not a record of absence.
 * {@link windowAdherence} reports unrecorded days as their own number and never
 * folds them into the ratio.
 */

import { dayKeyIndex, shiftDayKey } from '../../temporal/instant';

export const ROUTINE_ADHERENCE_METRIC = 'routine.adherence';

export const ROUTINE_KINDS = Object.freeze(['skincare', 'dental', 'supplement', 'other'] as const);
export type RoutineKind = (typeof ROUTINE_KINDS)[number];

export const ROUTINE_PERIODS = Object.freeze(['am', 'pm', 'midday', 'as_needed'] as const);
export type RoutinePeriod = (typeof ROUTINE_PERIODS)[number];

export const ROUTINE_PERIOD_LABELS: Readonly<Record<RoutinePeriod, string>> = Object.freeze({
  am: 'Morning',
  pm: 'Evening',
  midday: 'Midday',
  as_needed: 'As needed',
});

export type RoutineStepStatus = 'done' | 'skipped' | 'partial';

export type Routine = {
  readonly id: string;
  readonly kind: RoutineKind;
  readonly period: RoutinePeriod;
  readonly name: string;
  readonly isActive: boolean;
  /** Local `HH:MM` the routine is expected. Drives the reminder (§5.9). */
  readonly expectedAt: string | null;
};

export type RoutineStep = {
  readonly id: string;
  readonly routineId: string;
  readonly orderIndex: number;
  readonly label: string;
  readonly productId: string | null;
  readonly medicationId: string | null;
  readonly isOptional: boolean;
  readonly instructions: string | null;
};

export type RoutineLog = {
  readonly id: string;
  readonly routineId: string;
  readonly stepId: string | null;
  readonly occurredOn: string;
  readonly completedAt: string | null;
  readonly zone: string | null;
  readonly status: RoutineStepStatus;
  readonly note: string | null;
};

/** The steps that count. Optional steps are excluded from both sides (§9.2). */
export function requiredSteps(steps: readonly RoutineStep[]): readonly RoutineStep[] {
  return steps.filter((step) => !step.isOptional);
}

/* -------------------------------------------------------------------------
 * One day
 * ---------------------------------------------------------------------- */

export type DayRoutineAdherence = {
  readonly dayKey: string;
  readonly routineId: string;
  readonly required: number;
  readonly completed: number;
  readonly partial: number;
  readonly skipped: number;
  /** `completed / required`, or `null` when nothing was logged. */
  readonly ratio: number | null;
  readonly recorded: boolean;
  /** Required steps with no log at all on this day. */
  readonly unlogged: readonly string[];
};

export function dayAdherence(
  routine: Routine,
  steps: readonly RoutineStep[],
  logs: readonly RoutineLog[],
  dayKey: string,
): DayRoutineAdherence {
  const required = requiredSteps(steps.filter((step) => step.routineId === routine.id));
  const requiredIds = new Set(required.map((step) => step.id));

  const onDay = logs.filter((log) => log.routineId === routine.id && log.occurredOn === dayKey);

  let completed = 0;
  let partial = 0;
  let skipped = 0;
  const logged = new Set<string>();

  for (const log of onDay) {
    // A step-less log is a whole-routine completion; it is counted, not required.
    if (log.stepId === null) continue;
    if (!requiredIds.has(log.stepId)) continue;
    if (logged.has(log.stepId)) continue;
    logged.add(log.stepId);

    if (log.status === 'skipped') skipped += 1;
    else {
      completed += 1;
      if (log.status === 'partial') partial += 1;
    }
  }

  const recorded = onDay.length > 0;
  const ratio = !recorded || required.length === 0 ? null : Math.min(1, completed / required.length);

  return {
    dayKey,
    routineId: routine.id,
    required: required.length,
    completed,
    partial,
    skipped,
    ratio,
    recorded,
    unlogged: required.filter((step) => !logged.has(step.id)).map((step) => step.id),
  };
}

/* -------------------------------------------------------------------------
 * A window
 * ---------------------------------------------------------------------- */

export type RoutineWindowAdherence = {
  readonly routineId: string;
  readonly name: string;
  readonly windowDays: number;
  readonly recordedDays: number;
  readonly unrecordedDays: number;
  readonly stepsCompleted: number;
  readonly stepsRequired: number;
  readonly ratio: number | null;
  /** Consecutive most-recent days with a full completion. */
  readonly currentStreak: number;
  readonly sentence: string;
  readonly days: readonly DayRoutineAdherence[];
};

export function windowAdherence(
  routine: Routine,
  steps: readonly RoutineStep[],
  logs: readonly RoutineLog[],
  dayKeys: readonly string[],
): RoutineWindowAdherence {
  const ordered = [...dayKeys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const days = ordered.map((dayKey) => dayAdherence(routine, steps, logs, dayKey));

  let recordedDays = 0;
  let stepsCompleted = 0;
  let stepsRequired = 0;

  for (const day of days) {
    if (!day.recorded) continue;
    recordedDays += 1;
    stepsCompleted += day.completed;
    stepsRequired += day.required;
  }

  const ratio = stepsRequired === 0 ? null : Math.min(1, stepsCompleted / stepsRequired);
  const unrecordedDays = days.length - recordedDays;

  const sentence =
    ratio === null
      ? `No steps logged for ${routine.name} in the last ${String(days.length)} days.`
      : `${String(stepsCompleted)} of ${String(stepsRequired)} required steps completed across ${String(recordedDays)} days with a log. ${
          unrecordedDays === 0
            ? 'Every day in the window has a log.'
            : `${String(unrecordedDays)} days have no log either way.`
        }`;

  return {
    routineId: routine.id,
    name: routine.name,
    windowDays: days.length,
    recordedDays,
    unrecordedDays,
    stepsCompleted,
    stepsRequired,
    ratio,
    currentStreak: currentStreak(days),
    sentence,
    days,
  };
}

/**
 * The current run of complete days, counted backwards from the most recent day
 * in the window.
 *
 * A day is part of the streak when every required step was completed. An
 * unrecorded day **ends** the streak — and this is the one place the
 * absence-is-not-a-miss rule does not apply, on purpose. A streak is a claim
 * about consecutive days; letting silence pass through it would let a
 * fortnight of not opening the app leave a "17-day streak" standing, which is
 * the kind of flattering nonsense that makes a number worthless.
 *
 * The distinction is worth stating plainly: the *ratio* refuses to guess, and
 * the *streak* refuses to flatter. Those are different questions.
 */
function currentStreak(days: readonly DayRoutineAdherence[]): number {
  let streak = 0;
  for (let index = days.length - 1; index >= 0; index -= 1) {
    const day = days[index];
    if (day === undefined) break;
    if (!day.recorded || day.required === 0 || day.completed < day.required) break;
    streak += 1;
  }
  return streak;
}

/* -------------------------------------------------------------------------
 * Day keys for a window
 * ---------------------------------------------------------------------- */

/**
 * The `windowDays` day keys ending at `endDayKey`, oldest first.
 *
 * Pure string arithmetic through `shiftDayKey`, so it needs no `Date` (§11.3)
 * and no zone — the caller has already resolved the day in the operator's zone,
 * and re-deriving it here would be the §5.3 bug arriving through the back door.
 */
export function windowDayKeys(endDayKey: string, windowDays: number): readonly string[] {
  if (windowDays <= 0 || dayKeyIndex(endDayKey) === null) return [];
  const keys: string[] = [];
  for (let offset = windowDays - 1; offset >= 0; offset -= 1) {
    const key = shiftDayKey(endDayKey, -offset);
    if (key !== null) keys.push(key);
  }
  return keys;
}

/* -------------------------------------------------------------------------
 * Due now
 * ---------------------------------------------------------------------- */

/**
 * Whether a routine is due at a local clock time.
 *
 * Takes `HH:MM` rather than an instant, because the routine's expectation is a
 * wall-clock fact — "the evening routine is at 22:00" stays true across a
 * timezone change, and resolving it against an instant here would need a zone
 * this module has no business knowing.
 *
 * `as_needed` routines are never due; that is what the period means.
 */
export function isRoutineDue(routine: Routine, localTime: string, toleranceMinutes = 120): boolean {
  if (!routine.isActive || routine.period === 'as_needed') return false;
  if (routine.expectedAt === null) return false;
  const expected = minutesOfDay(routine.expectedAt);
  const now = minutesOfDay(localTime);
  if (expected === null || now === null) return false;
  return now >= expected - toleranceMinutes && now <= expected + toleranceMinutes;
}

function minutesOfDay(time: string): number | null {
  const match = /^(\d{2}):(\d{2})$/u.exec(time.trim());
  if (match === null) return null;
  const [, hours, minutes] = match;
  if (hours === undefined || minutes === undefined) return null;
  const h = Number(hours);
  const m = Number(minutes);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}
