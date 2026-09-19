import { describe, expect, it } from 'vitest';

import {
  MAX_RECENT_EXERCISES,
  REST_KEY,
  REST_STALE_AFTER_MS,
  SESSION_KEY,
  SESSION_TTL_MS,
  clearSession,
  loadRecentExerciseIds,
  loadRest,
  loadSession,
  rememberExerciseId,
  saveRest,
  saveSession,
  type KeyValueStore,
  type LoggedSet,
} from './liveSessionStore';

/**
 * The store is pure and takes its clock as an argument, so the whole of it is
 * testable against a `Map` in Node — no jsdom, no fake timers, no mocked
 * globals. That is the reason for the shape (§11.3: a clock that cannot be
 * substituted is a rule that cannot be tested).
 *
 * What is actually being asserted is the *refusal* path. A round trip working
 * is the easy half; the half that matters is that a snapshot from yesterday, a
 * snapshot written by an older build, and a clock that has jumped backwards all
 * decline to resume, because each of those resuming is a corrupted training day
 * rather than a visible bug.
 */
function fakeStore(initial: Record<string, string> = {}): KeyValueStore {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

const NOW = 1_760_000_000_000;

function aSet(overrides: Partial<LoggedSet> = {}): LoggedSet {
  return {
    id: 'set-1',
    exerciseId: 'ex-1',
    exerciseName: 'Back Squat',
    orderIndex: 0,
    load: 100,
    loadUnit: 'kg',
    reps: 5,
    rpe: 8,
    side: null,
    performedAt: '2026-09-14T06:14:00.000Z',
    ...overrides,
  };
}

const snapshot = {
  sessionId: 'session-1',
  startedAt: '2026-09-14T06:00:00.000Z',
  zone: 'Asia/Kolkata',
  bodyweightKg: '74.2',
  currentExerciseId: 'ex-1',
  sets: [aSet()],
};

describe('the session snapshot', () => {
  it('round-trips everything the logger needs to resume', () => {
    const store = fakeStore();
    saveSession(store, snapshot, NOW);

    expect(loadSession(store, NOW)).toEqual({ ...snapshot, savedAt: NOW });
  });

  it('resumes a session from earlier in the same workout', () => {
    const store = fakeStore();
    saveSession(store, snapshot, NOW);

    expect(loadSession(store, NOW + 90 * 60 * 1000)?.sessionId).toBe('session-1');
  });

  it('refuses a session from yesterday rather than attaching today to it', () => {
    const store = fakeStore();
    saveSession(store, snapshot, NOW);

    expect(loadSession(store, NOW + SESSION_TTL_MS + 1)).toBeNull();
  });

  it('refuses a snapshot written in the future, which means the clock moved', () => {
    const store = fakeStore();
    saveSession(store, snapshot, NOW + 2 * SESSION_TTL_MS);

    expect(loadSession(store, NOW)).toBeNull();
  });

  it('treats unreadable storage as an absent session', () => {
    expect(loadSession(fakeStore({ [SESSION_KEY]: 'not json' }), NOW)).toBeNull();
    expect(loadSession(fakeStore({ [SESSION_KEY]: '[]' }), NOW)).toBeNull();
    expect(loadSession(null, NOW)).toBeNull();
  });

  it('discards the whole snapshot when one set is unreadable', () => {
    // Rather than resuming a session quietly missing its second set, which the
    // operator has no way to notice.
    const store = fakeStore();
    saveSession(store, { ...snapshot, sets: [aSet(), aSet({ id: 'set-2' })] }, NOW);
    const raw = JSON.parse(store.getItem(SESSION_KEY) ?? '{}') as { sets: unknown[] };
    raw.sets[1] = { id: 'set-2' };
    store.setItem(SESSION_KEY, JSON.stringify(raw));

    expect(loadSession(store, NOW)).toBeNull();
  });

  it('keeps a null bodyweight and a null selection distinct from a missing field', () => {
    const store = fakeStore();
    saveSession(store, { ...snapshot, bodyweightKg: null, currentExerciseId: null }, NOW);

    const loaded = loadSession(store, NOW);
    expect(loaded?.bodyweightKg).toBeNull();
    expect(loaded?.currentExerciseId).toBeNull();
  });

  it('clears', () => {
    const store = fakeStore();
    saveSession(store, snapshot, NOW);
    clearSession(store);

    expect(loadSession(store, NOW)).toBeNull();
  });

  it('does nothing at all without a store', () => {
    expect(() => {
      saveSession(null, snapshot, NOW);
      clearSession(null);
    }).not.toThrow();
  });
});

describe('the rest clock', () => {
  it('restores a rest that is still running', () => {
    const store = fakeStore();
    saveRest(store, { startedAt: NOW, target: 90 });

    expect(loadRest(store, NOW + 30_000)).toEqual({ startedAt: NOW, target: 90 });
  });

  it('restores a rest that has overrun, because that is the useful reading', () => {
    const store = fakeStore();
    saveRest(store, { startedAt: NOW, target: 90 });

    expect(loadRest(store, NOW + 120_000)?.target).toBe(90);
  });

  it('refuses a clock from a tab reopened after lunch', () => {
    const store = fakeStore();
    saveRest(store, { startedAt: NOW, target: 90 });

    expect(loadRest(store, NOW + 90_000 + REST_STALE_AFTER_MS + 1)).toBeNull();
  });

  it('refuses a clock that starts in the future', () => {
    const store = fakeStore();
    saveRest(store, { startedAt: NOW + 5_000, target: 90 });

    expect(loadRest(store, NOW)).toBeNull();
  });

  it('refuses a nonsensical target', () => {
    expect(loadRest(fakeStore({ [REST_KEY]: JSON.stringify({ startedAt: NOW, target: 0 }) }), NOW)).toBeNull();
    expect(loadRest(fakeStore({ [REST_KEY]: JSON.stringify({ startedAt: NOW }) }), NOW)).toBeNull();
    expect(loadRest(fakeStore({ [REST_KEY]: '{' }), NOW)).toBeNull();
  });
});

describe('recent movements', () => {
  it('puts the most recently chosen first', () => {
    const store = fakeStore();
    rememberExerciseId(store, 'ex-1');
    rememberExerciseId(store, 'ex-2');

    expect(loadRecentExerciseIds(store)).toEqual(['ex-2', 'ex-1']);
  });

  it('promotes rather than duplicates a movement returned to mid-session', () => {
    const store = fakeStore();
    rememberExerciseId(store, 'ex-1');
    rememberExerciseId(store, 'ex-2');

    expect(rememberExerciseId(store, 'ex-1')).toEqual(['ex-1', 'ex-2']);
  });

  it('is bounded, so the picker never becomes the library with extra steps', () => {
    const store = fakeStore();
    for (let index = 0; index < MAX_RECENT_EXERCISES + 5; index += 1) {
      rememberExerciseId(store, `ex-${String(index)}`);
    }

    expect(loadRecentExerciseIds(store)).toHaveLength(MAX_RECENT_EXERCISES);
  });

  it('ignores entries that are not strings', () => {
    expect(loadRecentExerciseIds(fakeStore({ 'naitikos.gym.recent.v1': '[1,"ex-1",null]' }))).toEqual(['ex-1']);
    expect(loadRecentExerciseIds(fakeStore({ 'naitikos.gym.recent.v1': '{}' }))).toEqual([]);
    expect(loadRecentExerciseIds(null)).toEqual([]);
  });
});
