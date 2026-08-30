/**
 * The spend cap — §10.11, §5.16.
 *
 *   "A hard monthly cap in code, enforced **before the call**, with a soft
 *    warning at 70% and a fail-closed message beyond it... the cap exists
 *    because the failure mode of an unbounded loop is a bill, and **a bill is a
 *    reason to turn the system off**."
 *
 * That last clause is why this is a guardrail and not an optimisation. The
 * risk being managed is not cost; it is abandonment, which §13.1 lists as the
 * single most likely way this whole system fails.
 *
 * ## Minor units, not floats
 *
 * §5.3 keeps floats off the path a measured quantity travels, and money is the
 * canonical case. Everything here is integer cents, matching
 * `ai_interaction.cost_minor`.
 */

import type { AiTask } from '../client/routing';
import { PRICING } from '../client/routing';

/**
 * The cap, in cents per calendar month.
 *
 * §10.11 puts realistic steady-state at "single-digit dollars per month" given
 * batch pricing and Haiku routing of the high-volume paths. Twenty dollars is
 * roughly three times that: high enough that ordinary use never touches it, low
 * enough that a runaway loop is caught within a day rather than at the end of a
 * billing cycle.
 */
export const MONTHLY_CAP_MINOR = 2_000;

/** §10.11's soft warning. */
export const WARN_FRACTION = 0.7;

export type BudgetState = 'ok' | 'warning' | 'exhausted';

export type BudgetVerdict = {
  readonly state: BudgetState;
  readonly spentMinor: number;
  readonly capMinor: number;
  /** `false` means the call must not be made. */
  readonly allowed: boolean;
  readonly sentence: string;
};

/**
 * Whether a call may proceed, checked **before** it is made.
 *
 * The estimate is included in the comparison rather than only the spend so far,
 * because a call that would cross the cap is a call that must not start. Only
 * checking after the fact means the cap is exceeded by exactly one call every
 * month, forever — and that call is the expensive Opus one.
 */
export function checkBudget(input: {
  readonly spentMinor: number;
  readonly estimatedMinor: number;
  readonly capMinor?: number;
}): BudgetVerdict {
  const capMinor = input.capMinor ?? MONTHLY_CAP_MINOR;
  const projected = input.spentMinor + input.estimatedMinor;

  if (projected > capMinor) {
    return {
      state: 'exhausted',
      spentMinor: input.spentMinor,
      capMinor,
      allowed: false,
      sentence: `The monthly AI budget of ${money(capMinor)} would be exceeded by this call. Nothing was sent. Nightly narration is paused until the month rolls over, or until the cap is raised in settings — every number in the app is computed without a model and is unaffected.`,
    };
  }

  if (projected > capMinor * WARN_FRACTION) {
    return {
      state: 'warning',
      spentMinor: input.spentMinor,
      capMinor,
      allowed: true,
      sentence: `${money(input.spentMinor)} of ${money(capMinor)} used this month.`,
    };
  }

  return {
    state: 'ok',
    spentMinor: input.spentMinor,
    capMinor,
    allowed: true,
    sentence: `${money(input.spentMinor)} of ${money(capMinor)} used this month.`,
  };
}

/**
 * What a call is expected to cost, in cents, rounded **up**.
 *
 * Up, always: the estimate gates the call, and an estimate that rounded down
 * would let the cap be crossed by a fraction of a cent per call. Over a nightly
 * batch that is not nothing, and more importantly a cap that is approximately
 * enforced is one nobody trusts.
 *
 * `batch` halves it — §10.11: "Batch API at 50% for the entire nightly
 * pipeline. Nothing overnight is latency-sensitive, so nothing overnight pays
 * full price."
 */
export function estimateCostMinor(input: {
  readonly task: AiTask;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly batch?: boolean;
}): number {
  const pricing = PRICING[input.task];
  const dollars =
    (input.inputTokens / 1_000_000) * pricing.inputPerMTok +
    (input.outputTokens / 1_000_000) * pricing.outputPerMTok;

  const discounted = input.batch === true ? dollars / 2 : dollars;
  return Math.ceil(discounted * 100);
}

function money(minor: number): string {
  return `$${(minor / 100).toFixed(2)}`;
}
