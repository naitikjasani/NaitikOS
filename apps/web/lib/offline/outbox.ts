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
  /**
   * `DELETE` carries a body, which is unusual and is the right call here.
   *
   * The one deletion on the offline path is un-tapping a routine step, whose
   * identity is `(routineId, stepId, occurredOn)` — three values, not a row id
   * the client holds. Putting them in the path would give the endpoint a
   * different shape from the POST that created the row, for no gain; `fetch`
   * permits a body on DELETE and so does the route.
   *
   * Ordering matters more than the verb. A tap and an un-tap of the same step
   * must reach the server in the order they were made, and the queue is what
   * guarantees that — a direct network call for the delete would race the
   * queued create and leave the step ticked.
   */
  readonly method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly body: Record<string, unknown>;
  /** What this entry is, for the unsynced banner. "Daily Close, 3 August". */
  readonly label: string;
  /**
   * An entry that must be acknowledged before this one may be sent.
   *
   * **The gym logger is why this exists.** A set references its session by
   * foreign key, so a set that reaches the server first is rejected — and a
   * whole session logged in a basement drains in whatever order the sweep finds
   * it. Ordering by `enqueuedAt` is not sufficient on its own: the drain
   * continues past a failure, so one failed session start would let every set
   * behind it try, fail, and burn an attempt each.
   *
   * A dependency is satisfied when the entry it names is *gone* — and since only
   * {@link acknowledge} deletes, gone means the server has it.
   */
  readonly dependsOn: string | null;
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
  readonly method?: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly body: Record<string, unknown>;
  readonly label: string;
  /** Supply one to make the enqueue itself idempotent. */
  readonly id?: string;
  /** Hold this entry until the named one is acknowledged. See {@link OutboxEntry.dependsOn}. */
  readonly dependsOn?: string;
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
    dependsOn: input.dependsOn ?? null,
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

  /*
   * Anything still in the store is unacknowledged — only `acknowledge` deletes.
   * So an entry whose dependency is still present has not had its prerequisite
   * confirmed by the server, and sending it would be sending a set for a
   * session that does not exist yet.
   */
  const outstanding = new Set(entries.map((entry) => entry.id));
  const blocked = new Set(entries.filter((entry) => entry.status === 'blocked').map((entry) => entry.id));

  return entries
    .filter(
      (entry) =>
        entry.status === 'pending' &&
        entry.nextAttemptAt <= now &&
        /*
         * A dependency that has given up takes its dependants with it. Leaving
         * them pending forever would be a silent stall — §5.7's "surface it in a
         * visible unsynced state" applies to the whole chain, not just the link
         * that broke. `drainOutbox` blocks them explicitly.
         */
        (entry.dependsOn === null || !outstanding.has(entry.dependsOn)) &&
        (entry.dependsOn === null || !blocked.has(entry.dependsOn)),
    )
    /*
     * Oldest first, and it matters more than it looks. Two closes of the same
     * day queued offline must reach the server in the order they were made, or
     * the *earlier* answer supersedes the later one and the correction chain
     * records the operator changing their mind backwards.
     */
    .sort((a, b) => a.enqueuedAt - b.enqueuedAt);
}

/**
 * Entries held back because something they depend on has given up.
 *
 * Returned so the drain can block them rather than leaving them pending
 * forever. A queue that never empties and never complains is the silent discard
 * §5.7 forbids, arriving slowly.
 */
export async function orphanedEntries(): Promise<readonly OutboxEntry[]> {
  const entries = await allEntries();
  const blocked = new Set(entries.filter((entry) => entry.status === 'blocked').map((entry) => entry.id));

  return entries.filter(
    (entry) => entry.status === 'pending' && entry.dependsOn !== null && blocked.has(entry.dependsOn),
  );
}

/** Move an entry straight to `blocked`, without spending its remaining attempts. */
export async function blockEntry(entry: OutboxEntry, reason: string): Promise<void> {
  await withStore('readwrite', (store) =>
    store.put({ ...entry, status: 'blocked', lastError: reason.slice(0, 200) }),
  );
}

/**
 * Discard entries that have given up, and only those.
 *
 * The clearing control on `/settings/privacy` calls this rather than
 * {@link clearOutbox}, and the difference is the whole of §5.7's guarantee:
 *
 *   "A failed drain must never silently discard a write. Entries persist until
 *    acknowledged."
 *
 * A `pending` entry has not finished trying and a `sending` entry is in flight,
 * so both are writes the operator believes are saved and both have a remedy that
 * costs nothing — wait, or drain. A `blocked` entry has spent every attempt and,
 * per {@link MAX_ATTEMPTS}, is "surfaced in a visible unsynced state with a
 * manual retry" waiting for a person. Abandoning it is a decision that person is
 * entitled to make, and it is the only way a device ever reaches a clean state.
 *
 * **The filter is here rather than in the screen on purpose.** A surface that
 * checked the counts and then called `clear()` would be one stale read away from
 * deleting an in-flight write, and the guarantee would rest on a `useEffect`
 * having refreshed. There is no argument this store should accept.
 *
 * One known consequence, stated rather than papered over: discarding a blocked
 * entry releases anything held behind it by {@link OutboxEntry.dependsOn}. Those
 * dependants become sendable, will be rejected by the server for the row that no
 * longer exists, and will walk to `blocked` themselves over
 * {@link MAX_ATTEMPTS}. That is noisy but not silent, which is the property §5.7
 * actually demands — they end up visible in the unsynced state rather than
 * deleted or stalled forever.
 *
 * @returns the entries that were removed, so the caller can report what it did.
 */
export async function discardBlockedEntries(): Promise<readonly OutboxEntry[]> {
  /*
   * One transaction, with the status read at the moment of deletion.
   *
   * The obvious shape — read every entry, filter to `blocked`, then delete each
   * by id — is a check followed by a separate act, and between the two an entry
   * can leave `blocked`. The screen offers "try sending now" beside this
   * button, so the sequence that loses a write is a real one: retry moves an
   * entry to `sending`, and a discard decided a moment earlier then deletes it
   * mid-flight. That is precisely the silent discard §5.7 forbids —
   *
   *   "the outbox may replay any request any number of times… a failed drain
   *    must never silently discard a write"
   *
   * — and it would take with it a Close the operator believes is saved.
   *
   * A cursor inside a single `readwrite` transaction closes the window: the
   * value is read and deleted in the same atomic scope, so an entry that has
   * become `sending` is seen as `sending` and left alone. The guard therefore
   * lives in the store rather than in the caller, and no stale count from
   * React can widen it.
   */
  const discarded: OutboxEntry[] = [];

  await withStore<OutboxEntry[]>('readwrite', (store) => {
    const cursorRequest = store.openCursor();

    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (cursor === null) return;

      const entry = cursor.value as OutboxEntry;
      if (entry.status === 'blocked') {
        cursor.delete();
        discarded.push(entry);
      }
      cursor.continue();
    };

    /* Resolved by `oncomplete`, which fires only after every request above has
     * settled — so the array is fully populated by the time it is read. */
    return { result: discarded };
  });

  return discarded;
}

/**
 * Empty the queue, unconditionally.
 *
 * **For tests.** No operator-facing path calls this and none should:
 * {@link discardBlockedEntries} is the settings surface's route in, because it
 * cannot delete a write that is still trying. This one deletes a `sending` entry
 * mid-flight, which is precisely the silent discard §5.7 forbids — it exists
 * because a test suite needs a known-empty store between cases, and a suite that
 * built one out of the safe function could not test the unsafe states.
 */
export async function clearOutbox(): Promise<void> {
  await withStore('readwrite', (store) => store.clear());
}
