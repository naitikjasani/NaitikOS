/**
 * The outbox — the component §5.7 says must never lose a write.
 *
 *   "Outbox durability is a hard requirement. A failed drain must never
 *    silently discard a write. Entries persist until acknowledged; entries that
 *    fail repeatedly surface in a visible 'unsynced' state with a manual retry."
 *
 * Every assertion below is one clause of that sentence. `fake-indexeddb` is a
 * dev-only dependency and it is worth it: the alternative is an untested queue
 * whose whole purpose is a guarantee, which is exactly the kind of decorative
 * check this codebase keeps finding.
 */

import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  MAX_ATTEMPTS,
  type OutboxEntry,
  acknowledge,
  allEntries,
  backoffSeconds,
  blockEntry,
  clearOutbox,
  discardBlockedEntries,
  enqueue,
  markSending,
  orphanedEntries,
  outboxHealth,
  readyEntries,
  recordFailure,
  recoverStalled,
  retryBlocked,
} from './outbox';

const CLOSE_BODY = { dayKey: '2026-08-03', zone: 'Asia/Kolkata', answers: [] };

beforeEach(async () => {
  await clearOutbox();
});

describe('enqueue', () => {
  it('stores an entry durably before anything touches the network', async () => {
    const entry = await enqueue({ endpoint: '/api/close', body: CLOSE_BODY, label: 'Close' });

    expect(entry.status).toBe('pending');
    expect(entry.attempts).toBe(0);

    // Read back through a fresh query, not from the return value: the promise
    // resolving is the *claim*, and this is the check.
    const stored = await allEntries();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.id).toBe(entry.id);
  });

  /**
   * The entry id *is* the idempotency key. That equality is what makes a replay
   * the same request rather than a second one, so it is asserted rather than
   * assumed by the drain.
   */
  it('uses the entry id as the idempotency key', async () => {
    const entry = await enqueue({ id: 'entry-1', endpoint: '/api/close', body: CLOSE_BODY, label: 'Close' });
    expect(entry.body['idempotencyKey']).toBe('entry-1');

    const stored = await allEntries();
    expect(stored[0]?.body['idempotencyKey']).toBe('entry-1');
  });

  it('makes a repeated enqueue with the same id idempotent', async () => {
    await enqueue({ id: 'entry-1', endpoint: '/api/close', body: CLOSE_BODY, label: 'Close' });
    await enqueue({ id: 'entry-1', endpoint: '/api/close', body: CLOSE_BODY, label: 'Close' });
    expect(await allEntries()).toHaveLength(1);
  });
});

describe('failure handling', () => {
  /**
   * The clause that matters most: a failing entry is *never* deleted. It walks
   * to `blocked` and waits for a person.
   */
  it('never discards an entry, however many times it fails', async () => {
    let entry = await enqueue({ endpoint: '/api/close', body: CLOSE_BODY, label: 'Close' });

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      entry = await recordFailure(entry, 'network');
    }

    expect(entry.status).toBe('blocked');
    expect(entry.attempts).toBe(MAX_ATTEMPTS);

    const stored = await allEntries();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.status).toBe('blocked');
  });

  it('backs off exponentially and then caps', () => {
    expect(backoffSeconds(1)).toBe(2);
    expect(backoffSeconds(2)).toBe(4);
    expect(backoffSeconds(3)).toBe(8);
    expect(backoffSeconds(5)).toBe(32);
    expect(backoffSeconds(6)).toBe(60);
    expect(backoffSeconds(20)).toBe(60);
    // A zeroth attempt is still a real wait, not an immediate hammer.
    expect(backoffSeconds(0)).toBe(2);
  });

  it('holds a failed entry back until its backoff has elapsed', async () => {
    const entry = await enqueue({ endpoint: '/api/close', body: CLOSE_BODY, label: 'Close' });
    expect(await readyEntries()).toHaveLength(1);

    await recordFailure(entry, 'network');
    expect(await readyEntries()).toHaveLength(0);
  });

  /**
   * §5.13 forbids user content in diagnostics, and a rejected Daily Close's
   * body is the day's answers. The message is truncated as a second guard, but
   * the first one is that callers pass a category.
   */
  it('truncates the stored failure message', async () => {
    const entry = await enqueue({ endpoint: '/api/close', body: CLOSE_BODY, label: 'Close' });
    const failed = await recordFailure(entry, 'x'.repeat(1000));
    expect(failed.lastError?.length).toBe(200);
  });

  it('returns a blocked entry to the queue on a manual retry', async () => {
    let entry = await enqueue({ endpoint: '/api/close', body: CLOSE_BODY, label: 'Close' });
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      entry = await recordFailure(entry, 'network');
    }

    expect(await retryBlocked()).toBe(1);
    const stored = await allEntries();
    expect(stored[0]?.status).toBe('pending');
    expect(stored[0]?.attempts).toBe(0);
    expect(await readyEntries()).toHaveLength(1);
  });

  it('retries only the named entry when one is given', async () => {
    for (const id of ['a', 'b']) {
      let entry = await enqueue({ id, endpoint: '/api/close', body: CLOSE_BODY, label: id });
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        entry = await recordFailure(entry, 'network');
      }
    }

    expect(await retryBlocked('a')).toBe(1);
    const stored = await allEntries();
    expect(stored.find((entry) => entry.id === 'a')?.status).toBe('pending');
    expect(stored.find((entry) => entry.id === 'b')?.status).toBe('blocked');
  });
});

describe('recoverStalled', () => {
  /**
   * A tab that dies mid-request leaves its entry `sending`, and a `sending`
   * entry is invisible to every future drain — the silent discard §5.7 forbids,
   * arriving through the back door.
   */
  it('un-sticks entries left in flight by a dead tab', async () => {
    const entry = await enqueue({ endpoint: '/api/close', body: CLOSE_BODY, label: 'Close' });
    await markSending(entry);

    expect(await readyEntries()).toHaveLength(0);
    expect(await recoverStalled()).toBe(1);
    expect(await readyEntries()).toHaveLength(1);
  });

  it('leaves pending and blocked entries alone', async () => {
    await enqueue({ id: 'pending', endpoint: '/api/close', body: CLOSE_BODY, label: 'p' });
    expect(await recoverStalled()).toBe(0);
  });
});

describe('acknowledge', () => {
  it('is the only thing that removes an entry', async () => {
    const entry = await enqueue({ endpoint: '/api/close', body: CLOSE_BODY, label: 'Close' });
    await acknowledge(entry.id);
    expect(await allEntries()).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------
 * The clearing path (`/settings/privacy`)
 *
 * The one place in the application permitted to delete an unacknowledged write,
 * so the boundary is asserted from both sides: what it removes, and — the half
 * that matters — what it refuses to touch. §5.7's "entries persist until
 * acknowledged" has to hold against a settings button as firmly as it holds
 * against a failed drain.
 * ---------------------------------------------------------------------- */

describe('discardBlockedEntries', () => {
  /** Six failures is the definition of blocked. Spelled out once, reused below. */
  async function blockOne(id: string, label: string): Promise<void> {
    let entry = await enqueue({ id, endpoint: '/api/close', body: CLOSE_BODY, label });
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      entry = await recordFailure(entry, 'rejected_400');
    }
    expect(entry.status).toBe('blocked');
  }

  it('removes the entries that have given up, and reports which', async () => {
    await blockOne('close-a', 'Daily Close, 3 August');
    await blockOne('close-b', 'Daily Close, 4 August');

    const discarded = await discardBlockedEntries();
    // A set, not an array: two entries enqueued inside one millisecond share an
    // `enqueuedAt`, so the newest-first sort has nothing to separate them and an
    // ordered assertion here would be asserting the sort's tie-breaking rather
    // than the discard.
    expect(new Set(discarded.map((entry) => entry.label))).toEqual(
      new Set(['Daily Close, 3 August', 'Daily Close, 4 August']),
    );
    expect(await allEntries()).toHaveLength(0);
  });

  /**
   * The guarantee, and the reason this function exists rather than a count
   * check in the screen. A `pending` entry has not finished trying and a
   * `sending` entry is in flight; deleting either is the silent discard §5.7
   * forbids, and no settings surface may cause it.
   */
  it('will not touch a pending or an in-flight entry', async () => {
    await blockOne('blocked', 'blocked');
    await enqueue({ id: 'pending', endpoint: '/api/close', body: CLOSE_BODY, label: 'pending' });
    const inFlight = await enqueue({ id: 'sending', endpoint: '/api/close', body: CLOSE_BODY, label: 'sending' });
    await markSending(inFlight);

    expect((await discardBlockedEntries()).map((entry) => entry.id)).toEqual(['blocked']);

    const health = await outboxHealth();
    expect(health.pending).toBe(1);
    expect(health.sending).toBe(1);
    expect(health.blocked).toBe(0);
  });

  it('is a no-op on an empty queue and on one where nothing has given up', async () => {
    expect(await discardBlockedEntries()).toEqual([]);
    await enqueue({ endpoint: '/api/close', body: CLOSE_BODY, label: 'Close' });
    expect(await discardBlockedEntries()).toEqual([]);
    expect(await allEntries()).toHaveLength(1);
  });

  /**
   * The documented consequence, asserted so it stays true. Discarding a blocked
   * entry releases its dependants — they become sendable, will be rejected for
   * the row that no longer exists, and end up `blocked` themselves. Noisy, but
   * never silent, which is the property §5.7 asks for.
   */
  it('releases the dependants of a discarded entry rather than stranding them', async () => {
    let session = await enqueue({
      id: 'session',
      endpoint: '/api/gym/sessions',
      body: { startedAt: '2026-08-17T12:00:00.000Z', zone: 'Asia/Kolkata' },
      label: 'session',
    });
    await enqueue({
      id: 'set-1',
      endpoint: '/api/gym/sets',
      body: { sessionId: 'session' },
      label: 'set 1',
      dependsOn: 'session',
    });
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      session = await recordFailure(session, 'rejected_400');
    }

    // Held back while the dependency is blocked.
    expect(await readyEntries()).toEqual([]);

    await discardBlockedEntries();

    const remaining = await allEntries();
    expect(remaining.map((entry) => entry.id)).toEqual(['set-1']);
    expect((await readyEntries()).map((entry) => entry.id)).toEqual(['set-1']);
  });
});

describe('ordering', () => {
  /**
   * Two closes of the same day, queued offline, must reach the server in the
   * order they were made. Reversed, the *earlier* answer supersedes the later
   * one and the correction chain records the operator changing their mind
   * backwards.
   */
  it('sends oldest first', async () => {
    const first = await enqueue({ id: 'first', endpoint: '/api/close', body: CLOSE_BODY, label: '1' });
    // Forced apart: `uuidV7` within one millisecond would otherwise leave the
    // two enqueue timestamps equal and the assertion vacuous.
    const second = { ...(await enqueue({ id: 'second', endpoint: '/api/close', body: CLOSE_BODY, label: '2' })) };
    expect(second.enqueuedAt).toBeGreaterThanOrEqual(first.enqueuedAt);

    const ready = await readyEntries();
    expect(ready.map((entry) => entry.id)).toEqual(['first', 'second']);
  });
});

describe('outboxHealth', () => {
  it('reports the counts the unsynced banner renders', async () => {
    const pending = await enqueue({ id: 'p', endpoint: '/api/close', body: CLOSE_BODY, label: 'p' });
    const sending = await enqueue({ id: 's', endpoint: '/api/close', body: CLOSE_BODY, label: 's' });
    await markSending(sending);

    let blocked = await enqueue({ id: 'b', endpoint: '/api/close', body: CLOSE_BODY, label: 'b' });
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      blocked = await recordFailure(blocked, 'network');
    }

    const health = await outboxHealth();
    expect(health.pending).toBe(1);
    expect(health.sending).toBe(1);
    expect(health.blocked).toBe(1);
    expect(health.oldestPendingAgeMs).not.toBeNull();
    expect(pending.id).toBe('p');
  });

  it('reports an empty queue as empty', async () => {
    const health = await outboxHealth();
    expect(health).toEqual({ pending: 0, sending: 0, blocked: 0, oldestPendingAgeMs: null });
  });
});

/**
 * Dependency ordering — the gym logger's requirement.
 *
 * A set references its session by foreign key. A session logged in a basement
 * queues one start and a dozen sets, and the drain must not send a set until the
 * server has confirmed the session it belongs to.
 */
describe('dependency ordering', () => {
  const SESSION_BODY = { startedAt: '2026-08-17T12:00:00.000Z', zone: 'Asia/Kolkata' };

  it('holds a dependant back until its dependency is acknowledged', async () => {
    await enqueue({ id: 'session', endpoint: '/api/gym/sessions', body: SESSION_BODY, label: 'session' });
    await enqueue({
      id: 'set-1',
      endpoint: '/api/gym/sets',
      body: { sessionId: 'session' },
      label: 'set 1',
      dependsOn: 'session',
    });

    expect((await readyEntries()).map((entry) => entry.id)).toEqual(['session']);

    await acknowledge('session');
    expect((await readyEntries()).map((entry) => entry.id)).toEqual(['set-1']);
  });

  /**
   * Ordering by `enqueuedAt` alone is not enough: the drain continues past a
   * failure, so a session start that failed would let every set behind it try,
   * fail, and burn an attempt each.
   */
  it('holds dependants back while the dependency is merely failing', async () => {
    const session = await enqueue({
      id: 'session',
      endpoint: '/api/gym/sessions',
      body: SESSION_BODY,
      label: 'session',
    });
    await enqueue({
      id: 'set-1',
      endpoint: '/api/gym/sets',
      body: { sessionId: 'session' },
      label: 'set 1',
      dependsOn: 'session',
    });

    await recordFailure(session, 'network');

    // The session is backing off and the set is held. Nothing is ready.
    expect(await readyEntries()).toEqual([]);
  });

  /**
   * A dependency that gives up takes its dependants with it — visibly. Leaving
   * them pending forever is the silent discard §5.7 forbids, arriving slowly.
   */
  it('reports dependants of a blocked entry as orphaned', async () => {
    let session = await enqueue({
      id: 'session',
      endpoint: '/api/gym/sessions',
      body: SESSION_BODY,
      label: 'session',
    });
    await enqueue({
      id: 'set-1',
      endpoint: '/api/gym/sets',
      body: { sessionId: 'session' },
      label: 'set 1',
      dependsOn: 'session',
    });

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      session = await recordFailure(session, 'rejected_400');
    }
    expect(session.status).toBe('blocked');

    const orphans = await orphanedEntries();
    expect(orphans.map((entry) => entry.id)).toEqual(['set-1']);
    expect(await readyEntries()).toEqual([]);

    await blockEntry(orphans[0] as OutboxEntry, 'dependency_blocked');
    const health = await outboxHealth();
    expect(health.blocked).toBe(2);
    expect(health.pending).toBe(0);
  });

  it('leaves an entry with no dependency alone', async () => {
    await enqueue({ id: 'close', endpoint: '/api/close', body: CLOSE_BODY, label: 'close' });
    expect((await readyEntries()).map((entry) => entry.id)).toEqual(['close']);
  });

  it('retries a blocked orphan once the operator asks', async () => {
    await enqueue({ id: 'set-1', endpoint: '/api/gym/sets', body: {}, label: 'set 1' });
    const entry = (await allEntries())[0] as OutboxEntry;
    await blockEntry(entry, 'dependency_blocked');

    expect(await retryBlocked('set-1')).toBe(1);
    expect((await readyEntries()).map((item) => item.id)).toEqual(['set-1']);
  });
});
