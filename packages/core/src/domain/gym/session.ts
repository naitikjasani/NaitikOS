/**
 * The training session and the set — §4.1's live logger, as a domain model.
 *
 * ## The structural decision this file implements
 *
 * `db/schema/body.ts` states it: **sets are entities, set values are
 * observations.** A `workout_set` row holds which exercise, which position, what
 * kind of set; the load and the reps are *also* written to the observation log
 * against `gym.set.load` and `gym.set.reps` with the set as their subject.
 *
 * That looks like storing the same number twice, and the justification is P3:
 * Skin must be able to query training volume "without knowing Gym exists", and
 * it can only do that through the metric vocabulary. A join into `workout_set`
 * would make every cross-domain question a Gym-shaped question.
 *
 * {@link planSetLog} is where the duplication is made safe: it is the *only*
 * place a set becomes both, so the two can never disagree about what happened.
 *
 * ## §4.1's design note is a hard requirement, not a nicety
 *
 *   "The logger must default to *last session's numbers* for the same exercise,
 *    so the primary interaction is confirming or nudging rather than typing.
 *    Typing a weight from scratch every set is a P1 violation."
 *
 * `progression.ts` supplies the prefill; this file makes sure that a set logged
 * by tapping "same again" carries exactly as much provenance as one typed out.
 */

import type { Result } from '@naitikos/shared';
import { err, ok } from '@naitikos/shared';

import type { DomainError, ValidationError } from '../../errors/domain-error';
import { validationError } from '../../errors/domain-error';
import { isIanaZone } from '../../temporal/zone';
import { parseInstant } from '../../temporal/instant';
import type { Decimal } from '../../units/decimal';
import { formatDecimal, parseDecimal, toQuantityString } from '../../units/decimal';
import { convertQuantity, quantity } from '../../units/quantity';
import type { ObservationInput } from '../../observations/observation';
import type { Exercise, WorkoutSetKind } from './exercise';
import { WORKOUT_SET_KINDS } from './exercise';
import type { ExerciseBest, RecordVerdict } from './records';
import { detectRecords } from './records';
import type { ExerciseLookup } from './volume';
import { sessionVolume } from './volume';

/* -------------------------------------------------------------------------
 * The metric vocabulary this module writes
 * ---------------------------------------------------------------------- */

/**
 * The metric keys Gym writes. Restated as constants rather than string literals
 * so a typo is a compile error and a rename is one edit — §9.2 rejects an
 * unregistered key on write, but at runtime, and after the operator has already
 * finished their set.
 */
export const GYM_METRICS = Object.freeze({
  setLoad: 'gym.set.load',
  setReps: 'gym.set.reps',
  setRpe: 'gym.set.rpe',
  sessionVolume: 'gym.session.volume',
  sessionDuration: 'gym.session.duration',
});

/** The subject type every set-scoped observation carries (§9.3(3)). */
export const SET_SUBJECT_TYPE = 'workout_set';
export const SESSION_SUBJECT_TYPE = 'workout_session';

/* -------------------------------------------------------------------------
 * Bounds
 * ---------------------------------------------------------------------- */

/**
 * The largest rep count a single set may record.
 *
 * Two hundred. Not a training judgement — a fat-finger guard. `1000` reps of
 * anything is a typo, and it would land in the observation log where §9.1 makes
 * it permanent and correctable only by supersession.
 */
export const MAX_REPS = 200;

/** Longest recordable rest, in seconds. Two hours; past that it is two sessions. */
export const MAX_REST_SECONDS = 7200;

/** RPE is recorded in half-points. 7.25 is a precision nobody perceives. */
export const RPE_STEP = 0.5;
export const MIN_RPE = 1;
export const MAX_RPE = 10;

/* -------------------------------------------------------------------------
 * Types
 * ---------------------------------------------------------------------- */

export type WorkoutSession = {
  readonly id: string;
  readonly programId: string | null;
  readonly programBlockId: string | null;

  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly zone: string;

  readonly title: string | null;
  readonly location: string | null;
  /** How it felt, 1–5. */
  readonly perceivedEffort: number | null;
  readonly notes: string | null;

  /** Bodyweight at session time, in kg, for relative-strength work (§4.1). */
  readonly bodyweightAtSession: string | null;
};

export type SetSide = 'left' | 'right';

export type WorkoutSet = {
  readonly id: string;
  readonly sessionId: string;
  readonly exerciseId: string;

  readonly orderIndex: number;
  readonly kind: WorkoutSetKind;

  /** External load in kilograms, as a decimal string. `null` for unloaded. */
  readonly load: string | null;
  /** The unit the operator actually typed, preserved for display (§9.2). */
  readonly loadUnit: string;
  readonly reps: number | null;
  readonly rpe: string | null;
  readonly restSeconds: number | null;

  readonly supersetGroup: number | null;
  readonly side: SetSide | null;

  readonly performedAt: string;
  readonly isPersonalRecord: boolean;
  readonly notes: string | null;
};

/** A set as submitted by the logger. */
export type SetLogInput = {
  /** Client-generated UUIDv7 (§5.7). Supplied so an offline set has its identity. */
  readonly id?: string | undefined;
  readonly exerciseId: string;
  readonly orderIndex: number;
  readonly kind?: WorkoutSetKind | undefined;
  /** Decimal string in `loadUnit`. Absent for an unloaded bodyweight set. */
  readonly load?: string | undefined;
  readonly loadUnit?: string | undefined;
  readonly reps?: number | undefined;
  readonly rpe?: string | undefined;
  readonly restSeconds?: number | undefined;
  readonly supersetGroup?: number | undefined;
  readonly side?: SetSide | undefined;
  readonly notes?: string | undefined;
};

export type SetLogContext = {
  readonly sessionId: string;
  readonly exercise: Exercise;
  readonly zone: string;
  /** When the set was performed. The logger sends the moment it was tapped. */
  readonly performedAt: string;
  readonly newId: () => string;
  /** The exercise's history, folded. `NO_HISTORY` for a first set. */
  readonly best: ExerciseBest;
  /** Session bodyweight, in kg. `null` when unknown — see `volume.ts`. */
  readonly bodyweightKg: string | null;
};

export type PlannedSet = {
  readonly set: WorkoutSet;
  /** The observation half of the write. Never disagrees with `set`. */
  readonly observations: readonly ObservationInput[];
  readonly records: RecordVerdict;
};

/* -------------------------------------------------------------------------
 * Validation helpers
 * ---------------------------------------------------------------------- */

type Issue = ValidationError['issues'][number];

function issue(path: readonly (string | number)[], message: string): Issue {
  return { path, message };
}

function invalid(issues: readonly Issue[]): DomainError {
  return validationError('gym_set_invalid', 'The set could not be recorded as submitted.', issues);
}

/**
 * Convert a submitted load to kilograms.
 *
 * The unit is part of the submission because §9.2 puts conversion "at the
 * edges": a lifter in a gym with pound plates types pounds and says so, and this
 * is the single place that becomes kilograms. Returning the *original* unit
 * alongside is what lets the UI show `225 lb` back rather than `102.058 kg`.
 */
function loadInKilograms(load: string, unit: string): Decimal | null {
  const parsed = quantity(load, unit);
  if (parsed === null) return null;
  return convertQuantity(parsed, 'kg')?.value ?? null;
}

/* -------------------------------------------------------------------------
 * The write path
 * ---------------------------------------------------------------------- */

/**
 * Turn a submitted set into the entity row and the observations it implies.
 *
 * Pure: no clock, no database, no id generation beyond the injected `newId`.
 * That is what lets the whole of §4.1's arithmetic — conversion, bounds,
 * personal records — be tested from a literal.
 */
export function planSetLog(input: SetLogInput, context: SetLogContext): Result<PlannedSet, DomainError> {
  const issues: Issue[] = [];

  if (input.exerciseId !== context.exercise.id) {
    issues.push(issue(['exerciseId'], 'The set does not belong to the exercise it was validated against.'));
  }

  if (!Number.isInteger(input.orderIndex) || input.orderIndex < 0) {
    issues.push(issue(['orderIndex'], 'Position within the session must be a whole number.'));
  }

  const kind = input.kind ?? 'working';
  if (!WORKOUT_SET_KINDS.includes(kind)) {
    issues.push(issue(['kind'], 'Unknown set kind.'));
  }

  if (!isIanaZone(context.zone)) {
    issues.push(issue(['zone'], 'A set must record the IANA time zone it was performed in.'));
  }
  if (parseInstant(context.performedAt) === null) {
    issues.push(issue(['performedAt'], 'The time the set was performed is not a valid instant.'));
  }

  /* --- Load ----------------------------------------------------------- */
  const loadUnit = input.loadUnit ?? 'kg';
  let loadKg: Decimal | null = null;

  if (input.load !== undefined && input.load !== '') {
    loadKg = loadInKilograms(input.load, loadUnit);
    if (loadKg === null) {
      issues.push(issue(['load'], `Could not read a weight in ${loadUnit}.`));
    } else if (loadKg.unscaled < 0n) {
      // Negative external load is real on an assisted machine, but it is
      // recorded as assistance rather than as a negative weight — allowing a
      // minus sign here would make every volume figure quietly signed.
      issues.push(issue(['load'], 'Weight cannot be negative. Record assistance as a separate exercise.'));
    }
  }

  /* --- Reps ----------------------------------------------------------- */
  if (input.reps !== undefined) {
    if (!Number.isInteger(input.reps) || input.reps < 0) {
      issues.push(issue(['reps'], 'Repetitions must be a whole number.'));
    } else if (input.reps > MAX_REPS) {
      issues.push(issue(['reps'], `More than ${String(MAX_REPS)} repetitions in one set is almost certainly a typo.`));
    }
  }

  /* --- RPE ------------------------------------------------------------ */
  let rpe: string | null = null;
  if (input.rpe !== undefined && input.rpe !== '') {
    const parsed = parseDecimal(input.rpe);
    const asNumber = parsed === null ? Number.NaN : Number(formatDecimal(parsed));
    if (parsed === null || Number.isNaN(asNumber)) {
      issues.push(issue(['rpe'], 'RPE must be a number.'));
    } else if (asNumber < MIN_RPE || asNumber > MAX_RPE) {
      issues.push(issue(['rpe'], `RPE runs from ${String(MIN_RPE)} to ${String(MAX_RPE)}.`));
    } else if (Math.round(asNumber / RPE_STEP) * RPE_STEP !== asNumber) {
      issues.push(issue(['rpe'], 'RPE is recorded in half-points.'));
    } else {
      rpe = toQuantityString(parsed);
    }
  }

  /* --- Rest ----------------------------------------------------------- */
  if (input.restSeconds !== undefined) {
    if (!Number.isInteger(input.restSeconds) || input.restSeconds < 0) {
      issues.push(issue(['restSeconds'], 'Rest must be a whole number of seconds.'));
    } else if (input.restSeconds > MAX_REST_SECONDS) {
      issues.push(issue(['restSeconds'], 'That rest is longer than a session. Start a new one.'));
    }
  }

  /* --- Side ----------------------------------------------------------- */
  if (input.side !== undefined && !context.exercise.isUnilateral) {
    /*
     * A side on a two-sided movement is not a harmless extra field: it would
     * make a bench press look unilateral in every per-side breakdown, and
     * `volume.ts` counts each logged set once — so "left" and "right" bench
     * press sets would double the chest volume for that session.
     */
    issues.push(issue(['side'], `${context.exercise.name} is not a single-side movement.`));
  }

  if (issues.length > 0) return err(invalid(issues));

  /* --- Build ---------------------------------------------------------- */
  const id = input.id ?? context.newId();
  const loadValue = loadKg === null ? null : toQuantityString(loadKg);
  const reps = input.reps ?? null;

  const candidate = { kind, load: loadValue, reps };
  const records = detectRecords(candidate, context.best, context.exercise, context.bodyweightKg);

  const set: WorkoutSet = {
    id,
    sessionId: context.sessionId,
    exerciseId: context.exercise.id,
    orderIndex: input.orderIndex,
    kind,
    load: loadValue,
    loadUnit,
    reps,
    rpe,
    restSeconds: input.restSeconds ?? null,
    supersetGroup: input.supersetGroup ?? null,
    side: input.side ?? null,
    performedAt: context.performedAt,
    isPersonalRecord: records.kinds.length > 0,
    notes: input.notes ?? null,
  };

  const subject = { type: SET_SUBJECT_TYPE, id } as const;
  const observations: ObservationInput[] = [];

  /*
   * The observations carry the *canonical* value — kilograms, a count — while
   * the set row keeps the unit typed. Two representations of one fact, written
   * in one place, which is the only arrangement under which they cannot drift.
   */
  if (loadValue !== null) {
    observations.push({
      metricKey: GYM_METRICS.setLoad,
      value: { kind: 'number', value: loadValue, unit: 'kg' },
      observedAt: context.performedAt,
      observedZone: context.zone,
      subject,
    });
  }

  if (reps !== null) {
    observations.push({
      metricKey: GYM_METRICS.setReps,
      value: { kind: 'integer', value: reps },
      observedAt: context.performedAt,
      observedZone: context.zone,
      subject,
    });
  }

  if (rpe !== null) {
    observations.push({
      metricKey: GYM_METRICS.setRpe,
      value: { kind: 'number', value: rpe },
      observedAt: context.performedAt,
      observedZone: context.zone,
      subject,
    });
  }

  return ok({ set, observations, records });
}

/* -------------------------------------------------------------------------
 * Closing a session
 * ---------------------------------------------------------------------- */

/**
 * Elapsed minutes from the session's start to its end.
 *
 * `gym.session.duration` describes itself honestly: "Includes rest, so it
 * measures time in the gym rather than time under load." Whole minutes, because
 * a session timed to the second implies a precision that a lifter who forgot to
 * hit stop does not have.
 *
 * @returns `null` if either instant is unreadable or the end precedes the start.
 */
export function sessionDurationMinutes(startedAt: string, endedAt: string): number | null {
  const start = parseInstant(startedAt);
  const end = parseInstant(endedAt);
  if (start === null || end === null) return null;

  const millis = end.getTime() - start.getTime();
  if (millis < 0) return null;
  return Math.round(millis / 60_000);
}

export type SessionCloseContext = {
  readonly endedAt: string;
  readonly exercises: ExerciseLookup;
};

export type SessionClosePlan = {
  readonly session: WorkoutSession;
  /** Derived observations: session volume and duration. */
  readonly observations: readonly ObservationInput[];
  readonly volume: ReturnType<typeof sessionVolume>;
  readonly durationMinutes: number | null;
  readonly exerciseCount: number;
};

/**
 * Close a session, deriving the two session-level metrics.
 *
 * §9.2 says `gym.session.volume` is "derived by the nightly job, never entered".
 * It is derived *here*, at the moment the session ends, and the reason is P1:
 * the operator wants the number on the screen they are looking at, not tomorrow.
 * The nightly job's role becomes recomputation after a late-arriving offline set
 * — which is the case that actually needs a job, because it happens after the
 * screen is gone.
 *
 * Both observations are written with the *session end* as their instant, not the
 * session start. A session spanning midnight belongs to the day it finished on,
 * which is also the day the operator will look for it.
 */
export function planSessionClose(
  session: WorkoutSession,
  sets: readonly WorkoutSet[],
  context: SessionCloseContext,
): Result<SessionClosePlan, DomainError> {
  const issues: Issue[] = [];

  if (parseInstant(context.endedAt) === null) {
    issues.push(issue(['endedAt'], 'The end time is not a valid instant.'));
  }
  if (!isIanaZone(session.zone)) {
    issues.push(issue(['zone'], 'The session has no valid time zone.'));
  }

  const durationMinutes =
    issues.length > 0 ? null : sessionDurationMinutes(session.startedAt, context.endedAt);
  if (issues.length === 0 && durationMinutes === null) {
    issues.push(issue(['endedAt'], 'A session cannot end before it started.'));
  }

  if (issues.length > 0) return err(invalid(issues));

  const volume = sessionVolume(sets, context.exercises, session.bodyweightAtSession);
  const closed: WorkoutSession = { ...session, endedAt: context.endedAt };

  const subject = { type: SESSION_SUBJECT_TYPE, id: session.id } as const;
  const observations: ObservationInput[] = [];

  /*
   * A session with nothing countable writes no volume observation.
   *
   * Zero and absent are different facts: zero says "trained, moved nothing",
   * absent says "there is no volume figure for this session". A session of
   * unresolvable bodyweight sets is the second, and recording it as the first
   * would drag every weekly average down with a number that was never measured.
   */
  if (volume.countedSets > 0) {
    observations.push({
      metricKey: GYM_METRICS.sessionVolume,
      value: { kind: 'number', value: formatDecimal(volume.total), unit: 'kg' },
      observedAt: context.endedAt,
      observedZone: session.zone,
      subject,
      context: {
        countedSets: volume.countedSets,
        excluded: volume.excluded,
        secondaryMuscleShare: '0.5',
      },
    });
  }

  if (durationMinutes !== null) {
    observations.push({
      metricKey: GYM_METRICS.sessionDuration,
      value: { kind: 'number', value: String(durationMinutes), unit: 'minutes' },
      observedAt: context.endedAt,
      observedZone: session.zone,
      subject,
    });
  }

  return ok({
    session: closed,
    observations,
    volume,
    durationMinutes,
    exerciseCount: new Set(sets.map((set) => set.exerciseId)).size,
  });
}
