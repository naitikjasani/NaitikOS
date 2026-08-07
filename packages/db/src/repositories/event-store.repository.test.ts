/**
 * The event backbone — integration, against real Postgres.
 *
 * Everything asserted here is enforced by the database rather than by TypeScript,
 * which is why a mock would test nothing:
 *
 *   - The `sequence` is server-assigned, gapless, and monotonic. Only a single
 *     writer can guarantee that, and the guarantee is the ordering §5.8's sync
 *     watermark and the timeline's keyset cursor both depend on.
 *   - The log is **immutable** — migration 0006's trigger rejects every UPDATE and
 *     DELETE, more strictly than `observation`, which permits its supersession
 *     columns to change.
 *   - `event_handled`'s composite unique index is the idempotency guarantee. Two
 *     concurrent dispatches race on the insert and one loses.
 *   - `deferred_task`'s partial unique index means one live task per subject.
 *
 * Isolation is explicit `DELETE` rather than the transaction-per-test pattern:
 * `claimDue` and `claimPending` issue `SELECT ... FOR UPDATE SKIP LOCKED`, and
 * postgres.js does not nest transactions — an inner `COMMIT` commits the outer
 * manual `BEGIN` and isolation silently disappears. That failure mode cost an hour
 * during the identity milestone; see the note in `identity.repository.test.ts`.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { isErr, isOk } from '@naitikos/shared';
import type { DomainEvent, EventDraft, EventId } from '@naitikos/core';
import {
  createEventBus,
  fixedClock,
  projectEvent,
} from '@naitikos/core';

import { createDatabase } from '../client';
import {
  createDeadLetterSink,
  createEventStore,
  createHandledLedger,
  latestSequence,
  openDeadLetters,
  unknownEventTypes,
} from './event-store.repository';
import { createTimelineProjectionHandler, createTimelineRepository } from './timeline.repository';
import { createTaskRepository } from './task.repository';
import { createUploadOutboxRepository } from './upload-outbox.repository';

const DATABASE_URL = process.env['DATABASE_URL'];
const db = DATABASE_URL === undefined ? undefined : createDatabase(DATABASE_URL);

const NOW = new Date('2026-08-03T18:30:00Z');
const ZONE = 'Asia/Kolkata';

afterAll(async () => {
  await db?.$client.end({ timeout: 5 });
});

/**
 * Sequential ids, so a failure names the event it was on.
 *
 * Real UUIDs — the columns are `uuid`, and Postgres rejects a near-miss with a
 * type error rather than coercing it. The final group is twelve hex characters,
 * which is easy to get wrong by one and produces a failure that looks like a bug
 * in the repository rather than in the fixture.
 */
function counterIds(prefix: string): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `00000000-0000-4000-8000-${prefix}${String(n).padStart(11, '0')}`;
  };
}

/**
 * A real `media_object` row.
 *
 * `upload_outbox.media_object_id` has a foreign key, and it should: an outbox
 * entry claiming to have produced a media row that does not exist is exactly the
 * inconsistency §9.8's integrity sweep exists to find. So the test satisfies the
 * constraint rather than working around it.
 *
 * The wrapped key is required by the `media_object_sensitive_encrypted` check —
 * a sensitive-tier row without one would be a plaintext body photo, which §5.5
 * forbids. That constraint rejected the first version of this fixture, which is
 * the constraint doing its job.
 */
async function insertMediaObject(sql: postgres.Sql, id: string, storageKey: string): Promise<void> {
  await sql`
    INSERT INTO media_object (id, kind, tier, storage_key, mime_type, wrapped_key, encryption_algorithm)
    VALUES (
      ${id}, 'image', 'sensitive', ${storageKey}, 'image/jpeg',
      'wrapped:test-dek', 'AES-256-GCM'
    )
  `;
}

function draft(overrides: Partial<EventDraft> = {}): EventDraft {
  return {
    eventType: 'Medication.Taken',
    occurredAt: '2026-08-03T08:00:00Z',
    actorId: 'sub-1',
    source: 'user',
    subject: { type: 'medication_log', id: '11111111-1111-4111-8111-111111111111' },
    payload: { medicationId: '22222222-2222-4222-8222-222222222222', substanceLabel: 'Venlafaxine XR' },
    ...overrides,
  } as EventDraft;
}

describe.skipIf(db === undefined)('the event backbone', () => {
  const database = db as NonNullable<typeof db>;
  const sql: postgres.Sql = database.$client;

  const store = createEventStore(database);
  const ledger = createHandledLedger(database);
  const deadLetter = createDeadLetterSink(database);
  const timeline = createTimelineRepository(database);
  const tasks = createTaskRepository(database);
  const outbox = createUploadOutboxRepository(database);

  /**
   * Ordered by foreign key.
   *
   * `domain_event` is last because `deferred_task.causation_event_id` and
   * `event_handled.event_id` reference it. Deleting from the log is only possible
   * here because migration 0006's trigger is *disabled for the owner role* — see
   * the immutability suite, which asserts it fires for the application role.
   */
  async function reset(): Promise<void> {
    await sql`DELETE FROM upload_outbox`;
    await sql`DELETE FROM media_thumbnail`;
    await sql`DELETE FROM media_object`;
    await sql`DELETE FROM deferred_task`;
    await sql`DELETE FROM timeline_entry`;
    await sql`DELETE FROM event_handled`;
    await sql`DELETE FROM event_dead_letter`;
    await sql`ALTER TABLE domain_event DISABLE TRIGGER domain_event_append_only`;
    await sql`DELETE FROM domain_event`;
    await sql`ALTER TABLE domain_event ENABLE TRIGGER domain_event_append_only`;
    await sql`ALTER SEQUENCE domain_event_sequence_seq RESTART WITH 1`;
  }

  function bus(maxAttempts = 3) {
    return createEventBus({
      store,
      ledger,
      deadLetter,
      clock: fixedClock(NOW),
      newId: counterIds('a'),
      maxAttempts,
    });
  }

  beforeEach(reset);

  /* ===================================================================
   * Sequencing
   * ================================================================ */

  describe('the sequence', () => {
    it('is assigned by the database, gapless and monotonic', async () => {
      const result = await store.append(
        [1, 2, 3].map((n) => ({
          eventId: `00000000-0000-4000-8000-00000000000${String(n)}` as EventId,
          eventType: 'Weight.Logged' as const,
          occurredAt: '2026-08-03T07:00:00Z',
          capturedAt: '2026-08-03T07:00:01Z',
          actorId: 'sub-1',
          source: 'user' as const,
          version: 1,
          subject: { type: 'observation', id: '33333333-3333-4333-8333-333333333333' },
          payload: { metricKey: 'body.weight' },
          correlationId: '44444444-4444-4444-8444-444444444444' as never,
          causationId: null,
          metadata: {},
        })),
      );
      if (isErr(result)) throw new Error(result.error.message);

      expect(result.value.map((event) => event.sequence)).toEqual([1, 2, 3]);
      expect(await latestSequence(database)).toBe(3);
    });

    it('orders by acceptance, not by occurredAt', async () => {
      const events = bus();

      await events.publish([draft({ occurredAt: '2026-08-03T08:00:00Z' })]);
      // The offline-drain case (§5.7): a backdated batch lands hours later.
      await events.publish([
        draft({
          occurredAt: '2026-07-01T08:00:00Z',
          subject: { type: 'medication_log', id: '55555555-5555-4555-8555-555555555555' },
        }),
      ]);

      const page = await store.read({ limit: 10 });
      if (isErr(page)) throw new Error(page.error.message);

      expect(page.value.map((event) => event.occurredAt)).toEqual([
        '2026-08-03T08:00:00.000Z',
        '2026-07-01T08:00:00.000Z',
      ]);
    });

    it('sets createdAt server-side, distinct from capturedAt', async () => {
      const events = bus();
      const published = await events.publish([draft()]);
      if (isErr(published)) throw new Error(published.error.message);

      const event = published.value.events[0] as DomainEvent;
      // §9.5's argument applied to events: "three different dates, all of them
      // true, all of them sometimes the one that matters."
      expect(event.capturedAt).toBe(NOW.toISOString());
      expect(event.createdAt).not.toBe('');
      expect(event.occurredAt).toBe('2026-08-03T08:00:00.000Z');
    });
  });

  /* ===================================================================
   * Idempotency
   * ================================================================ */

  describe('append idempotency', () => {
    it('returns the stored copy rather than a second row', async () => {
      const events = bus();
      const first = await events.publish([draft()]);
      if (isErr(first)) throw new Error(first.error.message);

      const stored = first.value.events[0] as DomainEvent;

      // What the outbox does: §5.7's "may replay any request any number of times".
      const replayed = await store.append([stored]);
      if (isErr(replayed)) throw new Error(replayed.error.message);

      const counted = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM domain_event
      `;
      expect(counted[0]?.count).toBe(1);
      // Same position in history. A re-append that shifted the sequence would move
      // the event relative to everything accepted since.
      expect(replayed.value[0]?.sequence).toBe(stored.sequence);
    });

    it('reports whether an event is stored', async () => {
      const events = bus();
      const published = await events.publish([draft()]);
      if (isErr(published)) throw new Error(published.error.message);

      const stored = await store.has((published.value.events[0] as DomainEvent).eventId);
      const absent = await store.has('99999999-9999-4999-8999-999999999999' as EventId);

      expect(isOk(stored) && stored.value).toBe(true);
      expect(isOk(absent) && absent.value).toBe(false);
    });
  });

  /* ===================================================================
   * Immutability
   * ================================================================ */

  describe('immutability (migration 0006)', () => {
    it('rejects an UPDATE to any column', async () => {
      const events = bus();
      await events.publish([draft()]);

      // Stricter than `observation`, which permits its supersession columns to
      // change. An event has no legitimate mutation at all.
      await expect(
        sql`UPDATE domain_event SET actor_id = 'someone-else'`,
      ).rejects.toThrow(/append-only|immutable|cannot be/i);
    });

    it('rejects an UPDATE to the payload specifically', async () => {
      const events = bus();
      await events.publish([draft()]);

      // The one that would matter: rewriting a payload destroys the record of what
      // was actually emitted, and with it the ability to reproduce a past replay.
      await expect(
        sql`UPDATE domain_event SET payload = '{"medicationId":"x","substanceLabel":"y"}'::jsonb`,
      ).rejects.toThrow(/append-only|immutable|cannot be/i);
    });

    it('rejects a DELETE', async () => {
      const events = bus();
      await events.publish([draft()]);

      await expect(sql`DELETE FROM domain_event`).rejects.toThrow(
        /append-only|immutable|cannot be/i,
      );
    });

    it('permits the projection to be truncated, because it is derived', async () => {
      const events = bus();
      events.register(createTimelineProjectionHandler(timeline, ZONE));
      await events.publish([draft()]);

      expect(await timeline.count()).toBe(1);

      // ADR 0005 rule 3: the projection is rebuildable and the log is not. This
      // asymmetry is the whole reason the trigger is on one table and not the other.
      const cleared = await timeline.clear();
      expect(isOk(cleared)).toBe(true);
      expect(await timeline.count()).toBe(0);
    });
  });

  /* ===================================================================
   * The handled ledger
   * ================================================================ */

  describe('the handled ledger', () => {
    it('records and reports a handled event', async () => {
      const events = bus();
      const published = await events.publish([draft()]);
      if (isErr(published)) throw new Error(published.error.message);
      const eventId = (published.value.events[0] as DomainEvent).eventId;

      expect(await ledger.wasHandled(eventId, 'some.handler')).toBe(false);
      await ledger.markHandled(eventId, 'some.handler');
      expect(await ledger.wasHandled(eventId, 'some.handler')).toBe(true);
      // Per handler, not per event. Two handlers see the same event independently.
      expect(await ledger.wasHandled(eventId, 'other.handler')).toBe(false);
    });

    it('is safe to mark twice', async () => {
      const events = bus();
      const published = await events.publish([draft()]);
      if (isErr(published)) throw new Error(published.error.message);
      const eventId = (published.value.events[0] as DomainEvent).eventId;

      await ledger.markHandled(eventId, 'h');
      await ledger.markHandled(eventId, 'h');

      const counted = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM event_handled
      `;
      // The composite unique index is the guarantee; `markHandled` swallowing the
      // conflict is what makes a concurrent double-dispatch safe rather than fatal.
      expect(counted[0]?.count).toBe(1);
    });
  });

  /* ===================================================================
   * Dead-lettering
   * ================================================================ */

  describe('the dead-letter table', () => {
    it('accumulates attempts on one row rather than adding rows per retry', async () => {
      const events = bus(2);
      events.register({
        name: 'broken.handler',
        handles: ['Medication.Taken'],
        isIdempotent: true,
        handle: () =>
          Promise.resolve({
            ok: false,
            error: { kind: 'validation', code: 'nope', message: 'Failed.', issues: [] },
          }),
      });

      await events.publish([draft()]);
      await events.replay({ ignoreLedger: true });

      const open = await openDeadLetters(database);
      // §5.16 alerts on the open rows here, and an alert on row *count* would be
      // dominated by retry noise if each retry added a row.
      expect(open).toHaveLength(1);
      expect(open[0]?.handlerName).toBe('broken.handler');
      expect(open[0]?.attempts).toBe(4);
    });
  });

  /* ===================================================================
   * Timeline generation and querying
   * ================================================================ */

  describe('timeline generation', () => {
    async function seed(): Promise<void> {
      const events = bus();
      events.register(createTimelineProjectionHandler(timeline, ZONE));

      await events.publish([draft({ metadata: { zone: ZONE } })]);
      await events.publish([
        draft({
          eventType: 'Workout.Completed',
          subject: { type: 'workout_session', id: '66666666-6666-4666-8666-666666666666' },
          payload: { setCount: 12, exerciseCount: 4 },
          occurredAt: '2026-08-03T12:00:00Z',
          metadata: { zone: ZONE },
        }),
      ]);
      await events.publish([
        draft({
          eventType: 'Workout.SetLogged',
          subject: { type: 'workout_set', id: '77777777-7777-4777-8777-777777777777' },
          payload: {
            sessionId: '66666666-6666-4666-8666-666666666666',
            exerciseId: '88888888-8888-4888-8888-888888888888',
            exerciseLabel: 'Barbell squat',
            orderIndex: 1,
            isPersonalRecord: true,
          },
          occurredAt: '2026-08-03T12:30:00Z',
          metadata: { zone: ZONE },
        }),
      ]);
      await events.publish([
        draft({
          eventType: 'ProgressPhoto.Uploaded',
          subject: { type: 'media_object', id: '99999999-9999-4999-8999-999999999999' },
          payload: {
            mediaObjectId: '99999999-9999-4999-8999-999999999999',
            kind: 'image',
            region: 'face',
          },
          occurredAt: '2026-08-04T02:00:00Z',
          metadata: { zone: ZONE },
        }),
      ]);
    }

    it('projects every published event automatically', async () => {
      await seed();
      // The property that makes the timeline future-proof: a new domain appears by
      // emitting events, with no timeline code change (§3.3 R5).
      expect(await timeline.count()).toBe(4);
    });

    it('hides detail-significance entries by default', async () => {
      await seed();
      const page = await timeline.query({}, ZONE);
      if (isErr(page)) throw new Error(page.error.message);

      // The set is `detail`; a forty-set session would otherwise bury the day.
      expect(page.value.entries.map((entry) => entry.eventType)).not.toContain('Workout.SetLogged');
      expect(page.value.entries).toHaveLength(3);
    });

    it('includes detail entries when asked', async () => {
      await seed();
      const page = await timeline.query({ includeDetail: true }, ZONE);
      if (isErr(page)) throw new Error(page.error.message);
      expect(page.value.entries).toHaveLength(4);
    });

    it('returns newest first by default', async () => {
      await seed();
      const page = await timeline.query({}, ZONE);
      if (isErr(page)) throw new Error(page.error.message);

      const sequences = page.value.entries.map((entry) => entry.sequence);
      expect(sequences).toEqual([...sequences].sort((a, b) => b - a));
    });

    it('pages with a keyset cursor, not an offset', async () => {
      await seed();

      const first = await timeline.query({ limit: 2, includeDetail: true }, ZONE);
      if (isErr(first)) throw new Error(first.error.message);

      expect(first.value.entries).toHaveLength(2);
      expect(first.value.hasMore).toBe(true);
      expect(first.value.nextCursor).toBe(first.value.entries[1]?.sequence);

      const second = await timeline.query(
        {
          limit: 2,
          includeDetail: true,
          // Spread rather than `?? undefined`: `exactOptionalPropertyTypes` treats
          // an explicitly-undefined key as a distinct value from an absent one.
          ...(first.value.nextCursor === null ? {} : { afterSequence: first.value.nextCursor }),
        },
        ZONE,
      );
      if (isErr(second)) throw new Error(second.error.message);

      // No overlap. `OFFSET` would shift if an event arrived mid-scroll, silently
      // skipping an entry — the bug a user paging through five years would hit and
      // never diagnose.
      const firstIds = new Set(first.value.entries.map((entry) => entry.eventId));
      for (const entry of second.value.entries) {
        expect(firstIds.has(entry.eventId)).toBe(false);
      }
      expect(second.value.hasMore).toBe(false);
      expect(second.value.nextCursor).toBeNull();
    });

    it('filters by category and by clinical flag', async () => {
      await seed();

      const body = await timeline.query({ categories: ['body'] }, ZONE);
      if (isErr(body)) throw new Error(body.error.message);
      expect(body.value.entries.every((entry) => entry.category === 'body')).toBe(true);

      const clinical = await timeline.query({ clinicalOnly: true, includeDetail: true }, ZONE);
      if (isErr(clinical)) throw new Error(clinical.error.message);
      expect(clinical.value.entries.every((entry) => entry.clinical)).toBe(true);
      expect(clinical.value.entries.length).toBeGreaterThan(0);
    });

    it('filters by event type', async () => {
      await seed();
      const page = await timeline.query({ eventTypes: ['Medication.Taken'] }, ZONE);
      if (isErr(page)) throw new Error(page.error.message);

      expect(page.value.entries).toHaveLength(1);
      expect(page.value.entries[0]?.eventType).toBe('Medication.Taken');
    });

    it('filters to entries with media', async () => {
      await seed();
      const page = await timeline.query({ withMediaOnly: true }, ZONE);
      if (isErr(page)) throw new Error(page.error.message);

      expect(page.value.entries).toHaveLength(1);
      // §5.5 sensitive tier: the timeline shows a placeholder rather than requesting
      // a signed URL for something it cannot decrypt.
      expect(page.value.entries[0]?.media[0]?.isEncrypted).toBe(true);
    });

    it('filters by a half-open date range', async () => {
      await seed();
      const page = await timeline.query(
        { from: '2026-08-03T00:00:00Z', until: '2026-08-04T00:00:00Z', includeDetail: true },
        ZONE,
      );
      if (isErr(page)) throw new Error(page.error.message);

      // The 02:00 UTC photo on the 4th is excluded by the exclusive upper bound —
      // half-open so adjacent pages never double-count.
      expect(page.value.entries).toHaveLength(3);
    });

    it('searches over the title and detail', async () => {
      await seed();
      const page = await timeline.query({ search: 'venlafaxine' }, ZONE);
      if (isErr(page)) throw new Error(page.error.message);

      expect(page.value.entries).toHaveLength(1);
      expect(page.value.entries[0]?.title).toContain('Venlafaxine');
    });

    it('does not throw on search syntax a person would actually type', async () => {
      await seed();
      // `websearch_to_tsquery`, not `to_tsquery` — the latter raises a syntax error
      // on a stray apostrophe, which would surface as a 500 while typing.
      for (const search of ["don't", 'a -b', '"quoted phrase', 'a | b &']) {
        const page = await timeline.query({ search }, ZONE);
        expect(isOk(page), `search ${search} failed`).toBe(true);
      }
    });

    it('finds everything touching one entity (§3.3 R5)', async () => {
      await seed();
      const entries = await timeline.forEntity(
        'session',
        '66666666-6666-4666-8666-666666666666',
      );
      if (isErr(entries)) throw new Error(entries.error.message);

      // The set links to its session through the payload's `sessionId`, which the
      // projector turned into a `related` link.
      expect(entries.value).toHaveLength(1);
      expect(entries.value[0]?.eventType).toBe('Workout.SetLogged');
    });

    it('groups by day in the capture zone', async () => {
      await seed();
      const page = await timeline.query({ grouping: 'day', includeDetail: true }, ZONE);
      if (isErr(page)) throw new Error(page.error.message);

      // 02:00 UTC on the 4th is 07:30 IST on the 4th; the rest are the 3rd.
      expect(page.value.groups?.map((group) => group.key)).toEqual(['2026-08-04', '2026-08-03']);
    });

    it('is idempotent, so a rebuild is byte-identical', async () => {
      await seed();
      const before = await timeline.query({ includeDetail: true }, ZONE);
      if (isErr(before)) throw new Error(before.error.message);

      // A full rebuild: truncate the projection, replay the log with the ledger
      // ignored. §5.2's `rebuild-timeline` step is exactly this.
      await timeline.clear();
      const rebuilt = bus();
      rebuilt.register(createTimelineProjectionHandler(timeline, ZONE));
      const summary = await rebuilt.replay({ ignoreLedger: true });
      if (isErr(summary)) throw new Error(summary.error.message);

      expect(summary.value.eventsRead).toBe(4);

      const after = await timeline.query({ includeDetail: true }, ZONE);
      if (isErr(after)) throw new Error(after.error.message);

      expect(after.value.entries).toEqual(before.value.entries);
    });

    it('re-projects without duplicating when the same event is projected twice', async () => {
      await seed();
      const events = bus();
      events.register(createTimelineProjectionHandler(timeline, ZONE));
      await events.replay({ ignoreLedger: true });

      // One entry per event, enforced by the primary key on `event_id`.
      expect(await timeline.count()).toBe(4);
    });

    it('matches the pure projector exactly', async () => {
      await seed();
      const stored = await store.read({ limit: 10 });
      if (isErr(stored)) throw new Error(stored.error.message);

      const page = await timeline.query({ includeDetail: true, direction: 'forward' }, ZONE);
      if (isErr(page)) throw new Error(page.error.message);

      // The round-trip through Postgres must not change anything the pure projector
      // produced — jsonb key ordering, a numeric becoming a string, a null becoming
      // undefined. This is the assertion that catches those.
      for (const [index, event] of stored.value.entries()) {
        expect(page.value.entries[index]).toEqual(projectEvent(event, ZONE));
      }
    });
  });

  /* ===================================================================
   * Unknown types
   * ================================================================ */

  describe('a rolled-back deploy', () => {
    it('reports event types this build does not recognise', async () => {
      const events = bus();
      await events.publish([draft()]);
      expect(await unknownEventTypes(database)).toEqual([]);

      // What a newer deploy would have written. `event_type` is `text`, not an enum,
      // precisely so an older build can *read* the row rather than failing to parse
      // the column type.
      await sql`
        INSERT INTO domain_event (
          id, event_type, version, occurred_at, captured_at, actor_id, source,
          subject_type, subject_id, payload, correlation_id
        ) VALUES (
          gen_random_uuid(), 'Future.Invented', 1, now(), now(), 'sub-1', 'user',
          'thing', gen_random_uuid(), '{}'::jsonb, gen_random_uuid()
        )
      `;

      expect(await unknownEventTypes(database)).toEqual(['Future.Invented']);
    });

    it('skips an unmappable row on read rather than crashing', async () => {
      await sql`
        INSERT INTO domain_event (
          id, event_type, version, occurred_at, captured_at, actor_id, source,
          subject_type, subject_id, payload, correlation_id
        ) VALUES (
          gen_random_uuid(), 'Future.Invented', 1, now(), now(), 'sub-1', 'user',
          'thing', gen_random_uuid(), '{}'::jsonb, gen_random_uuid()
        )
      `;

      const page = await store.read({ limit: 10 });
      // Degrades rather than dies: a rolled-back deploy reading events a newer one
      // wrote must keep serving the timeline for everything it does understand.
      expect(isOk(page)).toBe(true);
      if (isOk(page)) expect(page.value).toHaveLength(0);
    });
  });

  /* ===================================================================
   * Deferred tasks
   * ================================================================ */

  describe('deferred tasks', () => {
    const SUBJECT = { type: 'media_object', id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };

    it('enqueues one live task per subject', async () => {
      const first = await tasks.enqueue({ kind: 'thumbnail.generate', subject: SUBJECT });
      const second = await tasks.enqueue({ kind: 'thumbnail.generate', subject: SUBJECT });
      if (isErr(first) || isErr(second)) throw new Error('enqueue failed');

      // The partial unique index. A second thumbnail task for the same photo would
      // do redundant work and, worse, could race the first.
      expect(second.value).toBe(first.value);
      expect(await tasks.pendingCount()).toBe(1);
    });

    it('allows a new task once the previous one has settled', async () => {
      const first = await tasks.enqueue({ kind: 'thumbnail.generate', subject: SUBJECT });
      if (isErr(first)) throw new Error('enqueue failed');
      await tasks.settle(first.value);

      const second = await tasks.enqueue({ kind: 'thumbnail.generate', subject: SUBJECT });
      if (isErr(second)) throw new Error('enqueue failed');

      // The index is partial on pending/running, which is what makes re-running a
      // thumbnail after a code change possible at all.
      expect(second.value).not.toBe(first.value);
    });

    it('claims only due tasks', async () => {
      await tasks.enqueue({ kind: 'thumbnail.generate', subject: SUBJECT });
      await tasks.enqueue({
        kind: 'embedding.generate',
        subject: SUBJECT,
        notBefore: '2027-01-01T00:00:00Z',
      });

      const claimed = await tasks.claimDue(10, NOW.toISOString());
      if (isErr(claimed)) throw new Error(claimed.error.message);

      expect(claimed.value).toHaveLength(1);
      expect(claimed.value[0]?.kind).toBe('thumbnail.generate');
    });

    it('does not re-claim a running task', async () => {
      await tasks.enqueue({ kind: 'thumbnail.generate', subject: SUBJECT });

      const first = await tasks.claimDue(10, NOW.toISOString());
      const second = await tasks.claimDue(10, NOW.toISOString());
      if (isErr(first) || isErr(second)) throw new Error('claim failed');

      // Two runs draining one table is the race §5.2's manual trigger creates.
      expect(first.value).toHaveLength(1);
      expect(second.value).toHaveLength(0);
    });

    it('backs off on failure and dead-letters after three attempts', async () => {
      const enqueued = await tasks.enqueue({ kind: 'thumbnail.generate', subject: SUBJECT });
      if (isErr(enqueued)) throw new Error('enqueue failed');
      const id = enqueued.value;

      const first = await tasks.fail(id, 'decode_failed', NOW.toISOString());
      const second = await tasks.fail(id, 'decode_failed', NOW.toISOString());
      if (isErr(first) || isErr(second)) throw new Error('fail failed');

      expect(first.value).toBe(false);
      expect(second.value).toBe(false);

      const third = await tasks.fail(id, 'decode_failed', NOW.toISOString());
      if (isErr(third)) throw new Error('fail failed');

      // §5.16 alerts on the dead rows. A task retrying forever hides a permanent
      // failure behind a growing queue.
      expect(third.value).toBe(true);
      expect((await tasks.deadTasks()).map((task) => task.id)).toEqual([id]);
    });

    it('recovers a task stranded by a killed run', async () => {
      await tasks.enqueue({ kind: 'thumbnail.generate', subject: SUBJECT });
      await tasks.claimDue(10, '2026-08-01T00:00:00Z');

      const recovered = await tasks.recoverStale('2026-08-02T00:00:00Z');
      if (isErr(recovered)) throw new Error(recovered.error.message);

      // Without this, a serverless timeout leaves the claim held forever and the
      // partial unique index makes the *next* enqueue dedupe against a task nobody
      // will drain.
      expect(recovered.value).toBe(1);
      expect(await tasks.pendingCount()).toBe(1);
    });

    it('links a task to the event that caused it', async () => {
      const events = bus();
      const published = await events.publish([draft()]);
      if (isErr(published)) throw new Error(published.error.message);

      const enqueued = await tasks.enqueue({
        kind: 'thumbnail.generate',
        subject: SUBJECT,
        causationEventId: (published.value.events[0] as DomainEvent).eventId,
      });
      expect(isOk(enqueued)).toBe(true);

      const claimed = await tasks.claimDue(10, NOW.toISOString());
      if (isErr(claimed)) throw new Error(claimed.error.message);
      // §5.13's tracing: the chain from a user action to the background work it
      // caused, three weeks later.
      expect(claimed.value[0]?.causationEventId).toBe((published.value.events[0] as DomainEvent).eventId);
    });
  });

  /* ===================================================================
   * Upload lifecycle
   * ================================================================ */

  describe('the upload outbox', () => {
    const input = {
      idempotencyKey: 'idem-0001',
      storageKey: `sensitive/2026/08/3b/1f/${'3b1f'.repeat(16)}.jpg`,
      tier: 'sensitive' as const,
      contentType: 'image/jpeg',
      expectedByteSize: 2_400_000,
      expectedContentHash: 'a'.repeat(64),
      deviceId: 'phone-1',
    };

    it('is idempotent on the client-supplied key', async () => {
      const first = await outbox.enqueue(input);
      const second = await outbox.enqueue(input);
      if (isErr(first) || isErr(second)) throw new Error('enqueue failed');

      // §5.7: "Idempotency keys on every mutation. The outbox may replay any request
      // any number of times; the server deduplicates."
      expect(second.value.id).toBe(first.value.id);
      expect((await outbox.unsynced())).toHaveLength(1);
    });

    it('runs the happy path to uploaded', async () => {
      await outbox.enqueue(input);

      const claimed = await outbox.claimPending(10, NOW.toISOString());
      if (isErr(claimed)) throw new Error(claimed.error.message);
      expect(claimed.value).toHaveLength(1);

      const entry = claimed.value[0] as NonNullable<(typeof claimed.value)[number]>;
      await outbox.recordProgress(entry.id, 0.5);

      await insertMediaObject(sql, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', input.storageKey);
      await outbox.markUploaded(entry.id, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');

      // Off the unsynced list, which is what §5.7's visible "unsynced" state reads.
      expect(await outbox.unsynced()).toHaveLength(0);
      const stored = await outbox.byIdempotencyKey(input.idempotencyKey);
      expect(stored?.status).toBe('uploaded');
      expect(stored?.mediaObjectId).toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    });

    it('keeps a failed entry visible and retryable', async () => {
      await outbox.enqueue(input);
      const claimed = await outbox.claimPending(10, NOW.toISOString());
      if (isErr(claimed)) throw new Error(claimed.error.message);
      const entry = claimed.value[0] as NonNullable<(typeof claimed.value)[number]>;

      await outbox.markFailed(entry.id, 'network_unreachable', NOW.toISOString());

      const after = await outbox.byIdempotencyKey(input.idempotencyKey);
      expect(after?.status).toBe('failed');
      expect(after?.attempts).toBe(1);
      // §5.7: "A failed drain must never silently discard a write."
      expect(await outbox.unsynced()).toHaveLength(1);

      // And it is picked up again. There is deliberately no attempt cap — giving up
      // automatically is what "silently discard" looks like from the user's side.
      const reclaimed = await outbox.claimPending(10, NOW.toISOString());
      if (isErr(reclaimed)) throw new Error(reclaimed.error.message);
      expect(reclaimed.value).toHaveLength(1);
    });

    it('clears a stale error once the upload eventually succeeds', async () => {
      await outbox.enqueue(input);
      const claimed = await outbox.claimPending(10, NOW.toISOString());
      if (isErr(claimed)) throw new Error(claimed.error.message);
      const entry = claimed.value[0] as NonNullable<(typeof claimed.value)[number]>;

      await outbox.markFailed(entry.id, 'network_unreachable', NOW.toISOString());

      await insertMediaObject(sql, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', input.storageKey);
      await outbox.markUploaded(entry.id, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc');

      const after = await outbox.byIdempotencyKey(input.idempotencyKey);
      // Otherwise `/settings/developer` shows a network error next to a photo that
      // uploaded fine two days ago.
      expect(after?.lastErrorCode).toBeNull();
    });

    it('abandons without deleting the record', async () => {
      const enqueued = await outbox.enqueue(input);
      if (isErr(enqueued)) throw new Error('enqueue failed');

      await outbox.abandon(enqueued.value.id, 'user_discarded');

      // §9.4: "Nothing is hard-deleted." The record that an upload was given up on
      // still exists, which matters when a photo appears missing from a series six
      // months later.
      const after = await outbox.byIdempotencyKey(input.idempotencyKey);
      expect(after?.status).toBe('abandoned');
      expect(after?.abandonedReason).toBe('user_discarded');
      // But it stops being an alert.
      expect(await outbox.unsynced()).toHaveLength(0);
    });

    it('does not re-claim an abandoned entry', async () => {
      const enqueued = await outbox.enqueue(input);
      if (isErr(enqueued)) throw new Error('enqueue failed');
      await outbox.abandon(enqueued.value.id, 'user_discarded');

      const claimed = await outbox.claimPending(10, NOW.toISOString());
      if (isErr(claimed)) throw new Error(claimed.error.message);
      expect(claimed.value).toHaveLength(0);
    });

    it('recovers an entry stuck uploading', async () => {
      await outbox.enqueue(input);
      await outbox.claimPending(10, '2026-08-01T00:00:00Z');

      const recovered = await outbox.recoverStale('2026-08-02T00:00:00Z');
      if (isErr(recovered)) throw new Error(recovered.error.message);
      expect(recovered.value).toBe(1);
    });

    it('reports the sync health §5.16 alerts on', async () => {
      await outbox.enqueue(input);
      await outbox.enqueue({ ...input, idempotencyKey: 'idem-0002' });

      const health = await outbox.health(NOW.toISOString());

      expect(health.pending).toBe(2);
      expect(health.failed).toBe(0);
      // §5.16: "An outbox entry older than 24 hours is an alert, because it means
      // data the user believes is saved is not."
      expect(health.oldestAgeSeconds).not.toBeNull();
      expect(health.oldestAgeSeconds ?? -1).toBeGreaterThanOrEqual(0);
    });

    it('reports a clear outbox as having no oldest entry', async () => {
      const health = await outbox.health(NOW.toISOString());
      expect(health).toEqual({ pending: 0, failed: 0, oldestAgeSeconds: null });
    });

    it('excludes an abandoned entry from the health reading', async () => {
      const enqueued = await outbox.enqueue(input);
      if (isErr(enqueued)) throw new Error('enqueue failed');
      await outbox.abandon(enqueued.value.id, 'user_discarded');

      const health = await outbox.health(NOW.toISOString());
      // Otherwise one photo the user deliberately discarded pages someone every
      // night forever.
      expect(health.pending).toBe(0);
      expect(health.oldestAgeSeconds).toBeNull();
    });
  });
});
