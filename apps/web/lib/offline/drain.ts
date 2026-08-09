'use client';

/**
 * The outbox drain — §5.7's "drain on connectivity / visibility / periodic-sync".
 *
 * Three triggers, and each covers a case the others miss:
 *
 * - **`online`** — the obvious one. The gym basement ends.
 * - **`visibilitychange`** — the phone was never *offline*, the tab was just
 *   backgrounded and its timers throttled to nothing. This is the common case
 *   on iOS and the one an `online`-only drain silently never handles.
 * - **an interval** — the network came back without an `online` event, which
 *   happens on captive portals and on flaky mobile data where the browser never
 *   considered itself offline in the first place.
 *
 * `navigator.onLine` is deliberately *not* a gate on any of them. It reports
 * whether the device has a network interface, not whether the server is
 * reachable — true on a hotel wifi that requires a login. Attempting the
 * request and handling the failure is the only reliable test.
 */

import { rememberHlc } from './device';
import {
  type EnqueueInput,
  type OutboxEntry,
  acknowledge,
  blockEntry,
  enqueue,
  markSending,
  orphanedEntries,
  readyEntries,
  recordFailure,
  recoverStalled,
} from './outbox';

/** How often to sweep, in milliseconds. */
const SWEEP_INTERVAL_MS = 30_000;

export type DrainSummary = {
  readonly sent: number;
  readonly failed: number;
  /** Entries blocked because something they depend on gave up. */
  readonly orphaned: number;
};

/** Set while a drain is running, so two triggers cannot interleave. */
let draining = false;

/**
 * The failure category recorded against an entry.
 *
 * Categories, never response bodies. §5.13 forbids user content in
 * diagnostics, and a rejected Daily Close's body is the day's answers.
 */
function categorise(status: number): string {
  if (status >= 500) return `server_${String(status)}`;
  if (status === 429) return 'rate_limited';
  if (status === 409) return 'conflict';
  if (status >= 400) return `rejected_${String(status)}`;
  return `unexpected_${String(status)}`;
}

async function send(entry: OutboxEntry): Promise<'sent' | 'failed'> {
  await markSending(entry);

  let response: Response;
  try {
    response = await fetch(entry.endpoint, {
      method: entry.method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry.body),
      // Same-origin only, and credentials included so the session cookie rides
      // along — the drain runs from a background context where it would not by
      // default on some browsers.
      credentials: 'same-origin',
    });
  } catch {
    // A thrown fetch is a transport failure, not a rejection. The entry stays
    // queued and retries; this is the ordinary offline path.
    await recordFailure(entry, 'network');
    return 'failed';
  }

  if (response.ok) {
    /*
     * The HLC the server issued travels back in the response body. Storing it
     * is what advances this device's clock; without it every subsequent write
     * would re-seed from physical time and lose the ordering guarantee across
     * requests.
     */
    try {
      const body: unknown = await response.json();
      if (typeof body === 'object' && body !== null && 'hlc' in body) {
        rememberHlc((body as { hlc?: string | null }).hlc);
      }
    } catch {
      // A 2xx with an unreadable body still means the write landed. Dropping
      // the entry is correct; only the clock update is lost.
    }
    await acknowledge(entry.id);
    return 'sent';
  }

  /*
   * A 4xx that is not 409 or 429 will never succeed on retry — the request is
   * malformed or refused. It is still not discarded: `recordFailure` walks it
   * to `blocked`, where §5.7 wants it "surfaced in a visible unsynced state
   * with a manual retry" rather than deleted.
   */
  await recordFailure(entry, categorise(response.status));
  return 'failed';
}

/**
 * Send everything that is ready.
 *
 * Sequential, not parallel. Two closes of the same day must reach the server in
 * the order they were made, or the earlier answer supersedes the later one —
 * and the correction chain then records the operator changing their mind
 * backwards. Parallelism would buy nothing at this volume anyway.
 */
export async function drainOutbox(): Promise<DrainSummary> {
  if (draining) return { sent: 0, failed: 0, orphaned: 0 };
  draining = true;

  try {
    let sent = 0;
    let failed = 0;

    /*
     * Re-read between sends rather than iterating one snapshot.
     *
     * A dependant becomes ready the instant its dependency is acknowledged, and
     * a session start followed by twelve sets is the normal case — draining a
     * stale snapshot would send the session, skip every set, and leave them for
     * the next sweep thirty seconds later. The loop is bounded by the number of
     * entries, because each pass either sends something or stops.
     */
    for (;;) {
      const ready = await readyEntries();
      const entry = ready[0];
      if (entry === undefined) break;

      const outcome = await send(entry);
      if (outcome === 'sent') sent += 1;
      else failed += 1;

      // A failure means this entry is no longer ready (it has a backoff), so
      // the next pass moves on rather than retrying it immediately.
    }

    /*
     * Whatever is left waiting on something that gave up. Blocked explicitly so
     * it appears in the unsynced banner with a manual retry, rather than sitting
     * pending forever — which would be §5.7's silent discard, arriving slowly.
     */
    const orphans = await orphanedEntries();
    for (const orphan of orphans) {
      await blockEntry(orphan, 'dependency_blocked');
    }

    return { sent, failed, orphaned: orphans.length };
  } finally {
    draining = false;
  }
}

/**
 * Queue a mutation and try to send it immediately.
 *
 * **The immediate attempt is the point.** Without it the first send waits for
 * the next sweep, so an operator who closes the day while online watches the
 * "waiting to sync" banner for up to thirty seconds after an action that felt
 * instant. §5.7's queue exists to survive being *offline*, not to add latency
 * when online.
 *
 * The drain is not awaited. `enqueue` has already resolved, which means the
 * write is durable — that is the promise the caller needs, and blocking on the
 * network after making it would undo the whole design.
 */
export async function queueAndDrain(input: EnqueueInput): Promise<OutboxEntry> {
  const entry = await enqueue(input);
  void drainOutbox();
  return entry;
}

/**
 * Wire the drain to its triggers.
 *
 * @returns a teardown function. Returning one rather than assuming the page
 *   lives forever is what lets React's effect cleanup work — and in the App
 *   Router, effects run twice in development, so a listener that is never
 *   removed is registered twice and every drain fires twice.
 */
export function startDrainLoop(onChange?: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;

  let stopped = false;

  const run = (): void => {
    if (stopped) return;
    void drainOutbox().then((summary) => {
      // Only notify when something actually moved, so a banner does not
      // re-render every thirty seconds for the whole day.
      if (summary.sent > 0 || summary.failed > 0 || summary.orphaned > 0) onChange?.();
    });
  };

  const onVisible = (): void => {
    if (document.visibilityState === 'visible') run();
  };

  // Entries left `sending` by a tab that died are the silent-discard case §5.7
  // forbids. Recovered once, at startup, before anything else runs.
  void recoverStalled().then(run);

  window.addEventListener('online', run);
  document.addEventListener('visibilitychange', onVisible);
  const interval = window.setInterval(run, SWEEP_INTERVAL_MS);

  return () => {
    stopped = true;
    window.removeEventListener('online', run);
    document.removeEventListener('visibilitychange', onVisible);
    window.clearInterval(interval);
  };
}

