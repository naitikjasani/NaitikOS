/**
 * Goal targets — §4.10.
 *
 * A goal is a declaration; a target is the measurable part of it. §4.10 is
 * unusually firm about the boundary:
 *
 *   "Goals are **not a module with its own data**. A goal is a declaration plus
 *    a projection over observations that already exist... Recording progress
 *    separately from the underlying observations would create two sources of
 *    truth and guarantee drift."
 *
 * So a target names a metric, a comparator and a number, and *nothing here ever
 * writes a progress value*. `progress.ts` derives it on read, every time.
 *
 * ## The three comparators, and why a rate is not just another number
 *
 * `at_least` and `at_most` compare the metric's current level. `rate_of_change`
 * compares its *slope*, which is a different question with a different failure
 * mode: "gain 0.25 kg a week" is not satisfied by weighing 76 kg, it is
 * satisfied by the line through the last few weeks having the right gradient.
 * Conflating them is how a bulk target reads as met on the day the operator
 * steps on the scale after dinner.
 *
 * A rate target therefore requires `windowDays` — the span the slope is
 * measured over. Without one there is no defined question, and
 * {@link validateTarget} rejects it rather than picking a default: a silently
 * assumed 30-day window is a different goal from the one the operator set.
 */

import type { Result } from '@naitikos/shared';
import { err, ok } from '@naitikos/shared';

import type { DomainError } from '../../errors/domain-error';
import { validationError } from '../../errors/domain-error';
import { parseInstant } from '../../temporal/instant';

/** Mirrors the `goal_status` pgEnum exactly. */
export const GOAL_STATUSES = Object.freeze([
  'active',
  'achieved',
  'abandoned',
  'paused',
  /** Kept for §4.10's "goal archaeology" — why did this stop mattering? */
  'superseded',
] as const);

export type GoalStatus = (typeof GOAL_STATUSES)[number];

export const GOAL_STATUS_LABELS: Readonly<Record<GoalStatus, string>> = Object.freeze({
  active: 'Active',
  achieved: 'Achieved',
  abandoned: 'Abandoned',
  paused: 'Paused',
  superseded: 'Superseded',
});

/**
 * `goal_target.comparator` is a text column, not an enum — the schema comment
 * lists these three and stops there. The closed set lives here, in the layer
 * that has to interpret it.
 */
export const GOAL_COMPARATORS = Object.freeze(['at_least', 'at_most', 'rate_of_change'] as const);

export type GoalComparator = (typeof GOAL_COMPARATORS)[number];

export function isGoalComparator(value: string): value is GoalComparator {
  return (GOAL_COMPARATORS as readonly string[]).includes(value);
}

export type Goal = {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly status: GoalStatus;
  readonly startedAt: string | null;
  readonly horizonAt: string | null;
  readonly achievedAt: string | null;
  /** §4.10's archaeology: why it stopped mattering. */
  readonly closingNote: string | null;
  readonly supersedesGoalId: string | null;
};

export type GoalTarget = {
  readonly id: string;
  readonly goalId: string;
  readonly metricKey: string;
  readonly comparator: GoalComparator;
  /** Decimal string. §5.3 keeps floats off the path a measured quantity travels. */
  readonly targetValue: string;
  readonly unit: string;
  /** Required for `rate_of_change`, meaningless otherwise. */
  readonly windowDays: number | null;
};

export type GoalTargetInput = {
  readonly id: string;
  readonly metricKey: string;
  readonly comparator: string;
  readonly targetValue: string;
  readonly unit: string;
  readonly windowDays?: number | null;
};

export type GoalInput = {
  readonly id: string;
  readonly title: string;
  readonly description?: string | null;
  readonly startedAt: string;
  readonly horizonAt?: string | null;
  readonly targets: readonly GoalTargetInput[];
};

/**
 * How a target reads in a sentence.
 *
 * A rate is rendered **per week**, never per day. `linearTrend` computes units
 * per day because that is the natural unit of a daily series; nobody thinks in
 * kilograms per day, and a target of "0.036 kg/day" is a number the operator
 * would never have typed.
 */
export function describeTarget(target: GoalTarget): string {
  const value = trimZeros(target.targetValue);
  const unit = target.unit === '' ? '' : ` ${target.unit}`;

  switch (target.comparator) {
    case 'at_least':
      return `at least ${value}${unit}`;
    case 'at_most':
      return `at most ${value}${unit}`;
    default: {
      const window = target.windowDays === null ? '' : ` over ${String(target.windowDays)} days`;
      return `${value}${unit} per week${window}`;
    }
  }
}

export function validateGoal(input: GoalInput): Result<GoalInput, DomainError> {
  if (input.title.trim() === '') {
    return err(validationError('goal_title_empty', 'A goal needs a title.'));
  }
  if (parseInstant(input.startedAt) === null) {
    return err(validationError('goal_started_at_invalid', 'startedAt must be an ISO-8601 instant.'));
  }
  if (input.horizonAt !== undefined && input.horizonAt !== null) {
    if (parseInstant(input.horizonAt) === null) {
      return err(validationError('goal_horizon_invalid', 'horizonAt must be an ISO-8601 instant.'));
    }
    if (input.horizonAt < input.startedAt) {
      return err(validationError('goal_horizon_before_start', 'A horizon cannot precede the start.'));
    }
  }
  if (input.targets.length === 0) {
    /*
     * §4.10: "goal definition with a measurable target". A goal with no target
     * is an intention, and an intention with a progress bar next to it is the
     * thing this module exists not to be.
     */
    return err(validationError('goal_target_missing', 'A goal needs at least one measurable target.'));
  }

  for (const target of input.targets) {
    const validated = validateTarget(target);
    if (!validated.ok) return validated;
  }

  return ok(input);
}

export function validateTarget(target: GoalTargetInput): Result<GoalTargetInput, DomainError> {
  if (!isGoalComparator(target.comparator)) {
    return err(validationError('goal_comparator_unknown', `Unknown comparator: ${target.comparator}.`));
  }
  if (!/^-?\d+(\.\d+)?$/u.test(target.targetValue)) {
    return err(validationError('goal_target_value_invalid', 'A target value must be a decimal number.'));
  }
  if (target.comparator === 'rate_of_change') {
    const window = target.windowDays ?? null;
    if (window === null || !Number.isInteger(window) || window < MIN_RATE_WINDOW_DAYS) {
      return err(
        validationError(
          'goal_rate_window_missing',
          `A rate target needs a window of at least ${String(MIN_RATE_WINDOW_DAYS)} days. Without one there is no question to answer.`,
        ),
      );
    }
  }
  return ok(target);
}

/**
 * The shortest window a slope may be measured over.
 *
 * Fourteen days, matching `MIN_TREND_POINTS = 4` in spirit rather than in
 * arithmetic: a rate fitted over a week of bodyweight is dominated by water and
 * gut content, and it will read as a spectacular gain or an alarming loss
 * depending on which morning the window happens to start.
 */
export const MIN_RATE_WINDOW_DAYS = 14;

/** `76.500000` out of `numeric(20,6)` is not a number anybody wants to read. */
function trimZeros(value: string): string {
  return value.includes('.') ? value.replace(/\.?0+$/u, '') : value;
}
