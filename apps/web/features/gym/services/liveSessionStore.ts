'use client';

/**
 * What survives the phone being put in a pocket.
 *
 * §12's exit criterion for the logger is "a real training session logged in the
 * gym, on a phone, without friction". The friction that was left is not in any
 * control on the screen — it is that **nothing on this screen existed outside
 * React state.** A session in progress, the sets already logged, and the running
 * rest clock all lived in memory on a route the operator leaves constantly: to
 * check a program, to answer a message, to unlock a phone that iOS has since
 * discarded the tab of. Every one of those returns to "No session in progress",
 * and the operator starts a *second* session against the same workout — which is
 * not a lost draft, it is a corrupted training history, permanently, because
 * §9.1 makes the observation log append-only.
 *
 * ## `localStorage`, for the reason `drafts.ts` gives
 *
 * The outbox next door is IndexedDB and this deliberately is not. The deciding
 * property is what can be written in the last moment before a page is
 * destroyed: `localStorage.setItem` has *already happened* when a
 * `visibilitychange` handler returns, where an IndexedDB transaction opened in
 * the same handler is a promise the browser is under no obligation to keep. A
 * session snapshot is a few hundred bytes; the size argument that favours
 * IndexedDB does not apply.
 *
 * This is a *mirror*, not a source of truth. The sets themselves are already
 * durable in the §5.7 outbox the instant they are logged — the server will
 * receive them whether or not this file exists. What is stored here is the
 * screen's knowledge of them: which session id they belong to, which movement
 * is selected, and what the next set should be prefilled with. Losing it does
 * not lose data; it loses the operator's place, and their place is the thing
 * they cannot reconstruct at 6am between sets.
 *
 * ## Every function is pure and takes its clock as an argument
 *
 * No `systemClock` import, no `window` access outside {@link gymStorage}, no
 * module state — the same shape as `lib/offline/drafts.ts`, and for the same
 * reason: §11.3 bans raw `Date` because a clock that cannot be substituted is a
 * rule that cannot be tested. `liveSessionStore.test.ts` drives all of this
 * against a `Map`-backed fake in Node.
 */

/* -------------------------------------------------------------------------
 * Policy
 * ---------------------------------------------------------------------- */

/** Namespaced and versioned, so a shape change cannot be read as the old shape. */
export const SESSION_KEY = 'naitikos.gym.session.v1';
export const REST_KEY = 'naitikos.gym.rest.v1';
export const RECENT_KEY = 'naitikos.gym.recent.v1';

/**
 * How long a session snapshot may be resumed for. Eight hours.
 *
 * Long enough that nothing in a real training day comes close — the longest
 * plausible session, plus a lunch break, plus forgetting to press Finish for an
 * hour. Short enough that a session left open on Tuesday is not silently resumed
 * on Wednesday morning, which would attach Wednesday's sets to Tuesday's session
 * and make both unreadable. Past the window the snapshot is discarded and the
 * operator starts fresh; the Tuesday sets are already durable in the outbox and
 * are unaffected.
 */
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

/**
 * How long past its target a restored rest clock is still worth showing. Thirty
 * minutes.
 *
 * A restored timer reading `47:12` is not information, it is noise from a tab
 * that was closed and reopened after lunch. Under the window, an overdue timer
 * is exactly what the operator needs to see: it tells them how long the rest
 * they were not watching actually was.
 */
export const REST_STALE_AFTER_MS = 30 * 60 * 1000;

/** How many movements the picker remembers between sessions. */
export const MAX_RECENT_EXERCISES = 8;

/* -------------------------------------------------------------------------
 * Storage handle
 * ---------------------------------------------------------------------- */

/** The slice of `Storage` this module uses. A `Map` satisfies it in tests. */
export type KeyValueStore = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
};

/**
 * The browser's store, or `null` where there is not one.
 *
 * Accessing `window.localStorage` *throws* rather than returning undefined when
 * storage is blocked — Safari with cookies disabled, some private modes — so the
 * probe is a try/catch and every caller is written to work without it. The
 * degraded behaviour is exactly today's behaviour: the session lives in memory
 * and dies with the tab.
 */
export function gymStorage(): KeyValueStore | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------
 * The session snapshot
 * ---------------------------------------------------------------------- */

/**
 * A set as the live list holds it. Local, optimistic, and complete.
 *
 * Declared here rather than in `useLiveSession` because the store has to name
 * the shape it validates, and the hook importing the store while the store
 * imported the hook would be a cycle.
 */
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

export type SessionSnapshot = {
  readonly sessionId: string;
  readonly startedAt: string;
  readonly zone: string;
  readonly bodyweightKg: string | null;
  /** The movement selected when the snapshot was taken, resolved against the library. */
  readonly currentExerciseId: string | null;
  readonly sets: readonly LoggedSet[];
  /** Milliseconds since the epoch, from the caller's clock. */
  readonly savedAt: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

function asNullableNumber(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseLoggedSet(value: unknown): LoggedSet | null {
  if (!isRecord(value)) return null;

  const id = asString(value['id']);
  const exerciseId = asString(value['exerciseId']);
  const exerciseName = asString(value['exerciseName']);
  const loadUnit = asString(value['loadUnit']);
  const performedAt = asString(value['performedAt']);
  const orderIndex = value['orderIndex'];
  const load = asNullableNumber(value['load']);
  const reps = asNullableNumber(value['reps']);
  const rpe = asNullableNumber(value['rpe']);
  const rawSide = value['side'];

  if (id === null || exerciseId === null || exerciseName === null) return null;
  if (loadUnit === null || performedAt === null) return null;
  if (typeof orderIndex !== 'number' || !Number.isFinite(orderIndex)) return null;
  if (load === undefined || reps === undefined || rpe === undefined) return null;
  if (rawSide !== null && rawSide !== 'left' && rawSide !== 'right') return null;

  return {
    id,
    exerciseId,
    exerciseName,
    orderIndex,
    load,
    reps,
    rpe,
    side: rawSide,
    loadUnit,
    performedAt,
  };
}

/**
 * Read the snapshot back, or `null`.
 *
 * Validated field by field rather than cast. What comes off disk was written by
 * a *previous version of this application* — a shape that was correct in
 * October is not a shape that is correct now, and a cast would push the
 * mismatch into a render as `undefined.length` rather than catching it here.
 * Anything unrecognisable is treated as absent, which is the same path as a
 * first-ever load and therefore already known to work.
 */
export function loadSession(store: KeyValueStore | null, now: number): SessionSnapshot | null {
  if (store === null) return null;

  const raw = store.getItem(SESSION_KEY);
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const sessionId = asString(parsed['sessionId']);
  const startedAt = asString(parsed['startedAt']);
  const zone = asString(parsed['zone']);
  const bodyweightKg = asNullableString(parsed['bodyweightKg']);
  const currentExerciseId = asNullableString(parsed['currentExerciseId']);
  const savedAt = parsed['savedAt'];
  const rawSets = parsed['sets'];

  if (sessionId === null || startedAt === null || zone === null) return null;
  if (bodyweightKg === undefined || currentExerciseId === undefined) return null;
  if (typeof savedAt !== 'number' || !Number.isFinite(savedAt)) return null;
  if (!Array.isArray(rawSets)) return null;

  // Expired, or written by a clock that has since moved backwards. Either way
  // it is not this session, and resuming it would corrupt the one starting now.
  if (now - savedAt > SESSION_TTL_MS || savedAt > now + SESSION_TTL_MS) return null;

  const sets: LoggedSet[] = [];
  for (const entry of rawSets) {
    const set = parseLoggedSet(entry);
    // One unreadable set discards the whole snapshot rather than resuming a
    // session that is quietly missing its third set. A wrong count is worse
    // than no resume, because the operator would not know to look.
    if (set === null) return null;
    sets.push(set);
  }

  return { sessionId, startedAt, zone, bodyweightKg, currentExerciseId, sets, savedAt };
}

/** Write, or do nothing where there is no store. A full quota is not fatal here. */
export function saveSession(
  store: KeyValueStore | null,
  snapshot: Omit<SessionSnapshot, 'savedAt'>,
  now: number,
): void {
  if (store === null) return;
  try {
    store.setItem(SESSION_KEY, JSON.stringify({ ...snapshot, savedAt: now }));
  } catch {
    /* Quota, or a store that accepts a handle but refuses a write. The session
     * continues in memory exactly as it did before this file existed. */
  }
}

export function clearSession(store: KeyValueStore | null): void {
  if (store === null) return;
  try {
    store.removeItem(SESSION_KEY);
  } catch {
    /* Nothing to do about it, and nothing depends on it having worked. */
  }
}

/* -------------------------------------------------------------------------
 * The rest clock
 * ---------------------------------------------------------------------- */

export type RestSnapshot = {
  /** The instant rest began, in milliseconds since the epoch. */
  readonly startedAt: number;
  /** The target in seconds, including any mid-rest adjustment. */
  readonly target: number;
};

/**
 * The running clock, if it is still worth showing.
 *
 * Deriving elapsed time from a stored *instant* is what makes the timer correct
 * across a lock screen; storing that instant is what makes it correct across the
 * tab being discarded, which is the same failure one step further along. iOS
 * does both, in that order, to a backgrounded PWA on a phone in a gym locker.
 */
export function loadRest(store: KeyValueStore | null, now: number): RestSnapshot | null {
  if (store === null) return null;

  const raw = store.getItem(REST_KEY);
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const startedAt = parsed['startedAt'];
  const target = parsed['target'];
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return null;
  if (typeof target !== 'number' || !Number.isFinite(target) || target <= 0) return null;

  const elapsedMs = now - startedAt;
  if (elapsedMs < 0) return null;
  if (elapsedMs > target * 1000 + REST_STALE_AFTER_MS) return null;

  return { startedAt, target };
}

export function saveRest(store: KeyValueStore | null, snapshot: RestSnapshot): void {
  if (store === null) return;
  try {
    store.setItem(REST_KEY, JSON.stringify(snapshot));
  } catch {
    /* See `saveSession`. The timer keeps running in memory. */
  }
}

export function clearRest(store: KeyValueStore | null): void {
  if (store === null) return;
  try {
    store.removeItem(REST_KEY);
  } catch {
    /* See `clearSession`. */
  }
}

/* -------------------------------------------------------------------------
 * Recently used movements
 * ---------------------------------------------------------------------- */

/**
 * The last few movements chosen, across sessions.
 *
 * §4.1's design note and §4.3's "ten-second rule" both say the same thing about
 * ordering: recents first, search last. The picker already showed recents — but
 * it derived them from *this session's* sets, so the list was empty for the one
 * choice that matters most, the first movement of the workout, and every session
 * therefore opened with a keyboard.
 *
 * Held on the device rather than served, because the alternative is a round trip
 * on the P1 path in a basement, and because eight exercise ids is smaller than
 * the request that would fetch them.
 */
export function loadRecentExerciseIds(store: KeyValueStore | null): readonly string[] {
  if (store === null) return [];

  const raw = store.getItem(RECENT_KEY);
  if (raw === null) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  return parsed.filter((entry): entry is string => typeof entry === 'string').slice(0, MAX_RECENT_EXERCISES);
}

/** Move one id to the front, de-duplicated, and bound the list. Most recent first. */
export function rememberExerciseId(store: KeyValueStore | null, exerciseId: string): readonly string[] {
  const next = [exerciseId, ...loadRecentExerciseIds(store).filter((id) => id !== exerciseId)].slice(
    0,
    MAX_RECENT_EXERCISES,
  );
  if (store !== null) {
    try {
      store.setItem(RECENT_KEY, JSON.stringify(next));
    } catch {
      /* The picker falls back to search, which is where it was before. */
    }
  }
  return next;
}
