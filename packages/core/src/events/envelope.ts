/**
 * The event envelope.
 *
 * Every domain event in the system has exactly this shape. The payload varies by
 * type; nothing else does.
 *
 * See [ADR 0005](../../../../docs/adr/0005-domain-events-as-integration-log.md)
 * for what this log is and — more importantly — what it is not. The one-line
 * version: **events reference, they do not restate.** An event says a workout
 * was completed and points at the row; it does not carry the sets.
 */

import type { Brand } from '@naitikos/shared';

import type { EventPayloadMap, EventType } from './registry';

/** Opaque identifiers, branded so they cannot be swapped for each other. */
export type EventId = Brand<string, 'EventId'>;
export type CorrelationId = Brand<string, 'CorrelationId'>;

/**
 * A monotonic per-store sequence number.
 *
 * Assigned by the database on append, never by the client. This is the ordering
 * §5.8's sync watermark reads and the cursor the timeline paginates on — and it
 * must be gapless and total, which only a single writer can guarantee.
 *
 * Deliberately *not* the UUIDv7 timestamp: those are client-generated (§5.7) and
 * a phone with a wrong clock would order itself incorrectly relative to
 * everything else.
 */
export type EventSequence = Brand<number, 'EventSequence'>;

/**
 * Where an event came from.
 *
 * Mirrors §9.2's `observation_source` vocabulary, because the same distinction
 * matters for the same reason: "A derived value must be distinguishable from a
 * measured one forever, and a model-inferred value must be distinguishable from
 * both."
 */
export const EVENT_SOURCES = [
  'user',
  'device_import',
  'derivation',
  'document_extraction',
  'model_inference',
  'system',
] as const;

export type EventSource = (typeof EVENT_SOURCES)[number];

/**
 * The row an event is about.
 *
 * Polymorphic and required. §9.3(3) makes the same choice for `observation`'s
 * subject and explains it: enforcement is by application-level validation
 * "rather than by database polymorphism, which Postgres handles badly".
 *
 * Required rather than optional, unlike the observation subject — an event with
 * no subject is an event that cannot be traced back to what it describes, which
 * defeats ADR 0005's reference rule.
 */
export type EventSubject = {
  /** Table or logical entity name: `workout_session`, `medication`, `profile`. */
  readonly type: string;
  readonly id: string;
};

/**
 * Non-domain context.
 *
 * Deliberately narrow, and §5.11's rule is why: "Event names and numeric
 * measurements only. **No payloads, ever.** The schema cannot represent user
 * content, which makes leakage impossible rather than prohibited." The same
 * applies here — `metadata` is not a spare field for whatever a caller has to
 * hand.
 */
export type EventMetadata = {
  /** Correlates with the request that produced it (§5.13). */
  readonly traceId?: string;
  /** Which device, for §5.8's per-device reconciliation. */
  readonly deviceId?: string;
  /** IANA zone the action happened in (§5.3). Never an offset. */
  readonly zone?: string;
  /** Schema version of the client that emitted it (§5.8 negotiation). */
  readonly clientSchemaVersion?: string;
  /** Hybrid logical clock, for offline causal ordering (§5.7(3)). */
  readonly hlc?: string;
};

/**
 * A domain event.
 *
 * ## The four timestamps, and why each exists
 *
 * They collapse into one another most of the time, and the cases where they
 * diverge are the cases that matter:
 *
 * | Field | Meaning | Diverges when |
 * |---|---|---|
 * | `occurredAt` | When the thing happened in the world | Backdating a missed dose |
 * | `capturedAt` | When the user told the device | Logging offline in a gym |
 * | `createdAt` | When the server accepted it | The outbox drains hours later |
 * | `sequence` | Server-assigned total order | Always — it is not a time |
 *
 * §9.5 makes the same argument for the clinical domain: "A lab drawn on 12
 * March, reported on 19 March, entered on 24 March is three different dates, all
 * of them true, all of them sometimes the one that matters." Collapsing them
 * produces a record that quietly lies about when things were known.
 */
export type DomainEvent<T extends EventType = EventType> = {
  readonly eventId: EventId;
  readonly eventType: T;

  /** When it happened in the world. Supplied by the caller. */
  readonly occurredAt: string;
  /** When the client recorded it. */
  readonly capturedAt: string;
  /** When the server accepted it. Server-assigned. */
  readonly createdAt: string;

  /**
   * Who acted.
   *
   * The auth subject id (§5.4), or a `system:*` pseudo-actor for derivations.
   * Never null: an event with no actor cannot be audited, and §9.4 treats the
   * actor as part of the record.
   */
  readonly actorId: string;
  readonly source: EventSource;

  /**
   * Payload schema version for this event type.
   *
   * Starts at 1. Incremented when the payload shape changes incompatibly, and
   * every prior version must remain readable — see `migrate.ts`. Events are
   * never rewritten, so an event written in 2027 at v1 is still a v1 event in
   * 2039.
   */
  readonly version: number;

  /** The row this event is about. */
  readonly subject: EventSubject;

  /**
   * Type-specific facts.
   *
   * **References, never authoritative values** (ADR 0005). Enough for a timeline
   * row and a job router to act without a join; nothing a reader would trust as
   * the number.
   */
  readonly payload: EventPayloadMap[T];

  /**
   * The user action this event belongs to.
   *
   * One Daily Close produces a dozen events sharing one `correlationId`. It is
   * what turns a flat log into "what did I do at 22:14 last Tuesday", and it is
   * the field §9.4's `traceId` cannot provide because a trace is a request, not
   * an intent.
   */
  readonly correlationId: CorrelationId;

  /**
   * The event that caused this one. `null` for a user-initiated root.
   *
   * A derivation emitted in response to `SetLogged` carries that event's id.
   * Without it, a replay cannot distinguish an event the user created from one
   * the system inferred, and re-running handlers would duplicate derived work.
   */
  readonly causationId: EventId | null;

  readonly metadata: EventMetadata;

  /** Server-assigned total order. Absent until appended. */
  readonly sequence?: EventSequence;
};

/** An event before the store has accepted it. */
export type UnsequencedEvent<T extends EventType = EventType> = Omit<
  DomainEvent<T>,
  'createdAt' | 'sequence'
>;

/**
 * What a caller supplies to emit an event.
 *
 * The envelope fields a caller has no business choosing — `eventId`,
 * `capturedAt`, `createdAt`, `sequence` — are filled by the emitter. That is not
 * convenience: a caller-supplied `createdAt` would let a client claim the server
 * accepted something at a time it did not.
 */
export type EventDraft<T extends EventType = EventType> = {
  readonly eventType: T;
  readonly occurredAt: string;
  readonly actorId: string;
  readonly source: EventSource;
  readonly subject: EventSubject;
  readonly payload: EventPayloadMap[T];
  readonly correlationId?: CorrelationId;
  readonly causationId?: EventId | null;
  readonly metadata?: EventMetadata;
};

/* -------------------------------------------------------------------------
 * Guards
 * ---------------------------------------------------------------------- */

export function isEventSource(value: unknown): value is EventSource {
  return typeof value === 'string' && (EVENT_SOURCES as readonly string[]).includes(value);
}

/**
 * Order two events deterministically.
 *
 * `sequence` when both have one — it is total and gapless. Otherwise
 * `occurredAt`, then `eventId` as the final tiebreak so the ordering is stable
 * across runs rather than depending on array order. A sort that is not total is
 * a replay that produces different results on different days.
 */
export function compareEvents(a: DomainEvent, b: DomainEvent): number {
  if (a.sequence !== undefined && b.sequence !== undefined) {
    return a.sequence - b.sequence;
  }
  if (a.occurredAt !== b.occurredAt) {
    return a.occurredAt < b.occurredAt ? -1 : 1;
  }
  return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
}
