'use client';

/**
 * The gym feature's client-side service (§7.3: "services — API calls").
 *
 * Same asymmetry as `daily-close/services/closeClient.ts`, and here it is not a
 * nicety: **reads go to the network, writes go to the outbox.** §12's exit
 * criterion for this week is a session logged "in the gym, on a phone", and gyms
 * are basements. A logger that awaited the network between sets would be unusable
 * in the only place it is used.
 *
 * ## The dependency chain
 *
 * A set references its session by foreign key, so the order the outbox drains in
 * matters. Every set is queued with `dependsOn` set to the session's queue entry,
 * and the drain holds it until the server has acknowledged the session. Without
 * that, an offline session's twelve sets each fail once against a session the
 * server has never heard of — and each burns one of six attempts.
 *
 * The session's queue entry id is therefore *kept*, in {@link sessionQueueIds},
 * for as long as the session is being logged.
 */

import type { Exercise, ProgressionPoint, SetPrefill, WorkoutSession } from '@naitikos/core';

import { newIdempotencyKey, offlineEnvelope } from '@/lib/offline/device';
import { queueAndDrain } from '@/lib/offline/drain';

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new HttpError(response.status, `Request failed (${String(response.status)}).`);
  }
  return (await response.json()) as T;
}

/* -------------------------------------------------------------------------
 * The session → set dependency
 * ---------------------------------------------------------------------- */

/**
 * Outbox entry id per session id, so a set can name its prerequisite.
 *
 * In memory only. If the tab is reloaded mid-session the mapping is lost, and
 * the consequence is benign: the sets queued afterwards have no declared
 * dependency, and if they outrun the session the server answers with a
 * *retryable* precondition rather than a permanent rejection
 * (`workout.repository.ts`). Belt and braces, with the braces on the server.
 */
const sessionQueueIds = new Map<string, string>();

function rememberSessionQueueId(sessionId: string, queueId: string): void {
  sessionQueueIds.set(sessionId, queueId);
}

function forgetSession(sessionId: string): void {
  sessionQueueIds.delete(sessionId);
}

/* -------------------------------------------------------------------------
 * Reads
 * ---------------------------------------------------------------------- */

export type SessionSummary = {
  readonly session: WorkoutSession;
  readonly setCount: number;
  readonly exerciseCount: number;
  readonly dayKey: string;
};

export type SessionsResponse = {
  readonly active: WorkoutSession | null;
  readonly recent: readonly SessionSummary[];
  /** The most recent reading, in kg, or `null` if none has been recorded. */
  readonly bodyweightKg: string | null;
};

export async function fetchSessions(): Promise<SessionsResponse> {
  return getJson<SessionsResponse>('/api/gym/sessions');
}

export async function fetchExercises(term = ''): Promise<readonly Exercise[]> {
  const query = term === '' ? '' : `?q=${encodeURIComponent(term)}`;
  const body = await getJson<{ exercises: readonly Exercise[] }>(`/api/gym/exercises${query}`);
  return body.exercises;
}

/** Progression points, with decimals already formatted for display. */
export type WireProgressionPoint = Omit<
  ProgressionPoint,
  'topLoad' | 'bestEstimatedMax' | 'volume' | 'relativeTopLoad'
> & {
  readonly topLoad: string | null;
  readonly bestEstimatedMax: string | null;
  readonly volume: string | null;
  readonly relativeTopLoad: string | null;
};

export type ProgressionResponse = {
  readonly exercise: Exercise;
  readonly prefill: SetPrefill;
  readonly points: readonly WireProgressionPoint[];
};

export async function fetchProgression(
  exerciseId: string,
  options: { readonly excludeSessionId?: string; readonly setIndex?: number } = {},
): Promise<ProgressionResponse> {
  const params = new URLSearchParams({ exerciseId });
  if (options.excludeSessionId !== undefined) params.set('excludeSessionId', options.excludeSessionId);
  if (options.setIndex !== undefined) params.set('setIndex', String(options.setIndex));
  return getJson<ProgressionResponse>(`/api/gym/progression?${params.toString()}`);
}

export type VolumeResponse = {
  readonly fromDayKey: string;
  readonly toDayKey: string;
  readonly byMuscle: readonly { readonly muscle: string; readonly label: string; readonly volume: string; readonly sets: number }[];
  readonly total: {
    readonly volume: string;
    readonly countedSets: number;
    readonly totalReps: number;
    readonly excluded: Readonly<Record<string, number>>;
  };
  readonly sessionDays: readonly string[];
  readonly method: { readonly secondaryMuscleShare: string; readonly note: string };
};

export async function fetchVolume(
  fromDayKey: string,
  toDayKey: string,
  zone: string,
): Promise<VolumeResponse> {
  const params = new URLSearchParams({ fromDayKey, toDayKey, zone });
  return getJson<VolumeResponse>(`/api/gym/volume?${params.toString()}`);
}

/* -------------------------------------------------------------------------
 * Writes — all through the outbox
 * ---------------------------------------------------------------------- */

export type QueuedSession = {
  readonly sessionId: string;
  readonly queuedId: string;
};

/**
 * Start a session.
 *
 * The session id is minted here, client-side, and that is §5.7's requirement
 * rather than a convenience: every set logged in the next ninety minutes
 * references it, and the operator may never once be online during them.
 */
export async function startSession(input: {
  readonly sessionId: string;
  readonly startedAt: string;
  readonly zone: string;
  readonly bodyweightKg?: string | null;
  readonly title?: string | null;
}): Promise<QueuedSession> {
  const entry = await queueAndDrain({
    id: newIdempotencyKey(),
    endpoint: '/api/gym/sessions',
    method: 'POST',
    body: {
      id: input.sessionId,
      startedAt: input.startedAt,
      zone: input.zone,
      ...(input.bodyweightKg === undefined || input.bodyweightKg === null
        ? {}
        : { bodyweightKg: input.bodyweightKg }),
      ...(input.title === undefined || input.title === null ? {} : { title: input.title }),
      ...offlineEnvelope(),
    },
    // A day, not the contents. §5.13 keeps user content out of anything that
    // could end up in a log.
    label: `Session started · ${input.startedAt.slice(0, 10)}`,
  });

  rememberSessionQueueId(input.sessionId, entry.id);
  return { sessionId: input.sessionId, queuedId: entry.id };
}

export type QueuedSet = {
  readonly setId: string;
  readonly queuedId: string;
};

export async function logSet(input: {
  readonly setId: string;
  readonly sessionId: string;
  readonly performedAt: string;
  readonly zone: string;
  readonly exerciseId: string;
  readonly exerciseName: string;
  readonly orderIndex: number;
  readonly kind?: string;
  readonly load?: string | undefined;
  readonly loadUnit?: string | undefined;
  readonly reps?: number | undefined;
  readonly rpe?: string | undefined;
  readonly restSeconds?: number | undefined;
  readonly side?: 'left' | 'right' | undefined;
}): Promise<QueuedSet> {
  const dependsOn = sessionQueueIds.get(input.sessionId);

  const entry = await queueAndDrain({
    id: newIdempotencyKey(),
    endpoint: '/api/gym/sets',
    method: 'POST',
    body: {
      sessionId: input.sessionId,
      performedAt: input.performedAt,
      zone: input.zone,
      set: {
        id: input.setId,
        exerciseId: input.exerciseId,
        orderIndex: input.orderIndex,
        ...(input.kind === undefined ? {} : { kind: input.kind }),
        ...(input.load === undefined ? {} : { load: input.load }),
        ...(input.loadUnit === undefined ? {} : { loadUnit: input.loadUnit }),
        ...(input.reps === undefined ? {} : { reps: input.reps }),
        ...(input.rpe === undefined ? {} : { rpe: input.rpe }),
        ...(input.restSeconds === undefined ? {} : { restSeconds: input.restSeconds }),
        ...(input.side === undefined ? {} : { side: input.side }),
      },
      ...offlineEnvelope(),
    },
    // The exercise name, not the numbers. Which movement is not sensitive; how
    // much the operator lifted is theirs.
    label: `Set · ${input.exerciseName}`,
    ...(dependsOn === undefined ? {} : { dependsOn }),
  });

  return { setId: input.setId, queuedId: entry.id };
}

export async function closeSession(input: {
  readonly sessionId: string;
  readonly endedAt: string;
  readonly perceivedEffort?: number | null;
  readonly notes?: string | null;
}): Promise<{ readonly queuedId: string }> {
  const dependsOn = sessionQueueIds.get(input.sessionId);

  const entry = await queueAndDrain({
    id: newIdempotencyKey(),
    endpoint: '/api/gym/sessions',
    method: 'PATCH',
    body: {
      sessionId: input.sessionId,
      endedAt: input.endedAt,
      ...(input.perceivedEffort === undefined || input.perceivedEffort === null
        ? {}
        : { perceivedEffort: input.perceivedEffort }),
      ...(input.notes === undefined || input.notes === null ? {} : { notes: input.notes }),
      ...offlineEnvelope(),
    },
    label: `Session finished · ${input.endedAt.slice(0, 10)}`,
    ...(dependsOn === undefined ? {} : { dependsOn }),
  });

  /*
   * The mapping is dropped *after* the close is queued, not before: the close
   * itself depends on the start, and forgetting first would let it be sent
   * against a session the server has not seen.
   */
  forgetSession(input.sessionId);
  return { queuedId: entry.id };
}
