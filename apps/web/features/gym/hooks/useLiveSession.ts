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
 *
 * ## And mirrored to disk, because the tab is not there either
 *
 * The sets were durable; *the session* was not. Everything below used to live
 * only in React state, on a route the operator leaves constantly — to check a
 * program, to reply to a message, to unlock a phone whose backgrounded tab iOS
 * has since discarded. Every one of those returned to "No session in progress",
 * and the natural response is to press *Start a session* again, which produces a
 * second session against the same workout. That is not a lost draft; §9.1 makes
 * the observation log append-only, so it is a permanently split training day.
 *
 * `liveSessionStore` therefore mirrors the snapshot on every mutation and it is
 * restored on mount. The mirror is written from the callbacks rather than from
 * an effect on `live`, deliberately: an effect would also run on the very first
 * render, with `live` still `null`, and would clear the snapshot a tick before
 * the restore had a chance to read it.
 *
 * ## The prefill falls back to this session before it falls back to nothing
 *
 * §8.10: "Last value pre-filled wherever a sensible prior exists. Confirming
 * beats typing." The server's prefill deliberately excludes the session in
 * progress, so that set two offers *last week's* set two rather than a copy of
 * set one — which is right, and which leaves a hole the first time a movement is
 * ever performed: the server has no history, so every set of it arrived with
 * empty fields and had to be typed. A set logged ten seconds ago in this session
 * is unambiguously a sensible prior, so it fills the hole rather than the
 * operator doing it.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { uuidV7 } from '@naitikos/shared';
import { EMPTY_PREFILL, isoFromMillis, systemClock, type Exercise, type SetPrefill } from '@naitikos/core';

import { queryKeys } from '@/lib/query/QueryProvider';
import type { SetDraft } from '../components/SetEditor';
import {
  clearSession,
  gymStorage,
  loadRecentExerciseIds,
  loadSession,
  rememberExerciseId,
  saveSession,
  type KeyValueStore,
  type LoggedSet,
} from '../services/liveSessionStore';
import {
  closeSession as queueClose,
  fetchExercises,
  fetchProgression,
  logSet as queueSet,
  startSession as queueStart,
} from '../services/gymClient';

export type { LoggedSet } from '../services/liveSessionStore';

/** One frozen empty array, so "no sets" is referentially stable across renders. */
const EMPTY_SETS: readonly LoggedSet[] = Object.freeze([]);

/**
 * Everything about a session in progress, in one object.
 *
 * One piece of state rather than five, because the five are written together on
 * every transition and are mirrored to disk as a unit. Five `useState` calls
 * would mean five chances for the snapshot to be written from a half-updated
 * set of closures, and the failure that produces — a restored session whose
 * `sets` and `currentExerciseId` disagree — is invisible until the operator is
 * mid-workout.
 */
type LiveState = {
  readonly sessionId: string;
  readonly startedAt: string;
  readonly bodyweightKg: string | null;
  readonly currentExerciseId: string | null;
  readonly sets: readonly LoggedSet[];
};

export type UseLiveSession = {
  readonly sessionId: string | null;
  readonly startedAt: string | null;
  readonly sets: readonly LoggedSet[];
  readonly exercises: readonly Exercise[];
  readonly currentExercise: Exercise | null;
  /** The current movement's sets in this session, oldest first. Shown on the editor. */
  readonly currentExerciseSets: readonly LoggedSet[];
  readonly prefill: SetPrefill;
  readonly isPrefillLoading: boolean;
  /** Position of the next set of the current exercise, 1-based for display. */
  readonly nextSetNumber: number;
  /** Movements to offer first in the picker: this session's, then earlier ones. */
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

  /*
   * Resolved once. `gymStorage()` touches `window.localStorage`, which throws
   * rather than returning undefined when storage is blocked, so calling it per
   * render would mean a try/catch per render for a value that cannot change.
   */
  const store = useMemo<KeyValueStore | null>(() => gymStorage(), []);

  const [live, setLive] = useState<LiveState | null>(null);
  const [recentIds, setRecentIds] = useState<readonly string[]>([]);
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

  /*
   * The restore.
   *
   * It is an effect rather than a `useState` initialiser for the reason
   * `lib/offline/useDraft.ts` records: local storage is an external system, it
   * does not exist on the server, and reading it during a render would be both
   * impure and a hydration mismatch.
   *
   * `restore` is a function rather than a straight-line effect body because it
   * is also the `storage` listener, and that is not a formality: `storage`
   * fires in *other* documents of the same origin, so the logger opened in a
   * second tab adopts the session already in progress rather than offering to
   * start a second one — which is the same duplicate-session failure this file
   * exists to prevent, arriving by a different route.
   *
   * Both writes are updaters that decline to overwrite state that already
   * exists. A restore fills a gap; it never reaches back over a session the
   * operator has started in the milliseconds since mount.
   */
  useEffect(() => {
    const restore = (): void => {
      const snapshot = loadSession(store, systemClock.nowMillis());
      if (snapshot !== null) {
        setLive(
          (current) =>
            current ?? {
              sessionId: snapshot.sessionId,
              startedAt: snapshot.startedAt,
              bodyweightKg: snapshot.bodyweightKg,
              currentExerciseId: snapshot.currentExerciseId,
              sets: snapshot.sets,
            },
        );
      }

      const stored = loadRecentExerciseIds(store);
      if (stored.length > 0) setRecentIds((current) => (current.length === 0 ? stored : current));
    };

    restore();
    window.addEventListener('storage', restore);
    return () => {
      window.removeEventListener('storage', restore);
    };
  }, [store]);

  /**
   * Mirror the snapshot, or remove it. Called from every mutation.
   *
   * The `zone` written is the *current* one rather than the stored one: a
   * session resumed after crossing a timezone is still today's session, and the
   * day key it lands under is decided by where the operator is now.
   */
  const persist = useCallback(
    (next: LiveState | null): void => {
      if (next === null) {
        clearSession(store);
        return;
      }
      saveSession(
        store,
        {
          sessionId: next.sessionId,
          startedAt: next.startedAt,
          zone,
          bodyweightKg: next.bodyweightKg,
          currentExerciseId: next.currentExerciseId,
          sets: next.sets,
        },
        systemClock.nowMillis(),
      );
    },
    [store, zone],
  );

  const exercises = useMemo(() => library.data ?? [], [library.data]);

  /*
   * The selected movement is held as an *id* and resolved against the library,
   * rather than held as an `Exercise`. That is what makes a restored session
   * arrive with its movement still selected: the snapshot on disk cannot carry a
   * live object, and re-picking the exercise you were already three sets into is
   * precisely the "where was I" tax this whole file exists to remove. The
   * library itself survives a reload in the persisted query cache, so the lookup
   * succeeds offline too.
   */
  const currentExercise = useMemo(() => {
    const id = live?.currentExerciseId ?? null;
    if (id === null) return null;
    return exercises.find((exercise) => exercise.id === id) ?? null;
  }, [exercises, live?.currentExerciseId]);

  const sets = live?.sets ?? EMPTY_SETS;

  const currentExerciseSets = useMemo(
    () => (currentExercise === null ? EMPTY_SETS : sets.filter((set) => set.exerciseId === currentExercise.id)),
    [sets, currentExercise],
  );

  const setIndex = currentExerciseSets.length;
  const sessionId = live?.sessionId ?? null;

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

  /** See the file header: history first, then this session, then empty fields. */
  const prefill = useMemo<SetPrefill>(() => {
    const fromHistory = progression.data?.prefill ?? EMPTY_PREFILL;
    if (fromHistory.source !== 'none') return fromHistory;

    const previous = currentExerciseSets.at(-1);
    if (previous === undefined) return fromHistory;

    return {
      load: previous.load === null ? null : String(previous.load),
      loadUnit: previous.loadUnit,
      reps: previous.reps,
      // Never carried forward. RPE is a judgement about the set being performed,
      // and copying it would fabricate an assessment nobody made.
      rpe: null,
      source: 'last_set',
      fromSessionId: sessionId,
      // Deliberately null: `fromDayKey` is what the editor uses to caption a
      // prefill "last time", and this did not come from last time. The editor
      // already lists this session's sets, which says it better.
      fromDayKey: null,
    };
  }, [progression.data, currentExerciseSets, sessionId]);

  const start = useCallback(
    async (weight?: string | null) => {
      const now = systemClock.nowMillis();
      const id = uuidV7(now);
      const at = isoFromMillis(now);
      const bodyweight = weight === undefined ? (live?.bodyweightKg ?? initialBodyweightKg) : weight;

      const next: LiveState = {
        sessionId: id,
        startedAt: at,
        bodyweightKg: bodyweight,
        currentExerciseId: null,
        sets: [],
      };
      setLive(next);
      persist(next);

      await queueStart({ sessionId: id, startedAt: at, zone, bodyweightKg: bodyweight });
      await client.invalidateQueries({ queryKey: queryKeys.gymSessions() });
    },
    [zone, live?.bodyweightKg, initialBodyweightKg, client, persist],
  );

  const selectExercise = useCallback(
    (exercise: Exercise) => {
      /*
       * Remembered across sessions, not just within one. §4.1's design note and
       * §4.3's "ten-second rule" both order the picker recents-first and
       * search-last; the recents used to be derived from *this session's* sets,
       * which made the list empty for the one choice where it matters most —
       * the first movement of the workout — so every session opened onto a
       * keyboard.
       */
      setRecentIds(rememberExerciseId(store, exercise.id));

      setLive((current) => {
        if (current === null) return current;
        const next = { ...current, currentExerciseId: exercise.id };
        persist(next);
        return next;
      });
    },
    [store, persist],
  );

  const logSet = useCallback(
    async (draft: SetDraft) => {
      if (live === null || currentExercise === null) return;

      setIsQueueing(true);
      try {
        const now = systemClock.nowMillis();
        const setId = uuidV7(now);
        const performedAt = isoFromMillis(now);
        const orderIndex = live.sets.length;

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
        const next: LiveState = { ...live, sets: [...live.sets, logged] };
        setLive(next);
        /*
         * Mirrored *before* the outbox write is awaited. The two are
         * independent — the outbox is what reaches the server, this is what
         * survives a reload — and the window between them is precisely where a
         * tab gets discarded, because queueing is the only asynchronous step on
         * this path.
         */
        persist(next);

        await queueSet({
          setId,
          sessionId: live.sessionId,
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
    [live, currentExercise, zone, persist],
  );

  const finish = useCallback(
    async (perceivedEffort?: number | null) => {
      if (live === null) return;

      setIsQueueing(true);
      try {
        await queueClose({
          sessionId: live.sessionId,
          endedAt: isoFromMillis(systemClock.nowMillis()),
          perceivedEffort: perceivedEffort ?? null,
        });

        setLive(null);
        persist(null);
        await client.invalidateQueries({ queryKey: queryKeys.gymSessions() });
      } finally {
        setIsQueueing(false);
      }
    },
    [live, client, persist],
  );

  /**
   * What the picker offers above the search box.
   *
   * This session's movements first — a superset or a movement returned to is the
   * commonest reason the picker is opened mid-session — then the ones used in
   * earlier sessions, which is what makes the *first* choice of the workout a
   * tap. Ids that no longer resolve (a deleted exercise) simply fall out.
   */
  const recentExercises = useMemo(() => {
    const thisSession = [...sets].reverse().map((set) => set.exerciseId);
    const ordered: Exercise[] = [];
    const seen = new Set<string>();

    for (const id of [...thisSession, ...recentIds]) {
      if (seen.has(id)) continue;
      seen.add(id);
      const exercise = exercises.find((item) => item.id === id);
      if (exercise !== undefined) ordered.push(exercise);
    }
    return ordered;
  }, [sets, recentIds, exercises]);

  return {
    sessionId,
    startedAt: live?.startedAt ?? null,
    sets,
    exercises,
    currentExercise,
    currentExerciseSets,
    prefill,
    isPrefillLoading: progression.isFetching,
    nextSetNumber: setIndex + 1,
    recentExercises,
    bodyweightKg: live?.bodyweightKg ?? initialBodyweightKg,
    start,
    selectExercise,
    logSet,
    finish,
    isQueueing,
  };
}
