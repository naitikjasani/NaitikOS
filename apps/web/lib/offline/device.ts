'use client';

/**
 * The device's stable identity and its hybrid logical clock.
 *
 * §5.7 needs both on every write. The device id is the HLC's tiebreaker, so two
 * of the operator's own devices writing in the same millisecond still produce a
 * total order; the stored HLC is what makes a device's writes monotone across
 * requests without the server remembering anything (see
 * `lib/platform/capture.ts` for the server half).
 *
 * ## `localStorage`, not IndexedDB, and not a cookie
 *
 * These are two short strings read on *every* mutation, including the ones a
 * service worker replays. `localStorage` is synchronous, which matters here —
 * an async read would make the outbox's enqueue path async for no reason, and
 * the enqueue path is what stands between a tap and a durable record.
 *
 * A cookie was the other candidate and is wrong: it would travel on every
 * request including static asset fetches, and the device id would then be a
 * tracking identifier sent to a CDN, which P6 has no appetite for.
 *
 * ## What happens when it is cleared
 *
 * Clearing site data gives the device a new id and no HLC. Neither is a data
 * loss: ids already written are untouched, and the clock restarts from physical
 * time, which is still ahead of everything that device wrote before. The only
 * cost is that two "devices" appear in `sync_state` where there was one.
 */

import { uuidV7 } from '@naitikos/shared';
import { systemClock } from '@naitikos/core';

const DEVICE_ID_KEY = 'naitikos.device.id';
const HLC_KEY = 'naitikos.device.hlc';

/**
 * A server-render-safe accessor.
 *
 * Returns `null` rather than throwing when `window` is absent. A Server
 * Component that reaches this by accident gets a handled absence instead of a
 * hydration-time crash, which is the difference between a bug and an outage.
 */
function storage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    // Safari in private mode, and any browser with storage blocked. The app
    // stays usable; writes simply get a fresh device id each time.
    return null;
  }
}

/** This device's permanent id, minted on first use. */
export function deviceId(): string {
  const store = storage();
  // No storage: a per-call id. Still a valid HLC node, still unique; it just
  // does not persist, so ordering across sessions falls back to physical time.
  if (store === null) return uuidV7(systemClock.nowMillis());

  const existing = store.getItem(DEVICE_ID_KEY);
  if (existing !== null && existing !== '') return existing;

  const minted = uuidV7(systemClock.nowMillis());
  store.setItem(DEVICE_ID_KEY, minted);
  return minted;
}

/** The last HLC the server issued to this device, if any. */
export function lastHlc(): string | undefined {
  const stored = storage()?.getItem(HLC_KEY);
  return stored === null || stored === undefined || stored === '' ? undefined : stored;
}

/**
 * Record the HLC the server just issued.
 *
 * Guarded by a string comparison, because the encoding is designed so that
 * lexicographic order *is* causal order. Two requests completing out of order —
 * which happens routinely when the outbox drains several entries at once —
 * would otherwise let the older one overwrite the newer, and the device's clock
 * would go backwards.
 */
export function rememberHlc(hlc: string | null | undefined): void {
  if (hlc === null || hlc === undefined || hlc === '') return;
  const store = storage();
  if (store === null) return;

  const previous = store.getItem(HLC_KEY);
  if (previous !== null && previous >= hlc) return;
  store.setItem(HLC_KEY, hlc);
}

/** The offline envelope every mutation carries (§5.7). */
export function offlineEnvelope(): { deviceId: string; clientHlc?: string } {
  const hlc = lastHlc();
  return hlc === undefined ? { deviceId: deviceId() } : { deviceId: deviceId(), clientHlc: hlc };
}

/**
 * A fresh idempotency key.
 *
 * One per *mutation*, not one per attempt: the whole point is that a retry
 * carries the same key. The outbox mints it once at enqueue time and it travels
 * with the entry (`lib/offline/outbox.ts`).
 */
export function newIdempotencyKey(): string {
  return uuidV7(systemClock.nowMillis());
}
