/**
 * The Gym service — the orchestration behind logging a session.
 *
 * §5.2: "route handlers are transport, not logic. A handler parses,
 * authenticates, delegates to a domain service, and serialises." This is that
 * service, and like `capture.ts` it decides almost nothing: `core` validates,
 * `db` persists, and this holds the registry, the exercise, the history and the
 * clock together for long enough to get a set written.
 *
 * ## The one decision this file does make
 *
 * **Where a session's bodyweight comes from.** `volume.ts` refuses to guess it,
 * so something has to resolve it, and the choice is consequential: a pull-up
 * session's entire volume figure depends on it.
 *
 * The rule is *the most recent reading strictly before the session started*.
 * Not the latest reading — that would attribute a weigh-in taken after the
 * session (or six weeks later, on a backfilled session) to work done at a
 * different bodyweight. Not a default — a made-up 70 kg would make every
 * bodyweight movement's volume fiction. If there is nothing before the session,
 * it stays `null`, `volume.ts` excludes those sets, and the UI says how many.
 *
 * The client may override it, and does when it can: a phone that knows this
 * morning's weight sends it, so a basement session with no signal still has the
 * number.
 */

import 'server-only';

import type { Result } from '@naitikos/shared';
import { err, ok, uuidV7 } from '@naitikos/shared';
import type {
  DomainError,
  Exercise,
  HistoricalSet,
  Hlc,
  MetricRegistry,
  ProgressionPoint,
  RecordVerdict,
  SetLogInput,
  WorkoutSession,
  WorkoutSet,
} from '@naitikos/core';
import {
  bestFrom,
  formatDecimal,
  hlcReceive,
  initialHlcState,
  isoFromMillis,
  notFoundError,
  planSessionClose,
  planSetLog,
  prefillFor,
  progressionBySession,
  sessionVolume,
  setsByMuscle,
  systemClock,
  volumeByMuscle,
  zonedDayBounds,
} from '@naitikos/core';
import type { Database } from '@naitikos/db';
import {
  createExerciseRepository,
  createMetricRepository,
  createWorkoutRepository,
} from '@naitikos/db';

import type { OfflineEnvelope } from './capture';

/** Rebuild the writing device's clock for this request. See `capture.ts`. */
function clockFor(envelope: OfflineEnvelope, physicalMillis: number) {
  const seed = initialHlcState(envelope.deviceId, physicalMillis);
  return envelope.clientHlc === undefined
    ? { state: seed, anomalies: [] as readonly string[] }
    : hlcReceive(seed, envelope.clientHlc as Hlc, physicalMillis);
}

async function registryFor(db: Database): Promise<Result<MetricRegistry, DomainError>> {
  return createMetricRepository(db).registry();
}

/* -------------------------------------------------------------------------
 * Starting a session
 * ---------------------------------------------------------------------- */

export type StartSessionInput = {
  readonly id: string;
  readonly startedAt: string;
  readonly zone: string;
  readonly programId?: string | null;
  readonly programBlockId?: string | null;
  readonly title?: string | null;
  readonly location?: string | null;
  readonly bodyweightKg?: string | null;
};

export async function startWorkoutSession(
  db: Database,
  input: StartSessionInput,
): Promise<Result<WorkoutSession, DomainError>> {
  const workouts = createWorkoutRepository(db);

  /*
   * Resolved once, at start, and stored on the session row.
   *
   * Not looked up per set: a set logged forty minutes in would otherwise
   * resolve against a *different* observation if the operator weighed
   * themselves mid-session, and two sets of the same pull-ups would carry
   * different loads.
   */
  let bodyweight = input.bodyweightKg ?? null;
  if (bodyweight === null) {
    const looked = await workouts.bodyweightAt(input.startedAt);
    if (!looked.ok) return looked;
    bodyweight = looked.value;
  }

  return workouts.startSession({
    id: input.id,
    startedAt: input.startedAt,
    zone: input.zone,
    programId: input.programId ?? null,
    programBlockId: input.programBlockId ?? null,
    title: input.title ?? null,
    location: input.location ?? null,
    bodyweightAtSession: bodyweight,
  });
}

/* -------------------------------------------------------------------------
 * Logging a set
 * ---------------------------------------------------------------------- */

export type LogSetResult = {
  readonly set: WorkoutSet;
  readonly exercise: Exercise;
  /** Which records this set broke, for the badge and the timeline. */
  readonly records: RecordVerdict;
  readonly hlc: string | null;
  /** False when this was a replay. The UI must not celebrate a PR twice. */
  readonly written: boolean;
  readonly anomalies: readonly string[];
};

export async function logWorkoutSet(
  db: Database,
  input: {
    readonly sessionId: string;
    readonly performedAt: string;
    readonly zone: string;
    readonly set: SetLogInput;
  },
  envelope: OfflineEnvelope,
): Promise<Result<LogSetResult, DomainError>> {
  const registry = await registryFor(db);
  if (!registry.ok) return registry;

  const workouts = createWorkoutRepository(db);

  const session = await workouts.sessionById(input.sessionId);
  if (!session.ok) return session;
  if (session.value === null) {
    return err(notFoundError('workout_session', input.sessionId, 'workout_session_missing'));
  }

  const exercise = await createExerciseRepository(db).byId(input.set.exerciseId);
  if (!exercise.ok) return exercise;
  if (exercise.value === null) {
    return err(notFoundError('exercise', input.set.exerciseId, 'exercise_not_registered'));
  }

  /*
   * The history is read on every set, and that is deliberate.
   *
   * Personal-record detection has to see everything logged before this moment,
   * including sets from *this* session — a third set that beats the second is a
   * record, and a cached history taken at session start would miss it. The
   * `(exercise_id, performed_at DESC)` index makes it one indexed scan.
   */
  const history = await workouts.historyFor(input.set.exerciseId);
  if (!history.ok) return history;

  const physicalMillis = systemClock.nowMillis();
  const clock = clockFor(envelope, physicalMillis);

  const planned = planSetLog(input.set, {
    sessionId: input.sessionId,
    exercise: exercise.value,
    zone: input.zone,
    performedAt: input.performedAt,
    newId: () => uuidV7(physicalMillis),
    best: bestFrom(history.value, exercise.value, session.value.bodyweightAtSession),
    bodyweightKg: session.value.bodyweightAtSession,
  });
  if (!planned.ok) return planned;

  const written = await workouts.logSet(planned.value, {
    registry: registry.value,
    hlcState: clock.state,
    recordedAt: isoFromMillis(physicalMillis),
    physicalMillis,
    newId: () => uuidV7(physicalMillis),
  });
  if (!written.ok) return written;

  return ok({
    set: written.value.set,
    exercise: exercise.value,
    records: planned.value.records,
    hlc: written.value.hlc,
    written: written.value.written,
    anomalies: clock.anomalies,
  });
}

/* -------------------------------------------------------------------------
 * Closing a session
 * ---------------------------------------------------------------------- */

export type CloseSessionResult = {
  readonly session: WorkoutSession;
  readonly volume: ReturnType<typeof sessionVolume>;
  readonly durationMinutes: number | null;
  readonly setCount: number;
  readonly exerciseCount: number;
  readonly hlc: string | null;
  /** False when the session was already closed. See `closeSession`. */
  readonly written: boolean;
};

export async function closeWorkoutSession(
  db: Database,
  input: {
    readonly sessionId: string;
    readonly endedAt: string;
    readonly perceivedEffort?: number | null;
    readonly notes?: string | null;
  },
  envelope: OfflineEnvelope,
): Promise<Result<CloseSessionResult, DomainError>> {
  const registry = await registryFor(db);
  if (!registry.ok) return registry;

  const workouts = createWorkoutRepository(db);

  const session = await workouts.sessionById(input.sessionId);
  if (!session.ok) return session;
  if (session.value === null) {
    return err(notFoundError('workout_session', input.sessionId, 'workout_session_missing'));
  }

  const sets = await workouts.setsForSession(input.sessionId);
  if (!sets.ok) return sets;

  const exercises = await createExerciseRepository(db).byIds(sets.value.map((set) => set.exerciseId));
  if (!exercises.ok) return exercises;
  const lookup = (id: string): Exercise | null => exercises.value.get(id) ?? null;

  const plan = planSessionClose(
    {
      ...session.value,
      perceivedEffort: input.perceivedEffort ?? session.value.perceivedEffort,
      notes: input.notes ?? session.value.notes,
    },
    sets.value,
    { endedAt: input.endedAt, exercises: lookup },
  );
  if (!plan.ok) return plan;

  const physicalMillis = systemClock.nowMillis();
  const clock = clockFor(envelope, physicalMillis);

  const closed = await workouts.closeSession(plan.value, {
    registry: registry.value,
    hlcState: clock.state,
    recordedAt: isoFromMillis(physicalMillis),
    physicalMillis,
    newId: () => uuidV7(physicalMillis),
  });
  if (!closed.ok) return closed;

  return ok({
    session: closed.value.session,
    volume: plan.value.volume,
    durationMinutes: plan.value.durationMinutes,
    setCount: sets.value.length,
    exerciseCount: plan.value.exerciseCount,
    hlc: closed.value.hlc,
    written: closed.value.written,
  });
}

/* -------------------------------------------------------------------------
 * Reads
 * ---------------------------------------------------------------------- */

export type SessionView = {
  readonly session: WorkoutSession;
  readonly sets: readonly WorkoutSet[];
  /** Only the exercises this session used, so the client needs no second call. */
  readonly exercises: readonly Exercise[];
  /** Live volume, so the header can show it without the session being closed. */
  readonly volume: ReturnType<typeof sessionVolume>;
};

/** Everything the live logger needs for one session, in one round trip. */
export async function loadSession(
  db: Database,
  sessionId: string,
): Promise<Result<SessionView, DomainError>> {
  const workouts = createWorkoutRepository(db);

  const session = await workouts.sessionById(sessionId);
  if (!session.ok) return session;
  if (session.value === null) {
    return err(notFoundError('workout_session', sessionId, 'workout_session_missing'));
  }

  const sets = await workouts.setsForSession(sessionId);
  if (!sets.ok) return sets;

  const exercises = await createExerciseRepository(db).byIds(sets.value.map((set) => set.exerciseId));
  if (!exercises.ok) return exercises;

  return ok({
    session: session.value,
    sets: sets.value,
    exercises: [...exercises.value.values()],
    volume: sessionVolume(
      sets.value,
      (id) => exercises.value.get(id) ?? null,
      session.value.bodyweightAtSession,
    ),
  });
}

export type ProgressionView = {
  readonly exercise: Exercise;
  readonly points: readonly ProgressionPoint[];
  /** What the logger should offer for the next set of this exercise. */
  readonly prefill: ReturnType<typeof prefillFor>;
  readonly history: readonly HistoricalSet[];
};

export async function loadProgression(
  db: Database,
  exerciseId: string,
  options: { readonly excludeSessionId?: string; readonly setIndex?: number } = {},
): Promise<Result<ProgressionView, DomainError>> {
  const exercise = await createExerciseRepository(db).byId(exerciseId);
  if (!exercise.ok) return exercise;
  if (exercise.value === null) {
    return err(notFoundError('exercise', exerciseId, 'exercise_not_registered'));
  }

  const history = await createWorkoutRepository(db).historyFor(exerciseId);
  if (!history.ok) return history;

  return ok({
    exercise: exercise.value,
    points: progressionBySession(history.value, exercise.value),
    prefill: prefillFor(
      history.value,
      exerciseId,
      options.setIndex ?? 0,
      'working',
      options.excludeSessionId === undefined ? {} : { excludeSessionId: options.excludeSessionId },
    ),
    history: history.value,
  });
}

export type VolumeView = {
  readonly fromDayKey: string;
  readonly toDayKey: string;
  /** Attributed volume per muscle, in kg. Exceeds the total — see `volume.ts`. */
  readonly byMuscle: readonly { readonly muscle: string; readonly volume: string; readonly sets: number }[];
  readonly total: ReturnType<typeof sessionVolume>;
  readonly sessionDays: readonly string[];
};

/**
 * §4.1's "volume/intensity/frequency analysis by muscle group".
 *
 * The window is a *calendar* range in the operator's zone, resolved here rather
 * than by the caller — §5.3 again, and the difference between "this month" and
 * "the last 720 hours" is a day at each end.
 */
export async function loadVolume(
  db: Database,
  fromDayKey: string,
  toDayKey: string,
  zone: string,
): Promise<Result<VolumeView, DomainError>> {
  const start = zonedDayBounds(fromDayKey, zone);
  const end = zonedDayBounds(toDayKey, zone);
  if (start === null || end === null) {
    return err(notFoundError('window', `${fromDayKey}..${toDayKey}`, 'volume_window_unresolvable'));
  }

  const workouts = createWorkoutRepository(db);
  const sets = await workouts.setsBetween(start.start, end.end);
  if (!sets.ok) return sets;

  const exercises = await createExerciseRepository(db).byIds(sets.value.map((set) => set.exerciseId));
  if (!exercises.ok) return exercises;
  const lookup = (id: string): Exercise | null => exercises.value.get(id) ?? null;

  const days = await workouts.sessionDays(start.start, end.end);
  if (!days.ok) return days;

  /*
   * Each set is resolved against *its own* session's bodyweight, which is why
   * `setsBetween` carries it per row. A single bodyweight for the window would
   * be wrong for every bodyweight movement in a bulking month — the exact case
   * this operator is in.
   */
  const attributed = volumeByMuscle(
    sets.value.map((set) => ({ ...set, exerciseId: set.exerciseId })),
    lookup,
    null,
  );
  const perSetVolume = new Map<string, string>();
  for (const [muscle, value] of attributed) {
    perSetVolume.set(muscle, formatDecimal(value, { trim: true }));
  }

  const setCounts = setsByMuscle(sets.value, lookup);

  return ok({
    fromDayKey,
    toDayKey,
    byMuscle: [...perSetVolume.entries()]
      .map(([muscle, volume]) => ({ muscle, volume, sets: setCounts.get(muscle as never) ?? 0 }))
      .sort((a, b) => Number(b.volume) - Number(a.volume)),
    total: sessionVolume(sets.value, lookup, null),
    sessionDays: days.value,
  });
}
