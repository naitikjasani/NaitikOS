/**
 * The conditions register — and the one place in the system where §9.5's two
 * clocks are the entire point rather than an implementation detail.
 *
 * §4.4:
 *
 *   "Learning in October that a condition began in March must not rewrite
 *    history — the March onset is recorded, and the fact that you did not know
 *    until October is also recorded. Any other design produces a record that
 *    quietly lies to a clinician."
 *
 * So a condition has `validFrom` (when it began) and `recordedFrom` (when this
 * record started being believed), and this module's job is to make the
 * difference legible rather than to smooth it away. {@link describeOnset} is
 * that sentence, and it is the only sentence on the conditions screen that
 * users tend to read twice.
 *
 * ## A refuted diagnosis is not a deleted one
 *
 * §9.4 keeps `refuted` as a status. A diagnosis that turned out to be wrong is
 * clinically relevant history — it was believed, it was acted on, and something
 * was prescribed because of it. Deleting it loses the reason a medication
 * appears in the register.
 *
 * ## No transition matrix
 *
 * It was written and then removed. Real clinical histories go active →
 * resolved → active without apology (a condition recurs), suspected → refuted →
 * active (the second opinion was right), and remission → resolved years later.
 * Every ordering a matrix would forbid is one a real record contains, so the
 * only rule left is the one below: a status change is a new belief, not an
 * edit.
 */

import type { Result } from '@naitikos/shared';
import { err, ok } from '@naitikos/shared';

import type { DomainError } from '../../errors/domain-error';
import { validationError } from '../../errors/domain-error';
import { parseInstant } from '../../temporal/instant';

/** Mirrors the `condition_status` pgEnum exactly. */
export const CONDITION_STATUSES = Object.freeze([
  'suspected',
  'active',
  'remission',
  'resolved',
  'refuted',
] as const);

export type ConditionStatus = (typeof CONDITION_STATUSES)[number];

export const CONDITION_STATUS_LABELS: Readonly<Record<ConditionStatus, string>> = Object.freeze({
  suspected: 'Suspected',
  active: 'Active',
  remission: 'In remission',
  resolved: 'Resolved',
  refuted: 'Refuted',
});

/**
 * How each status reads in a list, for someone who is not a clinician.
 *
 * `refuted` is the one that needs the explanation: without it, a person
 * scanning their own register wonders why a diagnosis they were told was wrong
 * is still on the page.
 */
export const CONDITION_STATUS_NOTES: Readonly<Record<ConditionStatus, string>> = Object.freeze({
  suspected: 'Raised, not confirmed.',
  active: 'Currently the case.',
  remission: 'Not currently active, and not considered gone.',
  resolved: 'Over.',
  refuted: 'Recorded, then withdrawn — this turned out not to be the case. Kept because it was believed and acted on.',
});

export type Condition = {
  readonly id: string;
  readonly medicalEventId: string;
  readonly name: string;
  readonly code: string | null;
  readonly codeSystem: string | null;
  readonly status: ConditionStatus;
  readonly severity: 'mild' | 'moderate' | 'severe' | null;
  readonly diagnosedBy: string | null;
  readonly resolutionNote: string | null;
  /** §9.5's validity axis: when the condition began. */
  readonly validFrom: string;
  readonly validTo: string | null;
  /** §9.5's transaction axis: when this record started being believed. */
  readonly recordedFrom: string;
  readonly recordedTo: string | null;
};

export type ConditionInput = {
  readonly id: string;
  readonly name: string;
  readonly code?: string | null;
  readonly codeSystem?: string | null;
  readonly status: string;
  readonly severity?: 'mild' | 'moderate' | 'severe' | null;
  readonly diagnosedBy?: string | null;
  /** When it began — not when you are typing this. */
  readonly onsetAt: string;
  readonly zone: string;
  readonly note?: string | null;
};

export function isConditionStatus(value: string): value is ConditionStatus {
  return (CONDITION_STATUSES as readonly string[]).includes(value);
}

export function validateCondition(input: ConditionInput): Result<ConditionInput, DomainError> {
  if (input.name.trim() === '') {
    return err(validationError('condition_name_empty', 'A condition needs a name.'));
  }
  if (!isConditionStatus(input.status)) {
    return err(validationError('condition_status_unknown', `Unknown condition status: ${input.status}.`));
  }
  if (parseInstant(input.onsetAt) === null) {
    return err(validationError('condition_onset_invalid', 'onsetAt must be an ISO-8601 instant.'));
  }
  return ok(input);
}

/* -------------------------------------------------------------------------
 * Bitemporal reads
 * ---------------------------------------------------------------------- */

/**
 * The register as it was *believed* at a moment — §9.5's reconstruction query.
 *
 * This is what makes "what did my file say when I saw the psychiatrist in
 * March?" answerable, and it is a different question from "what was true in
 * March", which is {@link activeOn}. Conflating them is the failure §4.4 calls a
 * record that quietly lies.
 */
export function believedAt(conditions: readonly Condition[], asOf: string): readonly Condition[] {
  return conditions.filter(
    (condition) => condition.recordedFrom <= asOf && (condition.recordedTo === null || asOf < condition.recordedTo),
  );
}

/** The register as it was *true* on a day, according to what is believed now. */
export function activeOn(conditions: readonly Condition[], asOf: string): readonly Condition[] {
  return conditions.filter(
    (condition) =>
      condition.recordedTo === null &&
      condition.status !== 'refuted' &&
      condition.validFrom <= asOf &&
      (condition.validTo === null || asOf < condition.validTo),
  );
}

/** Currently believed and currently the case. The default list. */
export function currentConditions(conditions: readonly Condition[], nowIso: string): readonly Condition[] {
  return activeOn(conditions, nowIso).filter(
    (condition) => condition.status === 'active' || condition.status === 'suspected' || condition.status === 'remission',
  );
}

/* -------------------------------------------------------------------------
 * The sentence
 * ---------------------------------------------------------------------- */

/**
 * "Began March 2026. Recorded October 2026."
 *
 * Both halves, always, and the second is omitted only when the two fall in the
 * same month — because "began October 2026, recorded October 2026" is noise,
 * and a seven-month gap between them is a fact about how a diagnosis actually
 * arrived. Rendering only the onset would present a reconstructed history as a
 * contemporaneous one.
 */
export function describeOnset(condition: Condition): string {
  const began = monthYear(condition.validFrom);
  const recorded = monthYear(condition.recordedFrom);
  if (began === null) return recorded === null ? 'Onset not recorded.' : `Recorded ${recorded}.`;
  if (recorded === null || recorded === began) return `Began ${began}.`;
  return `Began ${began}. Recorded ${recorded}.`;
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/**
 * `March 2026` from an ISO instant, in UTC.
 *
 * UTC rather than the operator's zone, deliberately. This is a month label on a
 * clinical onset; a diagnosis does not belong to a timezone, and resolving it
 * locally would make the same record read as February in one place and March in
 * another.
 */
function monthYear(iso: string): string | null {
  const parsed = parseInstant(iso);
  if (parsed === null) return null;
  const month = MONTHS[parsed.getUTCMonth()];
  return month === undefined ? null : `${month} ${String(parsed.getUTCFullYear())}`;
}
