/**
 * The event bus: publish, dispatch, idempotency, dead-lettering, replay.
 *
 * These tests are the reason the bus is pure. §5.2 forbids a second scheduler,
 * so dispatch happens in-process immediately after the append commits — which
 * means the ordering guarantee, the retry budget, and the ledger gate are all
 * properties of *this* code rather than of a queue's semantics. If they are not
 * asserted here they are not asserted anywhere.
 *
 * The fake store below is not a stub. It reproduces the two behaviours the real
 * one is obliged to have — a server-assigned monotonic sequence, and idempotency
 * on `eventId` — because every ordering test in this file is meaningless against
 * a store that does not.
 */

import { describe, expect, it } from 'vitest';
import type { Result } from '@naitikos/shared';
import { err, isErr, isOk, ok } from '@naitikos/shared';

import type { DomainError } from '../errors/domain-error';
import { validationError } from '../errors/domain-error';
import { fixedClock } from '../temporal/clock';
import { createEventBus } from './bus';
import type { DeadLetterEntry, DeadLetterSink, EventHandler, EventStore, HandledLedger } from './bus';
import type { DomainEvent, EventDraft, EventId, EventSequence, UnsequencedEvent } from './envelope';

const NOW = new Date('2026-08-03T18:30:00Z');

/* =========================================================================
 * Fakes
 * ====================================================================== */

/**
 * In-memory `EventStore`.
 *
 * Two contract behaviours are modelled deliberately:
 *
 *  - **Monotonic sequence, assigned here.** Never derived from `occurredAt`, so
 *    a backdated event still sorts after everything already accepted.
 *  - **Idempotent on `eventId`.** A re-append returns the stored copy. §5.7
 *    replays the outbox freely, so a store without this would make every
 *    duplicate a second row and every test of the dedupe path a lie.
 */
class FakeStore implements EventStore {
  readonly rows: DomainEvent[] = [];
  readCalls = 0;
  private nextSequence = 1;

  append(events: readonly UnsequencedEvent[]): Promise<Result<readonly DomainEvent[], DomainError>> {
    const stored: DomainEvent[] = [];

    for (const event of events) {
      const existing = this.rows.find((row) => row.eventId === event.eventId);
      if (existing !== undefined) {
        stored.push(existing);
        continue;
      }

      const row: DomainEvent = {
        ...event,
        createdAt: NOW.toISOString(),
        sequence: this.nextSequence as EventSequence,
      };
      this.nextSequence += 1;
      this.rows.push(row);
      stored.push(row);
    }

    return Promise.resolve(ok(stored));
  }

  read(options: {
    readonly afterSequence?: number;
    readonly limit: number;
    readonly types?: readonly DomainEvent['eventType'][];
  }): Promise<Result<readonly DomainEvent[], DomainError>> {
    this.readCalls += 1;
    const after = options.afterSequence ?? 0;

    const page = this.rows
      .filter((row) => (row.sequence ?? 0) > after)
      .filter((row) => options.types === undefined || options.types.includes(row.eventType))
      .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
      .slice(0, options.limit);

    return Promise.resolve(ok(page));
  }

  has(eventId: EventId): Promise<Result<boolean, DomainError>> {
    return Promise.resolve(ok(this.rows.some((row) => row.eventId === eventId)));
  }
}

class FakeLedger implements HandledLedger {
  private readonly marks = new Set<string>();

  wasHandled(eventId: EventId, handlerName: string): Promise<boolean> {
    return Promise.resolve(this.marks.has(`${eventId}:${handlerName}`));
  }

  markHandled(eventId: EventId, handlerName: string): Promise<void> {
    this.marks.add(`${eventId}:${handlerName}`);
    return Promise.resolve();
  }

  size(): number {
    return this.marks.size;
  }
}

class FakeDeadLetter implements DeadLetterSink {
  readonly entries: DeadLetterEntry[] = [];

  record(entry: DeadLetterEntry): Promise<void> {
    this.entries.push(entry);
    return Promise.resolve();
  }
}

/** Sequential ids, so assertions can name them. */
function counterIds(prefix = 'id'): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `${prefix}-${String(n)}`;
  };
}

type Harness = {
  readonly store: FakeStore;
  readonly ledger: FakeLedger;
  readonly deadLetter: FakeDeadLetter;
  readonly bus: ReturnType<typeof createEventBus>;
};

function harness(options: { maxAttempts?: number } = {}): Harness {
  const store = new FakeStore();
  const ledger = new FakeLedger();
  const deadLetter = new FakeDeadLetter();

  const bus = createEventBus({
    store,
    ledger,
    deadLetter,
    clock: fixedClock(NOW),
    newId: counterIds(),
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
  });

  return { store, ledger, deadLetter, bus };
}

/** A recording handler. `seen` is what the assertions read. */
function recorder(
  name: string,
  handles: readonly DomainEvent['eventType'][],
  options: {
    isIdempotent?: boolean;
    failTimes?: number;
    throwAlways?: boolean;
    onHandle?: (event: DomainEvent) => Promise<void>;
  } = {},
): EventHandler & { readonly seen: DomainEvent[]; attempts: number } {
  let failuresLeft = options.failTimes ?? 0;

  const handler = {
    name,
    handles,
    ...(options.isIdempotent === undefined ? {} : { isIdempotent: options.isIdempotent }),
    seen: [] as DomainEvent[],
    attempts: 0,
    async handle(event: DomainEvent): Promise<Result<void, DomainError>> {
      handler.attempts += 1;

      if (options.throwAlways === true) {
        throw new Error('handler exploded');
      }

      if (failuresLeft > 0) {
        failuresLeft -= 1;
        return err(validationError('handler_transient', 'Transient failure.'));
      }

      if (options.onHandle !== undefined) await options.onHandle(event);

      handler.seen.push(event);
      return ok(undefined);
    },
  };

  return handler;
}

function draft(overrides: Partial<EventDraft> = {}): EventDraft {
  return {
    eventType: 'Medication.Taken',
    occurredAt: '2026-08-03T08:00:00Z',
    actorId: 'sub-1',
    source: 'user',
    subject: { type: 'medication_log', id: 'log-1' },
    payload: { medicationId: 'med-1', substanceLabel: 'Venlafaxine XR' },
    ...overrides,
  } as EventDraft;
}

/* =========================================================================
 * Sealing
 * ====================================================================== */

describe('publish — sealing a draft', () => {
  it('fills every envelope field the caller has no business choosing', async () => {
    const { bus } = harness();

    const result = await bus.publish([draft()]);
    if (isErr(result)) throw new Error('expected ok');

    const [event] = result.value.events;
    expect(event).toBeDefined();
    if (event === undefined) return;

    // Server- and emitter-assigned. A caller-supplied `createdAt` would let a
    // client claim the server accepted something at a time it did not.
    expect(event.eventId).toBe('id-2');
    expect(event.capturedAt).toBe(NOW.toISOString());
    expect(event.createdAt).toBe(NOW.toISOString());
    expect(event.sequence).toBe(1);

    // Caller-supplied, preserved exactly.
    expect(event.occurredAt).toBe('2026-08-03T08:00:00Z');
    expect(event.actorId).toBe('sub-1');
    expect(event.source).toBe('user');
    expect(event.subject).toEqual({ type: 'medication_log', id: 'log-1' });

    // Defaults.
    expect(event.version).toBe(1);
    expect(event.causationId).toBeNull();
    expect(event.metadata).toEqual({});
  });

  it('gives one publish call one correlation id, so a Daily Close groups', async () => {
    const { bus } = harness();

    const result = await bus.publish([
      draft(),
      draft({ eventType: 'Mood.Logged', payload: { metricKey: 'mind.mood' } }),
      draft({ eventType: 'Journal.Created', payload: { hasPrompt: true } }),
    ]);
    if (isErr(result)) throw new Error('expected ok');

    const ids = new Set(result.value.events.map((event) => event.correlationId));
    // The whole point: §3.2's "single day, fully expanded" view groups on this,
    // and a dozen distinct ids would render a Close as a dozen unrelated rows.
    expect(ids.size).toBe(1);
  });

  it('separate publish calls get separate correlation ids', async () => {
    const { bus } = harness();

    const first = await bus.publish([draft()]);
    const second = await bus.publish([draft({ subject: { type: 'medication_log', id: 'log-2' } })]);
    if (isErr(first) || isErr(second)) throw new Error('expected ok');

    expect(first.value.events[0]?.correlationId).not.toBe(second.value.events[0]?.correlationId);
  });

  it('honours a caller-supplied correlation id', async () => {
    const { bus } = harness();

    const result = await bus.publish([draft({ correlationId: 'close-2026-08-03' as never })]);
    if (isErr(result)) throw new Error('expected ok');

    expect(result.value.events[0]?.correlationId).toBe('close-2026-08-03');
  });

  it('rejects an unregistered event type without appending', async () => {
    const { bus, store } = harness();

    const result = await bus.publish([draft({ eventType: 'Nope.Happened' as never })]);

    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe('unknown_event_type');
    expect(store.rows).toHaveLength(0);
  });

  it('rejects the whole batch when one payload is invalid', async () => {
    const { bus, store } = harness();

    const result = await bus.publish([
      draft(),
      // An authoritative value smuggled into a payload. ADR 0005's rule, and the
      // reason `validateEventPayload` rejects unknown keys.
      // eslint-disable-next-line @naitikos/no-bare-quantity -- The violation under test. A bare measured value in an event payload is precisely what must be rejected here; expressing it as a Quantity would test a shape nobody would write by mistake.
      draft({ eventType: 'Weight.Logged', payload: { metricKey: 'body.weight', weightKg: 74.2 } as never }),
      draft({ eventType: 'Sleep.Recorded', payload: {} }),
    ]);

    expect(isErr(result)).toBe(true);
    // Atomic: the valid first draft is not appended either. A Daily Close that
    // half-committed would be worse than one that failed.
    expect(store.rows).toHaveLength(0);
  });
});

/* =========================================================================
 * Dispatch
 * ====================================================================== */

describe('publish — dispatch', () => {
  it('dispatches only after the append has committed', async () => {
    const { bus, store } = harness();
    let visibleDuringHandle: boolean | null = null;

    const handler = recorder('probe', ['Medication.Taken'], {
      isIdempotent: true,
      onHandle: async (event) => {
        const seen = await store.has(event.eventId);
        visibleDuringHandle = isOk(seen) ? seen.value : null;
      },
    });
    bus.register(handler);

    await bus.publish([draft()]);

    // A handler that ran before the commit could enqueue work for a row that is
    // then rolled back.
    expect(visibleDuringHandle).toBe(true);
  });

  it('invokes only handlers registered for the type, in registration order', async () => {
    const { bus } = harness();
    const order: string[] = [];

    const first = recorder('first', ['Medication.Taken'], {
      isIdempotent: true,
      onHandle: () => {
        order.push('first');
        return Promise.resolve();
      },
    });
    const second = recorder('second', ['Medication.Taken'], {
      isIdempotent: true,
      onHandle: () => {
        order.push('second');
        return Promise.resolve();
      },
    });
    const unrelated = recorder('unrelated', ['Workout.Completed'], { isIdempotent: true });

    bus.register(first);
    bus.register(second);
    bus.register(unrelated);

    await bus.publish([draft()]);

    expect(order).toEqual(['first', 'second']);
    expect(unrelated.seen).toHaveLength(0);
    expect(bus.handlersFor('Medication.Taken').map((h) => h.name)).toEqual(['first', 'second']);
  });

  it('refuses a duplicate handler name', () => {
    const { bus } = harness();
    bus.register(recorder('timeline.project', ['Medication.Taken']));

    // Names are ledger keys. Two handlers sharing one would each appear to have
    // processed the other's events.
    expect(() => bus.register(recorder('timeline.project', ['Mood.Logged']))).toThrow(
      /already registered/,
    );
  });

  it('a failing handler does not fail the publish', async () => {
    const { bus, store, deadLetter } = harness({ maxAttempts: 2 });
    bus.register(recorder('broken', ['Medication.Taken'], { failTimes: 99 }));

    const result = await bus.publish([draft()]);

    // §5.12: "Failure never loses user input." The dose was taken; a broken
    // projection must not reject it.
    expect(isOk(result)).toBe(true);
    expect(store.rows).toHaveLength(1);
    if (isOk(result)) expect(result.value.failures).toHaveLength(1);
    expect(deadLetter.entries).toHaveLength(1);
    expect(deadLetter.entries[0]?.handlerName).toBe('broken');
    expect(deadLetter.entries[0]?.attempts).toBe(2);
  });

  it('retries and succeeds without dead-lettering', async () => {
    const { bus, deadLetter, ledger } = harness({ maxAttempts: 3 });
    const handler = recorder('flaky', ['Medication.Taken'], { failTimes: 2, isIdempotent: true });
    bus.register(handler);

    const result = await bus.publish([draft()]);

    expect(handler.attempts).toBe(3);
    expect(handler.seen).toHaveLength(1);
    expect(deadLetter.entries).toHaveLength(0);
    expect(ledger.size()).toBe(1);
    if (isOk(result)) expect(result.value.failures).toHaveLength(0);
  });

  it('captures a handler that throws instead of returning Err', async () => {
    const { bus, deadLetter } = harness({ maxAttempts: 1 });
    bus.register(recorder('thrower', ['Medication.Taken'], { throwAlways: true }));

    const result = await bus.publish([draft()]);

    expect(isOk(result)).toBe(true);
    expect(deadLetter.entries[0]?.error.code).toBe('handler_threw');
  });

  it('stops retrying at maxAttempts', async () => {
    const { bus } = harness({ maxAttempts: 2 });
    const handler = recorder('broken', ['Medication.Taken'], { failTimes: 99 });
    bus.register(handler);

    await bus.publish([draft()]);

    expect(handler.attempts).toBe(2);
  });
});

/* =========================================================================
 * Ordering
 * ====================================================================== */

describe('ordering', () => {
  it('assigns strictly increasing sequences across publishes', async () => {
    const { bus, store } = harness();

    await bus.publish([draft(), draft({ subject: { type: 'medication_log', id: 'log-2' } })]);
    await bus.publish([draft({ subject: { type: 'medication_log', id: 'log-3' } })]);

    const sequences = store.rows.map((row) => row.sequence);
    expect(sequences).toEqual([1, 2, 3]);

    // Gapless and total. §5.8's sync watermark and the timeline's keyset cursor
    // both read this, and a gap would silently strand every event after it.
    for (let i = 1; i < sequences.length; i += 1) {
      expect(sequences[i]).toBe((sequences[i - 1] ?? 0) + 1);
    }
  });

  it('replays in sequence order, not occurredAt order', async () => {
    const { bus, store } = harness();
    const seen: string[] = [];

    // The offline-drain case (§5.7): a batch captured in a gym basement lands
    // hours later carrying backdated `occurredAt` values.
    await bus.publish([draft({ occurredAt: '2026-08-03T08:00:00Z', subject: { type: 'x', id: 'recent' } })]);
    await bus.publish([draft({ occurredAt: '2026-07-01T08:00:00Z', subject: { type: 'x', id: 'backdated' } })]);

    const handler = recorder('order-probe', ['Medication.Taken'], {
      isIdempotent: true,
      onHandle: (event) => {
        seen.push(event.subject.id);
        return Promise.resolve();
      },
    });
    bus.register(handler);

    await bus.replay();

    // Acceptance order. A derivation must never run before the event it derives
    // from, and `occurredAt` cannot promise that.
    expect(seen).toEqual(['recent', 'backdated']);
    expect(store.rows.map((row) => row.sequence)).toEqual([1, 2]);
  });
});

/* =========================================================================
 * Idempotency and replay
 * ====================================================================== */

describe('replay', () => {
  async function seed(bus: Harness['bus'], count: number): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      await bus.publish([draft({ subject: { type: 'medication_log', id: `log-${String(i)}` } })]);
    }
  }

  it('re-dispatches an idempotent handler over the whole log', async () => {
    const { bus } = harness();
    await seed(bus, 3);

    const handler = recorder('projector', ['Medication.Taken'], { isIdempotent: true });
    bus.register(handler);

    const result = await bus.replay();
    if (isErr(result)) throw new Error('expected ok');

    expect(result.value.eventsRead).toBe(3);
    expect(result.value.handlersInvoked).toBe(3);
    expect(result.value.skipped).toBe(0);
    expect(result.value.lastSequence).toBe(3);
    expect(handler.seen).toHaveLength(3);
  });

  it('skips a non-idempotent handler that has already run', async () => {
    const { bus } = harness();
    const handler = recorder('side-effect', ['Medication.Taken']);
    bus.register(handler);

    // Ran once at publish time.
    await bus.publish([draft()]);
    expect(handler.seen).toHaveLength(1);

    const result = await bus.replay();
    if (isErr(result)) throw new Error('expected ok');

    // The default is non-idempotent, so forgetting to declare it fails safe.
    expect(handler.seen).toHaveLength(1);
    expect(result.value.skipped).toBe(1);
    expect(result.value.handlersInvoked).toBe(0);
  });

  it('ignoreLedger re-runs a non-idempotent handler, for a truncate-and-rebuild', async () => {
    const { bus } = harness();
    const handler = recorder('side-effect', ['Medication.Taken']);
    bus.register(handler);
    await bus.publish([draft()]);

    const result = await bus.replay({ ignoreLedger: true });
    if (isErr(result)) throw new Error('expected ok');

    // The ledger is right that the handler saw event 1, and irrelevant once the
    // table it wrote to has been truncated.
    expect(handler.seen).toHaveLength(2);
    expect(result.value.skipped).toBe(0);
  });

  it('pages rather than loading the whole log', async () => {
    const { bus, store } = harness();
    await seed(bus, 5);
    store.readCalls = 0;

    const handler = recorder('projector', ['Medication.Taken'], { isIdempotent: true });
    bus.register(handler);

    const result = await bus.replay({ batchSize: 2 });
    if (isErr(result)) throw new Error('expected ok');

    // 2 + 2 + 1 — the short final page ends the loop without an extra read.
    expect(store.readCalls).toBe(3);
    expect(result.value.eventsRead).toBe(5);
    // Exactly once each. A paging cursor bug shows up here as a duplicate.
    expect(handler.seen.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5]);
  });

  it('resumes from a cursor', async () => {
    const { bus } = harness();
    await seed(bus, 4);

    const handler = recorder('projector', ['Medication.Taken'], { isIdempotent: true });
    bus.register(handler);

    const result = await bus.replay({ afterSequence: 2 });
    if (isErr(result)) throw new Error('expected ok');

    expect(handler.seen.map((e) => e.sequence)).toEqual([3, 4]);
    expect(result.value.eventsRead).toBe(2);
  });

  it('restricts to named handlers, for rebuilding one projection', async () => {
    const { bus } = harness();
    await seed(bus, 2);

    const wanted = recorder('timeline.project', ['Medication.Taken'], { isIdempotent: true });
    const other = recorder('adherence.recount', ['Medication.Taken'], { isIdempotent: true });
    bus.register(wanted);
    bus.register(other);

    await bus.replay({ handlerNames: ['timeline.project'] });

    expect(wanted.seen).toHaveLength(2);
    expect(other.seen).toHaveLength(0);
  });

  it('restricts to event types', async () => {
    const { bus } = harness();
    await bus.publish([draft()]);
    await bus.publish([draft({ eventType: 'Mood.Logged', payload: { metricKey: 'mind.mood' } })]);

    const meds = recorder('meds', ['Medication.Taken'], { isIdempotent: true });
    const mood = recorder('mood', ['Mood.Logged'], { isIdempotent: true });
    bus.register(meds);
    bus.register(mood);

    await bus.replay({ types: ['Mood.Logged'] });

    expect(meds.seen).toHaveLength(0);
    expect(mood.seen).toHaveLength(1);
  });

  it('dead-letters during replay without aborting the run', async () => {
    const { bus, deadLetter } = harness({ maxAttempts: 1 });
    await seed(bus, 3);

    bus.register(recorder('broken', ['Medication.Taken'], { failTimes: 99, isIdempotent: true }));

    const result = await bus.replay();
    if (isErr(result)) throw new Error('expected ok');

    // All three read, all three failed, run still completed. A rebuild that
    // stopped on the first bad row would need a manual cursor to resume.
    expect(result.value.eventsRead).toBe(3);
    expect(result.value.failures).toHaveLength(3);
    expect(deadLetter.entries).toHaveLength(3);
  });

  it('is a no-op on an empty log', async () => {
    const { bus } = harness();
    const result = await bus.replay();
    if (isErr(result)) throw new Error('expected ok');

    expect(result.value.eventsRead).toBe(0);
    expect(result.value.lastSequence).toBeNull();
  });
});

/* =========================================================================
 * Store-level idempotency
 * ====================================================================== */

describe('idempotency on eventId', () => {
  it('re-appending a stored event returns the stored copy, not a duplicate', async () => {
    const store = new FakeStore();
    const first = await store.append([
      {
        eventId: 'evt-1' as EventId,
        eventType: 'Medication.Taken',
        occurredAt: '2026-08-03T08:00:00Z',
        capturedAt: '2026-08-03T08:00:01Z',
        actorId: 'sub-1',
        source: 'user',
        version: 1,
        subject: { type: 'medication_log', id: 'log-1' },
        payload: { medicationId: 'med-1', substanceLabel: 'Venlafaxine XR' },
        correlationId: 'corr-1' as never,
        causationId: null,
        metadata: {},
      },
    ]);
    if (isErr(first)) throw new Error('expected ok');

    const replayed = await store.append([
      { ...(first.value[0] as DomainEvent) } as UnsequencedEvent,
    ]);
    if (isErr(replayed)) throw new Error('expected ok');

    expect(store.rows).toHaveLength(1);
    // Same sequence: the outbox replaying a request must not shift the event's
    // position in history.
    expect(replayed.value[0]?.sequence).toBe(1);
  });
});
