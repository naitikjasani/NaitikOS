'use client';

/**
 * The live session's state — §7.3's "stateful logic, one concern each".
 *
 * The one concern is *the session in progress*: which exercise is selected, how
 * many sets have been logged against it, and what the next set should be
 * prefilled with.
 *
 * ## Optimistic, because the network is not there
 *
 * A logged set appears in the list the instant it is queued. That is not a
 * latency optimisation — §5.7 makes the outbox write durable *before* this
 * resolves, so the set genuinely exists at that point; the server simply has
 * not been told. Waiting for a server acknowledgement that may be ninety
 * minutes away would leave the operator staring at a spinner in a basement.
 *
 * The consequence, stated because it is easy to forget: the local list is the
 * source of truth for the duration of the session, and the server's copy is
 * reconciled on the next load.
 */

import { useCallback, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { uuidV7 } from '@naitikos/shared';
import { EMPTY_PREFILL, isoFromMillis, systemClock, type Exercise, type SetPrefill } from '@naitikos/core';

import { queryKeys } from '@/lib/query/QueryProvider';
import type { SetDraft } from '../components/SetEditor';
import {
  closeSession as queueClose,
  fetchExercises,
  fetchProgression,
  logSet as queueSet,
  startSession as queueStart,
} from '../services/gymClient';

/** A set as the live list holds it. Local, optimistic, and complete. */
export type LoggedSet = {
  readonly id: string;
  readonly exerciseId: string;
  readonly exerciseName: string;
  readonly orderIndex: number;
  readonly load: number | null;
  readonly loadUnit: string;
  readonly reps: number | null;
  readonly rpe: number | null;
  readonly side: 'left' | 'right' | null;
  readonly performedAt: string;
};

export type UseLiveSession = {
  readonly sessionId: string | null;
  readonly startedAt: string | null;
  readonly sets: readonly LoggedSet[];
  readonly exercises: readonly Exercise[];
  readonly currentExercise: Exercise | null;
  readonly prefill: SetPrefill;
  readonly isPrefillLoading: boolean;
  /** Position of the next set of the current exercise, 1-based for display. */
  readonly nextSetNumber: number;
  /** Movements used in this session, most recent first. Feeds the picker. */
  readonly recentExercises: readonly Exercise[];
  readonly bodyweightKg: string | null;

  start: (bodyweightKg?: string | null) => Promise<void>;
  selectExercise: (exercise: Exercise) => void;
  logSet: (draft: SetDraft) => Promise<void>;
  finish: (perceivedEffort?: number | null) => Promise<void>;
  readonly isQueueing: boolean;
};

export function useLiveSession(zone: string, initialBodyweightKg: string | null = null): UseLiveSession {
  const client = useQueryClient();

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const [bodyweightKg, setBodyweightKg] = useState<string | null>(initialBodyweightKg);
  const [sets, setSets] = useState<readonly LoggedSet[]>([]);
  const [currentExercise, setCurrentExercise] = useState<Exercise | null>(null);
  const [isQueueing, setIsQueueing] = useState(false);

  /*
   * The library is loaded once and kept. `staleTime: Infinity` is right here in
   * a way it rarely is: the exercise library is reference data that changes
   * when the operator edits it, and re-fetching it mid-session would be a
   * network request on the P1 path for data that has not changed.
   */
  const library = useQuery({
    queryKey: queryKeys.gymExercises(),
    queryFn: () => fetchExercises(),
    staleTime: Number.POSITIVE_INFINITY,
  });

  const setsForCurrent = useMemo(
    () => (currentExercise === null ? [] : sets.filter((set) => set.exerciseId === currentExercise.id)),
    [sets, currentExercise],
  );

  const setIndex = setsForCurrent.length;

  const progression = useQuery({
    queryKey: queryKeys.gymProgression(currentExercise?.id ?? '', setIndex, sessionId ?? undefined),
    queryFn: () =>
      fetchProgression(currentExercise?.id ?? '', {
        setIndex,
        // The session in progress is excluded so the prefill offers *last*
        // session's numbers rather than the set just logged — which would make
        // every set a copy of the one before it, and progression impossible.
        ...(sessionId === null ? {} : { excludeSessionId: sessionId }),
      }),
    enabled: currentExercise !== null,
    staleTime: 60_000,
  });

  const start = useCallback(
    async (weight?: string | null) => {
      const now = systemClock.nowMillis();
      const id = uuidV7(now);
      const at = isoFromMillis(now);

      setSessionId(id);
      setStartedAt(at);
      if (weight !== undefined) setBodyweightKg(weight);

      await queueStart({
        sessionId: id,
        startedAt: at,
        zone,
        bodyweightKg: weight ?? bodyweightKg,
      });
      await client.invalidateQueries({ queryKey: queryKeys.gymSessions() });
    },
    [zone, bodyweightKg, client],
  );

  const selectExercise = useCallback((exercise: Exercise) => {
    setCurrentExercise(exercise);
  }, []);

  const logSet = useCallback(
    async (draft: SetDraft) => {
      if (sessionId === null || currentExercise === null) return;

      setIsQueueing(true);
      try {
        const now = systemClock.nowMillis();
        const setId = uuidV7(now);
        const performedAt = isoFromMillis(now);
        const orderIndex = sets.length;

        const logged: LoggedSet = {
          id: setId,
          exerciseId: currentExercise.id,
          exerciseName: currentExercise.name,
          orderIndex,
          load: draft.load,
          loadUnit: draft.loadUnit,
          reps: draft.reps,
          rpe: draft.rpe,
          side: draft.side,
          performedAt,
        };

        // Optimistic, and durable a moment later. See the header.
        setSets((current) => [...current, logged]);

        await queueSet({
          setId,
          sessionId,
          performedAt,
          zone,
          exerciseId: currentExercise.id,
          exerciseName: currentExercise.name,
          orderIndex,
          ...(draft.load === null ? {} : { load: String(draft.load) }),
          loadUnit: draft.loadUnit,
          ...(draft.reps === null ? {} : { reps: draft.reps }),
          ...(draft.rpe === null ? {} : { rpe: String(draft.rpe) }),
          ...(draft.side === null ? {} : { side: draft.side }),
        });
      } finally {
        setIsQueueing(false);
      }
    },
    [sessionId, currentExercise, sets.length, zone],
  );

  const finish = useCallback(
    async (perceivedEffort?: number | null) => {
      if (sessionId === null) return;

      setIsQueueing(true);
      try {
        await queueClose({
          sessionId,
          endedAt: isoFromMillis(systemClock.nowMillis()),
          perceivedEffort: perceivedEffort ?? null,
        });

        setSessionId(null);
        setStartedAt(null);
        setSets([]);
        setCurrentExercise(null);
        await client.invalidateQueries({ queryKey: queryKeys.gymSessions() });
      } finally {
        setIsQueueing(false);
      }
    },
    [sessionId, client],
  );

  const recentExercises = useMemo(() => {
    const seen = new Map<string, Exercise>();
    for (const set of [...sets].reverse()) {
      const exercise = (library.data ?? []).find((item) => item.id === set.exerciseId);
      if (exercise !== undefined && !seen.has(exercise.id)) seen.set(exercise.id, exercise);
    }
    return [...seen.values()];
  }, [sets, library.data]);

  return {
    sessionId,
    startedAt,
    sets,
    exercises: library.data ?? [],
    currentExercise,
    prefill: progression.data?.prefill ?? EMPTY_PREFILL,
    isPrefillLoading: progression.isFetching,
    nextSetNumber: setIndex + 1,
    recentExercises,
    bodyweightKg,
    start,
    selectExercise,
    logSet,
    finish,
    isQueueing,
  };
}
