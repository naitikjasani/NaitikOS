'use client';

/**
 * The read cache — §5.7's other half.
 *
 * ```
 * READ    TanStack Query persisted cache
 *           → offline: serve from cache, banner states data age
 *           → online: stale-while-revalidate
 * ```
 *
 * ## Why the persistence is hand-rolled
 *
 * `@tanstack/react-query-persist-client` plus a storage persister would do
 * this, and it is two more packages for about forty lines of `dehydrate`,
 * `hydrate` and a debounced write — both of which TanStack already exports from
 * the core package. C2 asks whether a dependency will still install and still
 * be correct in twenty years, and for forty lines the answer is not worth
 * finding out.
 *
 * ## Why `localStorage` and not IndexedDB
 *
 * The outbox is in IndexedDB because losing a *write* is unacceptable; losing a
 * cached *read* costs one refetch. `localStorage` is synchronous, so the cache
 * is warm before first paint rather than one microtask after it — which is the
 * difference between the Today screen rendering yesterday's numbers instantly
 * and rendering a skeleton first.
 *
 * The 5 MB quota is the real constraint, and it is why the dehydrated payload
 * is size-checked before it is written rather than after it throws.
 */

import { useEffect, useState, type ReactNode } from 'react';
import {
  QueryClient,
  QueryClientProvider,
  dehydrate,
  hydrate,
  type DehydratedState,
} from '@tanstack/react-query';
import { systemClock } from '@naitikos/core';

const CACHE_KEY = 'naitikos.query.cache';
const CACHE_VERSION = 1;

/**
 * How long a cached read stays valid offline.
 *
 * Seven days. Long enough that a week in a place with no signal still shows the
 * record; short enough that a cache restored from a stale device does not
 * present year-old numbers as current. The banner states the age regardless —
 * §P1's honesty means the UI never shows a number without saying how old it is.
 */
const MAX_CACHE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Above this, the payload is dropped rather than written. `localStorage` is ~5 MB. */
const MAX_CACHE_BYTES = 2_000_000;

type PersistedCache = {
  readonly version: number;
  readonly savedAt: number;
  readonly state: DehydratedState;
};

function readPersisted(): PersistedCache | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (raw === null) return null;

    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;

    const cache = parsed as PersistedCache;
    // A version bump invalidates everything. Cheaper and safer than migrating a
    // cache: the worst case is one refetch.
    if (cache.version !== CACHE_VERSION) return null;
    if (systemClock.nowMillis() - cache.savedAt > MAX_CACHE_AGE_MS) return null;

    return cache;
  } catch {
    // Corrupt JSON, or storage blocked. Neither is worth surfacing — the app
    // works without a cache, it is just colder.
    return null;
  }
}

function writePersisted(client: QueryClient): void {
  if (typeof window === 'undefined') return;
  try {
    const payload: PersistedCache = {
      version: CACHE_VERSION,
      savedAt: systemClock.nowMillis(),
      state: dehydrate(client, {
        // Only settled, successful queries. Persisting an error state would
        // make a transient failure survive a restart, which looks exactly like
        // a permanent one.
        shouldDehydrateQuery: (query) => query.state.status === 'success',
      }),
    };

    const serialised = JSON.stringify(payload);
    if (serialised.length > MAX_CACHE_BYTES) {
      // Checked rather than caught. A `QuotaExceededError` on some browsers
      // leaves the previous value in place and on others clears it, so the
      // failure mode differs by vendor — refusing up front does not.
      return;
    }
    window.localStorage.setItem(CACHE_KEY, serialised);
  } catch {
    // Quota, private mode, or a disabled store. The cache is an optimisation.
  }
}

/** How long after a cache change to write. Coalesces a burst into one write. */
const PERSIST_DEBOUNCE_MS = 1000;

export function QueryProvider({ children }: { readonly children: ReactNode }): ReactNode {
  /*
   * One client per mount, built in state rather than at module scope.
   *
   * A module-scoped client is shared across every render of a server-rendered
   * app, which in a serverless container means one user's cache is another
   * request's. At C1 there is only one user, but the habit is the point: the
   * pattern is wrong and would be wrong the moment anything else changes.
   */
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            /*
             * Thirty seconds. The record does not change without this device
             * changing it, so aggressive refetching buys nothing — but the
             * operator may close the day on a phone and then open a laptop, and
             * half a minute is short enough that the laptop is not wrong for
             * long.
             */
            staleTime: 30_000,
            gcTime: MAX_CACHE_AGE_MS,
            /*
             * No retry on a 4xx. TanStack's default retries three times, which
             * for a validation failure is three identical rejections and a
             * three-second wait before the user sees the message.
             */
            retry: (failureCount, error: unknown) => {
              const status = (error as { status?: number } | null)?.status;
              if (typeof status === 'number' && status >= 400 && status < 500) return false;
              return failureCount < 2;
            },
            refetchOnWindowFocus: true,
            // The whole point of the persisted cache: a reconnect revalidates,
            // it does not blank the screen first.
            refetchOnReconnect: true,
          },
        },
      }),
  );

  /*
   * Hydrate and subscribe in one effect, in that order.
   *
   * Two effects with a `hydrated` state flag between them was the first
   * version, and it was wrong twice over: reading `localStorage` during render
   * makes the server's HTML disagree with the client's first paint, and setting
   * state synchronously inside an effect to sequence the two triggers the
   * cascading render `react-hooks/set-state-in-effect` exists to catch.
   *
   * Sequencing them inside one effect needs no state at all. Hydration happens
   * before the subscription exists, so there is no window in which an empty
   * cache is persisted over a good one.
   */
  useEffect(() => {
    const persisted = readPersisted();
    if (persisted !== null) hydrate(client, persisted.state);

    let timer: number | undefined;
    const unsubscribe = client.getQueryCache().subscribe(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        writePersisted(client);
      }, PERSIST_DEBOUNCE_MS);
    });

    return () => {
      window.clearTimeout(timer);
      unsubscribe();
      // One final write on unmount, so navigating away does not lose the last
      // second of cache updates.
      writePersisted(client);
    };
  }, [client]);

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** The query keys, in one place so a mutation cannot invalidate a typo. */
export const queryKeys = {
  close: (dayKey: string, zone: string) => ['close', dayKey, zone] as const,
  observations: (params: Record<string, unknown>) => ['observations', params] as const,
  timeline: (params: Record<string, unknown>) => ['timeline', params] as const,
} as const;
