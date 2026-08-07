/**
 * Event version migration.
 *
 * ## Why these tests use a synthetic upcaster table
 *
 * `UPCASTERS` is empty and every registered type is at v1, so `upcast` can only
 * exercise its identity path today. The chain logic — sequencing, gap detection,
 * the incomplete-chain refusal — would ship untested and first execute during the
 * very version bump it exists to protect, under time pressure, against data that
 * cannot be re-created.
 *
 * So these drive `upcastWith` with a fabricated table. The scenarios below are
 * the ones a real bump will hit: one step, three steps, a missing middle step,
 * and an event from a build newer than the reader.
 *
 * The `migrate.ts` docblock asks whoever adds the first real upcaster to add a
 * case here with a realistic old payload. That instruction is the point of this
 * file existing before there is anything to migrate.
 */

import { describe, expect, it } from 'vitest';
import { isErr, isOk } from '@naitikos/shared';

import type { DomainEvent, EventId, EventSequence } from './envelope';
import type { Upcaster } from './migrate';
import { UPCASTERS, upcast, upcastAll, upcastWith } from './migrate';
import { EVENT_TYPES, currentVersion } from './registry';

function event(overrides: Partial<DomainEvent> = {}): DomainEvent {
  return {
    eventId: 'evt-1' as EventId,
    eventType: 'Workout.Completed',
    occurredAt: '2026-08-03T18:00:00Z',
    capturedAt: '2026-08-03T18:05:00Z',
    createdAt: '2026-08-03T18:05:01Z',
    actorId: 'sub-1',
    source: 'user',
    version: 1,
    subject: { type: 'workout_session', id: 'session-1' },
    payload: { setCount: 12, exerciseCount: 4 },
    correlationId: 'corr-1' as never,
    causationId: null,
    metadata: {},
    sequence: 1 as EventSequence,
    ...overrides,
  } as DomainEvent;
}

/** The worked example from `migrate.ts`, made real for the tests. */
const SPLIT_SET_COUNT: Upcaster = {
  eventType: 'Workout.Completed',
  fromVersion: 1,
  describe: 'v2 splits setCount into workingSetCount + warmupSetCount.',
  upcast: (payload) => {
    const old = payload as { setCount: number; exerciseCount: number };
    return {
      workingSetCount: old.setCount,
      warmupSetCount: 0,
      exerciseCount: old.exerciseCount,
      // Recording that the value IS a guess is the load-bearing part: a detector
      // reading this in 2031 must not treat it as observed.
      isUpcastEstimate: true,
    };
  },
};

const ADD_PROGRAM_REFERENCE: Upcaster = {
  eventType: 'Workout.Completed',
  fromVersion: 2,
  describe: 'v3 adds a programId reference.',
  upcast: (payload) => ({ ...(payload as Record<string, unknown>), programId: null }),
};

const RENAME_ESTIMATE_FLAG: Upcaster = {
  eventType: 'Workout.Completed',
  fromVersion: 3,
  describe: 'v4 renames isUpcastEstimate to isEstimated.',
  upcast: (payload) => {
    const { isUpcastEstimate, ...rest } = payload as Record<string, unknown>;
    return { ...rest, isEstimated: isUpcastEstimate ?? false };
  },
};

/* =========================================================================
 * Today's state
 * ====================================================================== */

describe('the current registry', () => {
  it('has no upcasters, because every type is at version 1', () => {
    // If this fails, a version was bumped. Check that the bump shipped an
    // upcaster and a test case here — see the file header.
    expect(UPCASTERS).toHaveLength(0);
    for (const type of EVENT_TYPES) {
      expect(currentVersion(type), `${type} is past v1; add an upcaster and a case`).toBe(1);
    }
  });

  it('passes a current-version event through unchanged', () => {
    const original = event();
    const result = upcast(original);
    if (isErr(result)) throw new Error('expected ok');

    // Identity, not a copy with the same fields: nothing to do means nothing done.
    expect(result.value).toBe(original);
  });
});

/* =========================================================================
 * Upcasting
 * ====================================================================== */

describe('upcasting a chain', () => {
  it('applies one step', () => {
    const result = upcastWith(event({ version: 1 }), [SPLIT_SET_COUNT], 2);
    if (isErr(result)) throw new Error('expected ok');

    expect(result.value.version).toBe(2);
    expect(result.value.payload).toEqual({
      workingSetCount: 12,
      warmupSetCount: 0,
      exerciseCount: 4,
      isUpcastEstimate: true,
    });
  });

  it('chains three steps in version order regardless of table order', () => {
    // Declaration order in the table is not a contract — a maintainer appending
    // the newest upcaster at the top must not silently reorder the chain.
    const shuffled = [RENAME_ESTIMATE_FLAG, SPLIT_SET_COUNT, ADD_PROGRAM_REFERENCE];

    const result = upcastWith(event({ version: 1 }), shuffled, 4);
    if (isErr(result)) throw new Error('expected ok');

    expect(result.value.version).toBe(4);
    expect(result.value.payload).toEqual({
      workingSetCount: 12,
      warmupSetCount: 0,
      exerciseCount: 4,
      programId: null,
      isEstimated: true,
    });
  });

  it('starts mid-chain for an event written at an intermediate version', () => {
    const stored = event({ version: 3, payload: { workingSetCount: 9, isUpcastEstimate: false } as never });

    const result = upcastWith(stored, [SPLIT_SET_COUNT, ADD_PROGRAM_REFERENCE, RENAME_ESTIMATE_FLAG], 4);
    if (isErr(result)) throw new Error('expected ok');

    // Only the v3→v4 step ran. Re-running v1→v2 on a v3 payload would corrupt it.
    expect(result.value.payload).toEqual({ workingSetCount: 9, isEstimated: false });
  });

  it('leaves the envelope untouched', () => {
    const original = event({ version: 1 });
    const result = upcastWith(original, [SPLIT_SET_COUNT], 2);
    if (isErr(result)) throw new Error('expected ok');

    // Only `version` and `payload` may change. An upcaster that could rewrite
    // `occurredAt` or `actorId` would be a rewrite of history, which is what §9.1
    // exists to prevent.
    expect(result.value.eventId).toBe(original.eventId);
    expect(result.value.occurredAt).toBe(original.occurredAt);
    expect(result.value.capturedAt).toBe(original.capturedAt);
    expect(result.value.createdAt).toBe(original.createdAt);
    expect(result.value.actorId).toBe(original.actorId);
    expect(result.value.sequence).toBe(original.sequence);
    expect(result.value.correlationId).toBe(original.correlationId);
  });

  it('does not mutate the stored event', () => {
    const original = event({ version: 1 });
    upcastWith(original, [SPLIT_SET_COUNT], 2);

    // The row is immutable (migration 0006 enforces it in the database); the
    // in-memory copy must behave the same or a replay would see a mutated payload
    // on its second pass.
    expect(original.version).toBe(1);
    expect(original.payload).toEqual({ setCount: 12, exerciseCount: 4 });
  });

  it('ignores upcasters for other event types', () => {
    const foreign: Upcaster = {
      eventType: 'Mood.Logged',
      fromVersion: 1,
      describe: 'irrelevant',
      upcast: () => ({ destroyed: true }),
    };

    const result = upcastWith(event({ version: 1 }), [foreign, SPLIT_SET_COUNT], 2);
    if (isErr(result)) throw new Error('expected ok');
    expect(result.value.payload).not.toEqual({ destroyed: true });
  });
});

/* =========================================================================
 * Failing closed
 * ====================================================================== */

describe('refusing rather than guessing', () => {
  it('refuses an event from a newer build', () => {
    // §5.8: "Over twenty years there will be a stale phone in a drawer." Same for
    // a rolled-back server reading what a newer deploy wrote. Guessing at a future
    // payload shape would corrupt the projection silently.
    const result = upcast(event({ version: 7 }));

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.kind).toBe('precondition_failed');
      expect(result.error.code).toBe('event_from_future');
      expect(result.error.message).toContain('Deploy the newer build');
    }
  });

  it('refuses a chain with a gap', () => {
    // v1 → v2 exists, v2 → v3 is missing, target is v3. Skipping the missing step
    // and handing a handler a v2 payload labelled v3 is the worst option.
    const result = upcastWith(event({ version: 1 }), [SPLIT_SET_COUNT, RENAME_ESTIMATE_FLAG], 4);

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe('upcaster_missing');
      expect(result.error.message).toContain('gap');
    }
  });

  it('refuses when the chain runs out before the target version', () => {
    const result = upcastWith(event({ version: 1 }), [SPLIT_SET_COUNT], 3);

    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe('upcaster_incomplete');
  });

  it('refuses when there are no upcasters at all but versions differ', () => {
    const result = upcastWith(event({ version: 1 }), [], 2);
    expect(isErr(result)).toBe(true);
  });
});

/* =========================================================================
 * Batches
 * ====================================================================== */

describe('upcastAll', () => {
  it('passes a batch of current-version events through', () => {
    const result = upcastAll([event(), event({ eventId: 'evt-2' as EventId })]);
    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value).toHaveLength(2);
  });

  it('fails the batch on the first unmigratable event', () => {
    // A page of a replay is all-or-nothing. Projecting the readable half would
    // leave the projection silently incomplete with no record of which rows were
    // dropped.
    const result = upcastAll([event(), event({ eventId: 'evt-2' as EventId, version: 9 })]);

    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe('event_from_future');
  });

  it('accepts an empty batch', () => {
    const result = upcastAll([]);
    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value).toEqual([]);
  });
});
