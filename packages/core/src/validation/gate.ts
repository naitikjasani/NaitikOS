/**
 * The V1 gate — §12's one hard decision point.
 *
 *   "**Gate: Compounding Days ≥ 25 of 30 by 29 September.** If the gate is
 *    missed, October is spent on capture friction, not on V2. This gate is real,
 *    and the discipline to honour it is the difference between a system that
 *    lasts and a graveyard of half-built modules."
 *
 * ## Why this is a function rather than a note in a document
 *
 * Because on 29 September the operator will also be the person deciding whether
 * to honour it, and that is the worst possible combination of roles. A gate that
 * has to be *evaluated by hand* on the day is a gate that gets evaluated
 * generously.
 *
 * So it computes, it states the verdict in one sentence, and it names what
 * October is for. It cannot be argued with, which is the entire point.
 *
 * ## It reports progress before the date, not just the verdict on it
 *
 * A gate that says nothing until the last day is one that arrives as a surprise.
 * {@link evaluateGate} runs on any day and reports where the count stands, how
 * many days remain, and — the useful part — **whether the gate is still
 * reachable**. Learning on 20 September that it is arithmetically out of reach
 * is worth more than learning on the 29th that it was missed.
 */

import { dayKeyIndex, shiftDayKey } from '../temporal/instant';

/**
 * §12's threshold, and a discrepancy in §12 worth naming.
 *
 * The gate is stated as "**Compounding Days ≥ 25 of 30** by 29 September", and
 * the phase is dated "**30 August to 29 September**". Those two disagree: 30
 * August to 29 September inclusive is **thirty-one** days, not thirty.
 *
 * Resolved in favour of the dates, because the threshold is what the gate
 * actually turns on and 25 is unambiguous. {@link evaluateGate} therefore
 * derives `windowDays` from the start and end keys rather than from
 * {@link GATE_WINDOW_DAYS}, and the extra day makes the gate very slightly
 * easier — which is the right direction to err when the alternative is the
 * operator arguing on the day about which reading was meant.
 *
 * {@link GATE_WINDOW_DAYS} remains as the default for callers with no dates.
 */
export const GATE_WINDOW_DAYS = 30;
export const GATE_REQUIRED_DAYS = 25;

/** §12's dates for the V1 validation window. Inclusive of both ends. */
export const VALIDATION_START_DAY = '2026-08-30';
export const VALIDATION_END_DAY = '2026-09-29';

export type GateVerdict = 'passed' | 'missed' | 'on_track' | 'at_risk' | 'unreachable';

export type GateEvaluation = {
  readonly verdict: GateVerdict;
  /** Closes completed within the window so far. */
  readonly closes: number;
  readonly required: number;
  readonly windowDays: number;
  /** Days of the window still ahead, including today. */
  readonly daysRemaining: number;
  /** Closes still needed. Zero once the threshold is met. */
  readonly shortfall: number;
  /**
   * The most days that could still be missed and the gate still pass.
   *
   * Negative means it cannot. This is the number that makes the gate *legible*
   * mid-window rather than only at the end.
   */
  readonly slack: number;
  readonly sentence: string;
  /** What October is for, per §12. Present on every verdict, not only failure. */
  readonly consequence: string;
};

const PASS_CONSEQUENCE = 'V2 begins in October: Health core, labs, documents, and the first clinical loop.';
const FAIL_CONSEQUENCE =
  'October is spent on capture friction, not on V2. §12 is explicit that honouring this is what separates a system that lasts from a graveyard of half-built modules.';

/**
 * Evaluate the gate on a given day.
 *
 * `closes` is the count of days with a completed Daily Close inside the
 * window — the same figure §1.5 calls Compounding Days, over thirty days rather
 * than ninety. The caller supplies it because counting it needs the database.
 */
export function evaluateGate(options: {
  readonly todayDayKey: string;
  readonly closes: number;
  readonly startDayKey?: string;
  readonly endDayKey?: string;
  readonly required?: number;
}): GateEvaluation {
  const startDayKey = options.startDayKey ?? VALIDATION_START_DAY;
  const endDayKey = options.endDayKey ?? VALIDATION_END_DAY;
  const required = options.required ?? GATE_REQUIRED_DAYS;

  const today = dayKeyIndex(options.todayDayKey);
  const start = dayKeyIndex(startDayKey);
  const end = dayKeyIndex(endDayKey);

  const windowDays = start === null || end === null ? GATE_WINDOW_DAYS : end - start + 1;
  const closes = Math.max(0, Math.floor(options.closes));

  /*
   * An unresolvable day key is treated as "before the window".
   *
   * Not as an error: this runs on a dashboard, and a malformed key must not
   * take the whole screen down. Reporting `on_track` with zero days elapsed is
   * the conservative answer.
   */
  if (today === null || start === null || end === null) {
    return {
      verdict: 'on_track',
      closes,
      required,
      windowDays,
      daysRemaining: windowDays,
      shortfall: Math.max(0, required - closes),
      slack: windowDays - required,
      sentence: 'The validation window has not started.',
      consequence: PASS_CONSEQUENCE,
    };
  }

  const daysElapsed = Math.min(windowDays, Math.max(0, today - start + 1));
  const daysRemaining = Math.max(0, windowDays - daysElapsed);
  const shortfall = Math.max(0, required - closes);
  const slack = closes + daysRemaining - required;

  if (today > end) {
    const passed = closes >= required;
    return {
      verdict: passed ? 'passed' : 'missed',
      closes,
      required,
      windowDays,
      daysRemaining: 0,
      shortfall,
      slack,
      sentence: `${String(closes)} of ${String(windowDays)} days closed. The gate asked for ${String(required)}.`,
      consequence: passed ? PASS_CONSEQUENCE : FAIL_CONSEQUENCE,
    };
  }

  if (closes >= required) {
    return {
      verdict: 'passed',
      closes,
      required,
      windowDays,
      daysRemaining,
      shortfall: 0,
      slack,
      sentence: `${String(closes)} of ${String(required)} needed, with ${String(daysRemaining)} days still to go. The gate is met.`,
      consequence: PASS_CONSEQUENCE,
    };
  }

  if (slack < 0) {
    return {
      verdict: 'unreachable',
      closes,
      required,
      windowDays,
      daysRemaining,
      shortfall,
      slack,
      sentence: `${String(closes)} closed with ${String(daysRemaining)} days left, and ${String(shortfall)} still needed. The gate can no longer be met.`,
      consequence: FAIL_CONSEQUENCE,
    };
  }

  /*
   * `at_risk` when there is no room left to miss a day.
   *
   * Deliberately not a warning, a colour, or a nudge. §14.1's second finding
   * forbids guilt copy about gaps, and this figure is shown on a developer
   * dashboard rather than on `/today` for exactly that reason: it is a fact
   * about the *project*, and putting it in front of the operator every morning
   * would turn the North Star into the streak §1.5 refused to build.
   */
  return {
    verdict: slack === 0 ? 'at_risk' : 'on_track',
    closes,
    required,
    windowDays,
    daysRemaining,
    shortfall,
    slack,
    sentence: `${String(closes)} closed, ${String(shortfall)} needed, ${String(daysRemaining)} days remaining. ${
      slack === 0 ? 'Every remaining day is now required.' : `${String(slack)} days of margin.`
    }`,
    consequence: PASS_CONSEQUENCE,
  };
}

/** The window's day keys, oldest first. For the adherence grid on the dashboard. */
export function gateWindowDays(endDayKey: string = VALIDATION_END_DAY, windowDays = GATE_WINDOW_DAYS): readonly string[] {
  if (dayKeyIndex(endDayKey) === null) return [];
  const keys: string[] = [];
  for (let offset = windowDays - 1; offset >= 0; offset -= 1) {
    const key = shiftDayKey(endDayKey, -offset);
    if (key !== null) keys.push(key);
  }
  return keys;
}
