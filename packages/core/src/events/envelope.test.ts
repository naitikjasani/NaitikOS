/**
 * The envelope: source vocabulary and the total ordering.
 *
 * `compareEvents` looks trivial and is not. A sort that is not *total* — one that
 * returns 0 for two distinct events — produces a different order on different
 * days depending on the input array's order, which means a replay in 2031 can
 * derive a different projection from the same log than the one in 2027 did. The
 * tiebreak chain exists for that, and this file is what keeps it.
 */

import { describe, expect, it } from 'vitest';

import type { DomainEvent, EventId, EventSequence } from './envelope';
import { EVENT_SOURCES, compareEvents, isEventSource } from './envelope';

function event(overrides: Partial<DomainEvent> = {}): DomainEvent {
  return {
    eventId: 'evt-1' as EventId,
    eventType: 'Weight.Logged',
    occurredAt: '2026-08-03T07:00:00Z',
    capturedAt: '2026-08-03T07:00:01Z',
    createdAt: '2026-08-03T07:00:02Z',
    actorId: 'sub-1',
    source: 'user',
    version: 1,
    subject: { type: 'observation', id: 'obs-1' },
    payload: { metricKey: 'body.weight' },
    correlationId: 'corr-1' as never,
    causationId: null,
    metadata: {},
    ...overrides,
  } as DomainEvent;
}

describe('event sources', () => {
  it('accepts the §9.2 vocabulary and nothing else', () => {
    for (const source of EVENT_SOURCES) {
      expect(isEventSource(source)).toBe(true);
    }
    expect(isEventSource('guessed')).toBe(false);
    expect(isEventSource('')).toBe(false);
    expect(isEventSource(null)).toBe(false);
  });

  it('distinguishes measured, derived, and inferred', () => {
    // §9.2's rule, and the reason this vocabulary is closed: "A derived value must
    // be distinguishable from a measured one forever, and a model-inferred value
    // must be distinguishable from both."
    expect(EVENT_SOURCES).toContain('user');
    expect(EVENT_SOURCES).toContain('derivation');
    expect(EVENT_SOURCES).toContain('model_inference');
  });
});

describe('compareEvents', () => {
  it('orders by sequence when both have one', () => {
    const earlier = event({ sequence: 1 as EventSequence, occurredAt: '2026-08-03T23:00:00Z' });
    const later = event({ eventId: 'evt-2' as EventId, sequence: 2 as EventSequence, occurredAt: '2026-07-01T01:00:00Z' });

    // Sequence wins even though `occurredAt` disagrees — the offline-drain case.
    expect(compareEvents(earlier, later)).toBeLessThan(0);
    expect(compareEvents(later, earlier)).toBeGreaterThan(0);
  });

  it('falls back to occurredAt when a sequence is missing', () => {
    const a = event({ occurredAt: '2026-08-01T00:00:00Z' });
    const b = event({ eventId: 'evt-2' as EventId, occurredAt: '2026-08-02T00:00:00Z' });

    expect(compareEvents(a, b)).toBeLessThan(0);
    expect(compareEvents(b, a)).toBeGreaterThan(0);
  });

  it('does not use a sequence unless both events have one', () => {
    // Comparing an appended event against an unappended one on sequence alone
    // would sort the unappended one to the start of history.
    const stored = event({ sequence: 5 as EventSequence, occurredAt: '2026-08-01T00:00:00Z' });
    const pending = event({ eventId: 'evt-2' as EventId, occurredAt: '2026-08-02T00:00:00Z' });

    expect(compareEvents(stored, pending)).toBeLessThan(0);
  });

  it('breaks a tie on eventId so the ordering is total', () => {
    const a = event({ eventId: 'evt-a' as EventId });
    const b = event({ eventId: 'evt-b' as EventId });

    expect(compareEvents(a, b)).toBeLessThan(0);
    expect(compareEvents(b, a)).toBeGreaterThan(0);
  });

  it('returns 0 only for the same event', () => {
    expect(compareEvents(event(), event())).toBe(0);
  });

  it('sorts identically regardless of input order', () => {
    // The property that actually matters: two replays of the same log produce the
    // same order.
    const events = [
      event({ eventId: 'evt-c' as EventId, occurredAt: '2026-08-02T00:00:00Z' }),
      event({ eventId: 'evt-a' as EventId, occurredAt: '2026-08-01T00:00:00Z' }),
      event({ eventId: 'evt-b' as EventId, occurredAt: '2026-08-01T00:00:00Z' }),
    ];

    const forward = [...events].sort(compareEvents).map((e) => e.eventId);
    const reversed = [...events].reverse().sort(compareEvents).map((e) => e.eventId);

    expect(forward).toEqual(['evt-a', 'evt-b', 'evt-c']);
    expect(reversed).toEqual(forward);
  });
});
