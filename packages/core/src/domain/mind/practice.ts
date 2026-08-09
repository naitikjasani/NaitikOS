/**
 * Practices — meditation, breathwork, grounding (§4.7).
 *
 * The interesting field is the pair `stateBefore` / `stateAfter`. The schema
 * comment calls it "the only honest measure of whether it helped", and that is
 * the whole design: a duration log tells you that twelve minutes passed, which
 * is not the question. {@link practiceDelta} is the question, and it returns
 * `null` rather than zero when either end is missing — because "no change" and
 * "did not answer" are different facts and averaging them together would make a
 * practice look neutral whenever the operator was too flat to rate it.
 *
 * Duration is written to the observation log as `mind.practice.duration` so
 * cross-domain work can ask "did the weeks with more practice differ" through
 * the metric vocabulary (P3), without knowing this table exists.
 */

import type { Result } from '@naitikos/shared';
import { err, ok } from '@naitikos/shared';

import type { DomainError } from '../../errors/domain-error';
import { validationError } from '../../errors/domain-error';
import { parseInstant } from '../../temporal/instant';
import { isIanaZone } from '../../temporal/zone';
import type { ObservationInput } from '../../observations/observation';

/** Mirrors the `practice_kind` enum. Adding one is a migration, deliberately. */
export const PRACTICE_KINDS = Object.freeze([
  'meditation',
  'breathwork',
  'grounding',
  'journaling',
  'other',
] as const);

export type PracticeKind = (typeof PRACTICE_KINDS)[number];

export const PRACTICE_KIND_LABELS: Readonly<Record<PracticeKind, string>> = Object.freeze({
  meditation: 'Meditation',
  breathwork: 'Breathwork',
  grounding: 'Grounding',
  journaling: 'Journaling',
  other: 'Other',
});

export const PRACTICE_METRICS = Object.freeze({ duration: 'mind.practice.duration' });
export const PRACTICE_SUBJECT_TYPE = 'practice_session';

/** Four hours. Past that it is a retreat, not a session. */
export const MAX_PRACTICE_MINUTES = 240;

export type PracticeSession = {
  readonly id: string;
  readonly kind: PracticeKind;
  readonly startedAt: string;
  readonly zone: string;
  readonly durationMinutes: number | null;
  readonly method: string | null;
  readonly stateBefore: number | null;
  readonly stateAfter: number | null;
  readonly note: string | null;
};

export type PracticeInput = {
  readonly id: string;
  readonly kind: string;
  readonly startedAt: string;
  readonly zone: string;
  readonly durationMinutes?: number | null;
  readonly method?: string | null;
  readonly stateBefore?: number | null;
  readonly stateAfter?: number | null;
  readonly note?: string | null;
};

export type PlannedPractice = {
  readonly practice: PracticeSession;
  readonly observations: readonly ObservationInput[];
};

export function isPracticeKind(value: string): value is PracticeKind {
  return (PRACTICE_KINDS as readonly string[]).includes(value);
}

/**
 * State after minus state before, or `null` when either is missing.
 *
 * Positive means the operator rated themselves better afterwards. That is all
 * it means — it is their own before-and-after judgement, taken minutes apart,
 * on a five-point scale, and the system does not get to call it an effect.
 */
export function practiceDelta(session: Pick<PracticeSession, 'stateBefore' | 'stateAfter'>): number | null {
  if (session.stateBefore === null || session.stateAfter === null) return null;
  return session.stateAfter - session.stateBefore;
}

export function planPractice(input: PracticeInput): Result<PlannedPractice, DomainError> {
  if (!isPracticeKind(input.kind)) {
    return err(validationError('practice_kind_unknown', `Unknown practice kind: ${input.kind}.`));
  }
  if (parseInstant(input.startedAt) === null) {
    return err(validationError('practice_started_at_invalid', 'startedAt must be an ISO-8601 instant.'));
  }
  if (!isIanaZone(input.zone)) {
    return err(validationError('practice_zone_invalid', 'zone must be an IANA zone name (§5.3).'));
  }

  const duration = input.durationMinutes ?? null;
  if (duration !== null && (!Number.isFinite(duration) || duration <= 0 || duration > MAX_PRACTICE_MINUTES)) {
    return err(
      validationError(
        'practice_duration_range',
        `durationMinutes must be greater than zero and at most ${String(MAX_PRACTICE_MINUTES)}.`,
      ),
    );
  }

  for (const [field, value] of [
    ['stateBefore', input.stateBefore ?? null],
    ['stateAfter', input.stateAfter ?? null],
  ] as const) {
    if (value !== null && (!Number.isInteger(value) || value < 1 || value > 5)) {
      return err(validationError('practice_state_range', `${field} must be an integer from 1 to 5.`));
    }
  }

  const practice: PracticeSession = {
    id: input.id,
    kind: input.kind,
    startedAt: input.startedAt,
    zone: input.zone,
    durationMinutes: duration,
    method: trimToNull(input.method),
    stateBefore: input.stateBefore ?? null,
    stateAfter: input.stateAfter ?? null,
    note: trimToNull(input.note),
  };

  const observations: ObservationInput[] =
    duration === null
      ? []
      : [
          {
            metricKey: PRACTICE_METRICS.duration,
            value: { kind: 'number', value: duration.toString(), unit: 'minutes' },
            observedAt: input.startedAt,
            observedZone: input.zone,
            subject: { type: PRACTICE_SUBJECT_TYPE, id: input.id },
            context: { kind: input.kind },
          },
        ];

  return ok({ practice, observations });
}

function trimToNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
