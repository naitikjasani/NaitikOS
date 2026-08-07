/**
 * The event bus.
 *
 * Pure. No database, no network, no timers — the store and the clock are ports.
 * §5.4's reasoning for putting authorization in a testable layer applies here
 * too: an event system you cannot replay in a unit test is an event system whose
 * ordering guarantees are aspirational.
 *
 * ## What this is not
 *
 * **Not a queue, and not asynchronous.** §5.2 permits "exactly one scheduled
 * entry point — a nightly job at 03:00 local", so there is no second scheduler
 * and no worker pool. Dispatch is synchronous and in-process, after the append
 * commits. Work that must be deferred is enqueued as a *job row* which the single
 * nightly runner drains — see `jobs/`.
 *
 * That is a real constraint, not a simplification. At n=1 with ~50 actions a day
 * there is no throughput problem to solve, and a queue would be a second piece of
 * infrastructure to operate against C3's "must survive three-week gaps in
 * attention".
 *
 * ## Handlers contain no business logic
 *
 * A handler translates and delegates: it reads the event, calls a domain service
 * or enqueues a job, and returns. §5.2 says the same of route handlers — "route
 * handlers are transport, not logic" — and the reason is identical. Logic inside
 * a handler is logic that only runs when an event fires, which means it cannot be
 * tested directly and cannot be reused by a code path that did not emit.
 */

import type { Result } from '@naitikos/shared';
import { err, isErr, ok } from '@naitikos/shared';

import type { DomainError } from '../errors/domain-error';
import { conflictError, validationError } from '../errors/domain-error';
import type { Clock } from '../temporal/clock';
import type {
  CorrelationId,
  DomainEvent,
  EventDraft,
  EventId,
  UnsequencedEvent,
} from './envelope';
import { currentVersion, isEventType, type EventType } from './registry';
import { validateEventPayload } from './validate';

/* =========================================================================
 * Ports
 * ====================================================================== */

/**
 * Where events are persisted.
 *
 * `append` assigns the sequence and must be atomic with the domain write that
 * caused it — ADR 0005 rule 2. The implementation takes a transaction.
 */
export type EventStore = {
  /**
   * Append events, returning them with sequences assigned.
   *
   * Must be idempotent on `eventId`: re-appending an event the store already has
   * returns the stored copy rather than a duplicate. §5.7 replays the outbox
   * freely, so this is load-bearing rather than defensive.
   */
  append(events: readonly UnsequencedEvent[]): Promise<Result<readonly DomainEvent[], DomainError>>;

  /** Read a page of events in sequence order, for replay. */
  read(options: {
    readonly afterSequence?: number;
    readonly limit: number;
    readonly types?: readonly EventType[];
  }): Promise<Result<readonly DomainEvent[], DomainError>>;

  /** Whether this event id has already been stored. */
  has(eventId: EventId): Promise<Result<boolean, DomainError>>;
};

/**
 * A handler for one or more event types.
 *
 * Returns `Result` rather than throwing: a handler failure is an expected
 * outcome that must be recorded and retried, not a crash (§5.12).
 */
export type EventHandler = {
  /**
   * Stable identifier, persisted in the dead-letter record and the
   * already-handled ledger. **Renaming one is a migration**, because the ledger
   * keys on it and a renamed handler will re-process the entire log.
   */
  readonly name: string;
  readonly handles: readonly EventType[];
  handle(event: DomainEvent): Promise<Result<void, DomainError>>;
  /**
   * Whether this handler is safe to run twice on the same event.
   *
   * `false` means the bus consults the ledger before invoking it. Default
   * `false` — the safe direction, because a handler that is wrongly assumed
   * idempotent double-writes on every replay.
   */
  readonly isIdempotent?: boolean;
};

/** Where handler failures go after retries are exhausted. */
export type DeadLetterSink = {
  record(entry: DeadLetterEntry): Promise<void>;
};

export type DeadLetterEntry = {
  readonly eventId: EventId;
  readonly eventType: EventType;
  readonly handlerName: string;
  readonly attempts: number;
  readonly error: DomainError;
  readonly failedAt: string;
};

/**
 * Tracks which handlers have already processed which events.
 *
 * Only consulted for non-idempotent handlers. Keeping it a port means replay in
 * a test can use a `Set`.
 */
export type HandledLedger = {
  wasHandled(eventId: EventId, handlerName: string): Promise<boolean>;
  markHandled(eventId: EventId, handlerName: string): Promise<void>;
};

export type BusDependencies = {
  readonly store: EventStore;
  readonly clock: Clock;
  readonly deadLetter: DeadLetterSink;
  readonly ledger: HandledLedger;
  /** Generates event ids. Injected so tests are deterministic. */
  readonly newId: () => string;
  /**
   * Attempts per handler before dead-lettering. Default 3.
   *
   * Retries are immediate and in-process — there is no backoff, because there is
   * no queue to back off into. A handler that fails for a transient reason will
   * usually succeed on the second synchronous attempt; one that fails three times
   * is broken and belongs in the dead-letter table where a human will see it.
   */
  readonly maxAttempts?: number;
};

/* =========================================================================
 * The bus
 * ====================================================================== */

export type PublishResult = {
  readonly events: readonly DomainEvent[];
  /** Handler failures that were dead-lettered. Publishing still succeeded. */
  readonly failures: readonly DeadLetterEntry[];
};

export type EventBus = {
  register(handler: EventHandler): void;
  /** Handlers registered for a type, in registration order. */
  handlersFor(type: EventType): readonly EventHandler[];

  /**
   * Emit one or more events atomically, then dispatch.
   *
   * Drafts are sealed into envelopes, validated, appended, and only then
   * dispatched. A validation failure rejects the whole batch — a Daily Close
   * that half-committed would be worse than one that failed.
   */
  publish(drafts: readonly EventDraft[]): Promise<Result<PublishResult, DomainError>>;

  /**
   * Re-dispatch persisted events through the current handlers.
   *
   * Rebuilds projections. Does **not** reconstruct entity state — ADR 0005
   * rule 3: the entity tables are the truth and were never derived from events.
   */
  replay(options?: ReplayOptions): Promise<Result<ReplaySummary, DomainError>>;
};

export type ReplayOptions = {
  readonly afterSequence?: number;
  readonly types?: readonly EventType[];
  readonly batchSize?: number;
  /** Only these handlers. For rebuilding one projection without re-running all. */
  readonly handlerNames?: readonly string[];
  /**
   * Ignore the handled ledger and re-run everything.
   *
   * Required when rebuilding a projection from scratch: the ledger says the
   * timeline handler already saw event 4,000, which is true and irrelevant if
   * the timeline table has just been truncated.
   */
  readonly ignoreLedger?: boolean;
};

export type ReplaySummary = {
  readonly eventsRead: number;
  readonly handlersInvoked: number;
  readonly skipped: number;
  readonly failures: readonly DeadLetterEntry[];
  /** Highest sequence processed, for resuming. */
  readonly lastSequence: number | null;
};

export function createEventBus(deps: BusDependencies): EventBus {
  const handlers = new Map<EventType, EventHandler[]>();
  const byName = new Map<string, EventHandler>();
  const maxAttempts = deps.maxAttempts ?? 3;

  function register(handler: EventHandler): void {
    if (byName.has(handler.name)) {
      // A duplicate name would silently share a ledger key with the other
      // handler, so each would appear to have processed the other's events.
      throw new Error(
        `Event handler "${handler.name}" is already registered. Handler names are ledger keys and must be unique.`,
      );
    }
    byName.set(handler.name, handler);

    for (const type of handler.handles) {
      const existing = handlers.get(type) ?? [];
      existing.push(handler);
      handlers.set(type, existing);
    }
  }

  /**
   * Turn a draft into a complete envelope.
   *
   * @param batchCorrelationId - the id every draft in this `publish` falls back
   * to. Allocated once per call, not once per draft: a Daily Close emits a dozen
   * events and they must share a correlation id or the timeline groups them as a
   * dozen unrelated rows.
   */
  function seal(
    draft: EventDraft,
    batchCorrelationId: CorrelationId,
  ): Result<UnsequencedEvent, DomainError> {
    if (!isEventType(draft.eventType)) {
      return err(
        validationError(
          'unknown_event_type',
          `"${String(draft.eventType)}" is not in the event registry. Register it before emitting.`,
        ),
      );
    }

    const payloadCheck = validateEventPayload(draft.eventType, draft.payload);
    if (isErr(payloadCheck)) return payloadCheck;

    const now = deps.clock.now().toISOString();

    return ok({
      eventId: deps.newId() as EventId,
      eventType: draft.eventType,
      occurredAt: draft.occurredAt,
      // The client recorded it now. Distinct from `occurredAt`, which the caller
      // supplies and may be backdated.
      capturedAt: now,
      actorId: draft.actorId,
      source: draft.source,
      version: currentVersion(draft.eventType),
      subject: draft.subject,
      payload: draft.payload,
      correlationId: draft.correlationId ?? batchCorrelationId,
      causationId: draft.causationId ?? null,
      metadata: draft.metadata ?? {},
    });
  }

  /** Invoke one handler with retries, dead-lettering on exhaustion. */
  async function invoke(
    handler: EventHandler,
    event: DomainEvent,
    ignoreLedger: boolean,
  ): Promise<{ invoked: boolean; failure: DeadLetterEntry | null }> {
    // Non-idempotent handlers are gated on the ledger. The default is
    // non-idempotent, so forgetting to declare it fails safe.
    if (handler.isIdempotent !== true && !ignoreLedger) {
      if (await deps.ledger.wasHandled(event.eventId, handler.name)) {
        return { invoked: false, failure: null };
      }
    }

    let lastError: DomainError | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let outcome: Result<void, DomainError>;

      try {
        outcome = await handler.handle(event);
      } catch (thrown: unknown) {
        // A handler that throws rather than returning Err is a bug (§5.12), but
        // it must not take down the publish that triggered it — the domain write
        // has already committed.
        outcome = err(
          validationError(
            'handler_threw',
            `Handler "${handler.name}" threw instead of returning a Result: ${
              thrown instanceof Error ? thrown.message : 'unknown'
            }`,
          ),
        );
      }

      if (!isErr(outcome)) {
        await deps.ledger.markHandled(event.eventId, handler.name);
        return { invoked: true, failure: null };
      }

      lastError = outcome.error;
    }

    const failure: DeadLetterEntry = {
      eventId: event.eventId,
      eventType: event.eventType,
      handlerName: handler.name,
      attempts: maxAttempts,
      error: lastError ?? validationError('unknown', 'Handler failed without an error.'),
      failedAt: deps.clock.now().toISOString(),
    };

    await deps.deadLetter.record(failure);
    return { invoked: true, failure };
  }

  async function dispatch(
    events: readonly DomainEvent[],
    options: { handlerNames?: readonly string[]; ignoreLedger?: boolean } = {},
  ): Promise<{ invoked: number; skipped: number; failures: DeadLetterEntry[] }> {
    let invoked = 0;
    let skipped = 0;
    const failures: DeadLetterEntry[] = [];

    for (const event of events) {
      for (const handler of handlers.get(event.eventType) ?? []) {
        if (options.handlerNames !== undefined && !options.handlerNames.includes(handler.name)) {
          continue;
        }

        const result = await invoke(handler, event, options.ignoreLedger === true);
        if (result.invoked) invoked += 1;
        else skipped += 1;
        if (result.failure !== null) failures.push(result.failure);
      }
    }

    return { invoked, skipped, failures };
  }

  return {
    register,

    handlersFor: (type) => handlers.get(type) ?? [],

    async publish(drafts) {
      if (drafts.length === 0) {
        return ok({ events: [], failures: [] });
      }

      /* --- 1. Seal and validate the whole batch, atomically ----------- */
      // One id for the whole call. See `seal`.
      const batchCorrelationId = deps.newId() as CorrelationId;

      const sealed: UnsequencedEvent[] = [];
      for (const draft of drafts) {
        const result = seal(draft, batchCorrelationId);
        if (isErr(result)) return result;
        sealed.push(result.value);
      }

      /* --- 2. Append ------------------------------------------------- */
      const appended = await deps.store.append(sealed);
      if (isErr(appended)) return appended;

      /* --- 3. Dispatch ------------------------------------------------
       * After the append, never before. A handler that ran before the commit
       * could act on an event that is then rolled back — which for a job
       * enqueue means work scheduled for something that does not exist.
       *
       * Handler failures do NOT fail the publish. The domain write and the event
       * are committed; a broken projection is recoverable by replay, whereas
       * rejecting the user's workout because a timeline handler is failing is
       * not. §5.12: "Failure never loses user input."
       */
      const outcome = await dispatch(appended.value);

      return ok({ events: appended.value, failures: outcome.failures });
    },

    async replay(options = {}) {
      const batchSize = options.batchSize ?? 500;
      let cursor = options.afterSequence ?? 0;
      let eventsRead = 0;
      let handlersInvoked = 0;
      let skipped = 0;
      const failures: DeadLetterEntry[] = [];
      let lastSequence: number | null = null;

      // Paged rather than loaded whole: twenty years of events is ~400k rows
      // (§9.7), which is fine in Postgres and not fine in one JS array.
      for (;;) {
        const page = await deps.store.read({
          afterSequence: cursor,
          limit: batchSize,
          ...(options.types === undefined ? {} : { types: options.types }),
        });
        if (isErr(page)) return page;
        if (page.value.length === 0) break;

        const outcome = await dispatch(page.value, {
          ...(options.handlerNames === undefined ? {} : { handlerNames: options.handlerNames }),
          ...(options.ignoreLedger === undefined ? {} : { ignoreLedger: options.ignoreLedger }),
        });

        eventsRead += page.value.length;
        handlersInvoked += outcome.invoked;
        skipped += outcome.skipped;
        failures.push(...outcome.failures);

        const last = page.value[page.value.length - 1];
        if (last?.sequence === undefined) {
          // A stored event without a sequence means the store returned something
          // it never assigned — paging cannot continue safely.
          return err(
            conflictError('domain_event', 'invalid_state', {
              code: 'missing_sequence',
              message: 'Store returned an event without a sequence; cannot page.',
            }),
          );
        }

        lastSequence = last.sequence;
        cursor = last.sequence;

        if (page.value.length < batchSize) break;
      }

      return ok({ eventsRead, handlersInvoked, skipped, failures, lastSequence });
    },
  };
}
