'use client';

/**
 * The outbox's state, as a React value.
 *
 * §5.7: "entries that fail repeatedly surface in a visible 'unsynced' state
 * with a manual retry." This is what makes "visible" possible — a hook the
 * banner subscribes to, and the drain loop's own lifecycle.
 *
 * ## Why the drain loop starts here
 *
 * It has to start somewhere, and a hook mounted by the app shell is the only
 * place with a lifecycle that matches. A module-scope `startDrainLoop()` would
 * run during a Server Component's module evaluation, where `window` does not
 * exist; a `useEffect` in every screen would start several loops.
 *
 * One consumer, mounted once, in the shell.
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

import { drainOutbox, startDrainLoop } from '@/lib/offline/drain';
import { type OutboxHealth, outboxHealth, retryBlocked } from '@/lib/offline/outbox';

const EMPTY: OutboxHealth = { pending: 0, sending: 0, blocked: 0, oldestPendingAgeMs: null };

/** The connectivity store `useSyncExternalStore` subscribes to. */
function subscribeToConnectivity(onChange: () => void): () => void {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

export type UseOutbox = {
  readonly health: OutboxHealth;
  /**
   * Return blocked entries to the queue and drain immediately — the manual
   * retry §5.7 asks for. Takes an id to retry one entry, or nothing for all.
   */
  readonly unblock: (id?: string) => void;
  readonly isOnline: boolean;
};

export function useOutbox(): UseOutbox {
  const [health, setHealth] = useState<OutboxHealth>(EMPTY);
  /*
   * `useSyncExternalStore`, not state plus an effect.
   *
   * `navigator.onLine` is exactly what this hook is for: a value owned by the
   * browser, changed by events React does not control. The alternative —
   * seeding state and correcting it in an effect — produces a cascading render
   * on every mount and, worse, a tearing window in which two components
   * disagree about connectivity mid-render.
   *
   * The server snapshot is `true` because the server has no navigator, and
   * rendering the offline banner into every server-rendered page would be a
   * worse default than being optimistic for one frame.
   */
  const isOnline = useSyncExternalStore(subscribeToConnectivity, () => navigator.onLine, () => true);

  const refresh = useCallback(() => {
    void outboxHealth().then(setHealth);
  }, []);

  useEffect(() => {
    refresh();
    const stop = startDrainLoop(refresh);

    /*
     * Also refresh whenever the outbox is written to from anywhere.
     *
     * A `storage` event fires on *other* tabs, not this one, so it is not
     * enough on its own — but a Close queued on a phone's second tab should
     * still update this banner, and this is the only cross-tab signal that does
     * not require a BroadcastChannel.
     */
    const onStorage = (): void => {
      refresh();
    };
    window.addEventListener('storage', onStorage);

    return () => {
      stop();
      window.removeEventListener('storage', onStorage);
    };
  }, [refresh]);

  return {
    health,
    unblock: (id) => {
      void retryBlocked(id)
        .then(() => drainOutbox())
        .then(refresh);
    },
    isOnline,
  };
}
