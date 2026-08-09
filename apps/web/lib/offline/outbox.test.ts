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
  acknowledge,
  allEntries,
  backoffSeconds,
  clearOutbox,
  enqueue,
  markSending,
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
