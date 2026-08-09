'use client';

/**
 * The offline outbox — §5.7's durable write queue.
 *
 *   "Outbox durability is a hard requirement. A failed drain must never
 *    silently discard a write. Entries persist until acknowledged; entries that
 *    fail repeatedly surface in a visible 'unsynced' state with a manual retry.
 *    Losing a logged workout because the drain failed quietly would end the
 *    user's trust in the system, and trust is the whole product."
 *
 * Every sentence of that is a design constraint, and each maps to something
 * below: entries are written to IndexedDB *before* the network is touched;
 * nothing is deleted except on an acknowledged success; a permanently failing
 * entry moves to `blocked` rather than being dropped; and `outboxHealth`
 * exposes the counts a banner needs.
 *
 * ## Raw IndexedDB, no wrapper library
 *
 * The API is unpleasant — event-based, transaction-scoped, easy to misuse — and
 * `idb` would make this file half the length. Rejected on C2: this is the
 * component that must never lose a write, and in 2046 it must still run. Two
 * hundred lines of a stable browser API is a smaller liability than a
 * dependency that must still install and still be correct in twenty years.
 *
 * The one genuine trap is handled explicitly at {@link withStore}: an IndexedDB
 * transaction auto-commits when the microtask queue drains, so `await`-ing
 * anything unrelated inside one silently closes it. Every transaction here is
 * opened, used and resolved without an intervening await on anything else.
 */

import { systemClock } from '@naitikos/core';
import { uuidV7 } from '@naitikos/shared';

const DATABASE_NAME = 'naitikos-outbox';
const DATABASE_VERSION = 1;
const STORE = 'entries';
const STATUS_INDEX = 'by-status';

/**
 * Attempts before an entry stops retrying on its own.
 *
 * Six, with the backoff below, is a little over an hour of trying. Past that
 * the failure is not transient and automatic retries are just noise; §5.7 wants
 * it "surfaced in a visible unsynced state with a manual retry", which is what
 * `blocked` is.
 */
export const MAX_ATTEMPTS = 6;

/** Exponential, capped. Seconds: 2, 4, 8, 16, 32, 60. */
export function backoffSeconds(attempt: number): number {
  return Math.min(2 ** Math.max(attempt, 1), 60);
}

export type OutboxStatus =
  /** Waiting to be sent. */
  | 'pending'
  /** In flight right now. Reset to `pending` if the tab dies mid-request. */
  | 'sending'
  /** Out of attempts. Needs a person. Never deleted. */
  | 'blocked';

export type OutboxEntry = {
  /** Client-generated, and also the idempotency key the server dedupes on. */
  readonly id: string;
  readonly endpoint: string;
  readonly method: 'POST' | 'PUT' | 'PATCH';
  readonly body: Record<string, unknown>;
  /** What this entry is, for the unsynced banner. "Daily Close, 3 August". */
  readonly label: string;
  readonly status: OutboxStatus;
  readonly attempts: number;
  readonly enqueuedAt: number;
  readonly nextAttemptAt: number;
  /** The last failure, for the diagnostics panel. Never shown as a toast. */
  readonly lastError: string | null;
};

/* -------------------------------------------------------------------------
 * The database
 * ---------------------------------------------------------------------- */

let connection: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  connection ??= new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is unavailable.'));
      return;
    }

    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE)) {
        const store = database.createObjectStore(STORE, { keyPath: 'id' });
        // Drains scan by status and then by readiness; without the index this
        // is a full cursor walk on every wake-up, including the ones a
        // background sync fires while the tab is hidden.
        store.createIndex(STATUS_INDEX, 'status', { unique: false });
      }
    };

    request.onsuccess = () => {
      const database = request.result;
      /*
       * A second tab upgrading the schema blocks on this one holding the old
       * version open. Closing on `versionchange` lets the upgrade proceed
       * rather than hanging both tabs — the connection reopens on next use.
       */
      database.onversionchange = () => {
        database.close();
        connection = null;
      };
      resolve(database);
    };

    request.onerror = () => {
      connection = null;
      reject(request.error ?? new Error('Could not open the outbox database.'));
    };
  });

  return connection;
}

/**
 * Run one transaction against the entry store.
 *
 * The callback must not await anything: an IndexedDB transaction commits as
 * soon as the microtask queue drains, so an unrelated `await` inside one closes
 * it and every subsequent request throws `TransactionInactiveError`. The shape
 * here — build requests synchronously, resolve on `oncomplete` — is what makes
 * that impossible to get wrong at the call sites.
 */
async function withStore<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest | { readonly result: T },
): Promise<T> {
  const database = await openDatabase();

  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(STORE, mode);
    const request = work(transaction.objectStore(STORE));

    transaction.oncomplete = () => {
      resolve(('result' in request ? request.result : undefined) as T);
    };
    transaction.onerror = () => reject(transaction.error ?? new Error('Outbox transaction failed.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Outbox transaction aborted.'));
  });
}

/* -------------------------------------------------------------------------
 * Queue operations
 * ---------------------------------------------------------------------- */

export type EnqueueInput = {
  readonly endpoint: string;
  readonly method?: 'POST' | 'PUT' | 'PATCH';
  readonly body: Record<string, unknown>;
  readonly label: string;
  /** Supply one to make the enqueue itself idempotent. */
  readonly id?: string;
};

/**
 * Put a mutation in the queue.
 *
 * **Returns only after the write is durable.** The optimistic UI update happens
 * separately and immediately; this await is what makes the promise that the
 * write survives the tab being closed one second later.
 */
export async function enqueue(input: EnqueueInput): Promise<OutboxEntry> {
  const now = systemClock.nowMillis();
  const id = input.id ?? uuidV7(now);

  const entry: OutboxEntry = {
    id,
    endpoint: input.endpoint,
    method: input.method ?? 'POST',
    /*
     * The idempotency key *is* the entry id.
     *
     * That equality is what makes a replay the same request rather than a
     * second one: the drain re-sends this exact body, and the server's
     * `withIdempotency` recognises the key and returns the original response.
     * Two identifiers would mean two things to keep in step.
     */
    body: { ...input.body, idempotencyKey: id },
    label: input.label,
    status: 'pending',
    attempts: 0,
    enqueuedAt: now,
    nextAttemptAt: now,
    lastError: null,
  };

  await withStore('readwrite', (store) => store.put(entry));
  return entry;
}

/** Every entry, newest first. For the diagnostics panel. */
export async function allEntries(): Promise<readonly OutboxEntry[]> {
  const entries = await withStore<OutboxEntry[]>('readonly', (store) => store.getAll());
  return [...(entries ?? [])].sort((a, b) => b.enqueuedAt - a.enqueuedAt);
}

export type OutboxHealth = {
  readonly pending: number;
  readonly sending: number;
  readonly blocked: number;
  /** The oldest unsent entry's age in milliseconds, for the "data age" banner. */
  readonly oldestPendingAgeMs: number | null;
};

/** The counts the unsynced banner needs (§5.7). */
export async function outboxHealth(): Promise<OutboxHealth> {
  const entries = await allEntries();
  const unsent = entries.filter((entry) => entry.status !== 'blocked');
  const oldest = unsent.reduce<number | null>(
    (min, entry) => (min === null || entry.enqueuedAt < min ? entry.enqueuedAt : min),
    null,
  );

  return {
    pending: entries.filter((entry) => entry.status === 'pending').length,
    sending: entries.filter((entry) => entry.status === 'sending').length,
    blocked: entries.filter((entry) => entry.status === 'blocked').length,
    oldestPendingAgeMs: oldest === null ? null : systemClock.nowMillis() - oldest,
  };
}

/** Drop an entry. Called only after the server acknowledged it. */
export async function acknowledge(id: string): Promise<void> {
  await withStore('readwrite', (store) => store.delete(id));
}

/** Record a failure and schedule the next attempt, or block the entry. */
export async function recordFailure(entry: OutboxEntry, error: string): Promise<OutboxEntry> {
  const attempts = entry.attempts + 1;
  const exhausted = attempts >= MAX_ATTEMPTS;
  const next: OutboxEntry = {
    ...entry,
    attempts,
    status: exhausted ? 'blocked' : 'pending',
    nextAttemptAt: systemClock.nowMillis() + backoffSeconds(attempts) * 1000,
    /*
     * The message is stored, and it is the one place user-adjacent text could
     * leak into diagnostics. Callers pass a *shape* — "network", "500",
     * "validation" — never a response body, because a rejected Daily Close's
     * body contains the day's answers.
     */
    lastError: error.slice(0, 200),
  };
  await withStore('readwrite', (store) => store.put(next));
  return next;
}

/** Mark an entry as in flight, so a second drain does not pick it up. */
export async function markSending(entry: OutboxEntry): Promise<void> {
  await withStore('readwrite', (store) => store.put({ ...entry, status: 'sending' }));
}

/**
 * Un-stick entries left `sending` by a tab that died mid-request.
 *
 * Run at startup. Without it, a browser crash during a drain leaves entries
 * permanently invisible to every future drain — the silent discard §5.7
 * forbids, arriving through the back door.
 *
 * Safe because the server deduplicates: re-sending an entry that did in fact
 * arrive returns the original response rather than writing twice.
 */
export async function recoverStalled(): Promise<number> {
  const entries = await allEntries();
  const stalled = entries.filter((entry) => entry.status === 'sending');
  for (const entry of stalled) {
    await withStore('readwrite', (store) =>
      store.put({ ...entry, status: 'pending', nextAttemptAt: systemClock.nowMillis() }),
    );
  }
  return stalled.length;
}

/** Return a blocked entry to the queue. The manual retry §5.7 asks for. */
export async function retryBlocked(id?: string): Promise<number> {
  const entries = await allEntries();
  const targets = entries.filter(
    (entry) => entry.status === 'blocked' && (id === undefined || entry.id === id),
  );
  for (const entry of targets) {
    await withStore('readwrite', (store) =>
      store.put({ ...entry, status: 'pending', attempts: 0, nextAttemptAt: systemClock.nowMillis() }),
    );
  }
  return targets.length;
}

/** Entries ready to send right now, oldest first. */
export async function readyEntries(): Promise<readonly OutboxEntry[]> {
  const now = systemClock.nowMillis();
  const entries = await allEntries();
  return entries
    .filter((entry) => entry.status === 'pending' && entry.nextAttemptAt <= now)
    /*
     * Oldest first, and it matters more than it looks. Two closes of the same
     * day queued offline must reach the server in the order they were made, or
     * the *earlier* answer supersedes the later one and the correction chain
     * records the operator changing their mind backwards.
     */
    .sort((a, b) => a.enqueuedAt - b.enqueuedAt);
}

/** For tests and for the "clear local data" path in settings. */
export async function clearOutbox(): Promise<void> {
  await withStore('readwrite', (store) => store.clear());
}
