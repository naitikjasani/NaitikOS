'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { systemClock } from '@naitikos/core';

import {
  clearRest,
  gymStorage,
  loadRest,
  saveRest,
  type KeyValueStore,
} from '../services/liveSessionStore';

/**
 * The rest timer — §4.1's "live session logger with rest timer".
 *
 * ## Why it counts from a timestamp rather than counting down
 *
 * The obvious implementation is `setInterval` decrementing a number. It is
 * wrong on a phone, which is the only device this runs on: iOS throttles timers
 * in a backgrounded tab to roughly once a minute and suspends them entirely when
 * the screen locks. A counting-down timer therefore reports ninety seconds
 * remaining after three minutes of actual rest — and the operator, who locked
 * their phone and put it in their pocket exactly as everyone does between sets,
 * rests for twice as long as they meant to.
 *
 * So the timer stores the instant rest *started* and **derives** the elapsed
 * time. The interval only advances a "now" reading; if it fires once in three
 * minutes the arithmetic is still exact, and waking the tab shows the truth
 * immediately rather than catching up.
 *
 * That derivation also keeps every state write inside a callback rather than in
 * an effect body — which is what React's `set-state-in-effect` rule is asking
 * for, and it happens to be the same shape correctness already required.
 *
 * ## Why the instant is also written to disk
 *
 * Deriving from a timestamp survives the *tab being suspended*. It does not
 * survive the tab being **destroyed**, and on the device this runs on those are
 * the same event one step further along: iOS backgrounds a PWA, freezes it, and
 * then — under any memory pressure at all, which a phone that has been in a
 * locker for four minutes with the camera app opened once certainly has —
 * discards it. The operator returns to a reloaded page and a timer that reads
 * "start rest", having lost the only thing the timer knows.
 *
 * `liveSessionStore` therefore mirrors `{ startedAt, target }` to
 * `localStorage` on every transition, and the clock is restored on mount. The
 * restore is deliberately *silent*: a rest that has been running is a fact about
 * the world, not a decision to confirm, and asking would put a dialog between
 * the operator and the bar. A clock more than `REST_STALE_AFTER_MS` past
 * its target is not restored, because at that point it is a tab reopened after
 * lunch rather than a rest in progress.
 *
 * ## What it does when it finishes
 *
 * Vibrates, if the device will. §5.9's push notifications need VAPID keys and
 * are not built, and a sound in a gym is either inaudible or embarrassing. A
 * vibration in a pocket is the one signal that works, and it degrades to nothing
 * on a device that does not support it — which is why the visual state is the
 * primary indicator and the vibration is an extra.
 */

/** The default rest between working sets. Ninety seconds is a compromise. */
export const DEFAULT_REST_SECONDS = 90;

/**
 * How much a single tap on `−`/`+` moves the target. Fifteen seconds.
 *
 * Exported because `RestTimer` puts the number in the button's visible label,
 * and a control whose label disagrees with what it does is worse than one with
 * no label at all.
 */
export const REST_ADJUST_SECONDS = 15;

/** The floor a rest target can be adjusted down to. */
const MIN_REST_SECONDS = 15;

export type RestTimer = {
  /** Seconds elapsed since rest started. `null` when not resting. */
  readonly elapsed: number | null;
  /** Seconds remaining against the target, floored at zero. */
  readonly remaining: number | null;
  readonly target: number;
  readonly isResting: boolean;
  readonly isOverdue: boolean;
  start: (seconds?: number) => void;
  stop: () => void;
  adjust: (deltaSeconds: number) => void;
};

export function useRestTimer(defaultSeconds = DEFAULT_REST_SECONDS): RestTimer {
  /*
   * Resolved once. `gymStorage()` touches `window.localStorage`, which throws
   * rather than returning undefined when storage is blocked, so calling it per
   * render would mean a try/catch per render for a value that cannot change.
   */
  const store = useMemo<KeyValueStore | null>(() => gymStorage(), []);

  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [target, setTarget] = useState(defaultSeconds);
  /** The clock reading the current render is drawn from. Advanced by the tick. */
  const [now, setNow] = useState(0);
  const notified = useRef(false);

  // Derived, never accumulated. A throttled or suspended interval changes how
  // often this is recomputed, not what it says.
  const elapsed = startedAt === null ? null : Math.max(0, Math.floor((now - startedAt) / 1000));

  /*
   * The restore.
   *
   * It is an effect rather than a `useState` initialiser for the reason
   * `lib/offline/useDraft.ts` records: local storage is an external system, it
   * does not exist on the server, and reading it during a render would be both
   * impure and a hydration mismatch — the server would render "start rest" and
   * the client would render "1:12", which React resolves by discarding one of
   * them unpredictably.
   *
   * `restore` is a function rather than a straight-line effect body because it
   * is also the `storage` listener, and that is not a formality: `storage`
   * fires in *other* documents of the same origin, so a second tab opened on
   * the logger adopts the rest already running in the first instead of showing
   * a stopped clock for the same workout. Whichever tab the operator happens to
   * be looking at when they finish a set is the one they will use.
   *
   * Every write is an updater that declines to overwrite a clock that is
   * already running. A restore fills a gap; it never reaches back and resets a
   * rest the operator started a moment ago.
   */
  useEffect(() => {
    const restore = (): void => {
      const reading = systemClock.nowMillis();
      const persisted = loadRest(store, reading);
      if (persisted === null) return;

      // Already past its target when the page came back: the alert has
      // notionally happened, and buzzing now would be news from four minutes ago.
      notified.current = reading - persisted.startedAt >= persisted.target * 1000;

      setStartedAt((current) => current ?? persisted.startedAt);
      setTarget((current) => (current === defaultSeconds ? persisted.target : current));
      setNow((current) => (current === 0 ? reading : current));
    };

    restore();
    window.addEventListener('storage', restore);
    return () => {
      window.removeEventListener('storage', restore);
    };
  }, [store, defaultSeconds]);

  useEffect(() => {
    if (startedAt === null) return;

    const sample = (): void => {
      const reading = systemClock.nowMillis();
      setNow(reading);

      if (!notified.current && Math.floor((reading - startedAt) / 1000) >= target) {
        notified.current = true;
        if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
          // Two short pulses. Long enough to feel through a pocket, short
          // enough not to read as an alarm.
          navigator.vibrate([120, 80, 120]);
        }
      }
    };

    const interval = window.setInterval(sample, 1000);
    /*
     * Re-sampled the instant the tab wakes.
     *
     * Without this the first post-wake reading waits up to a second, which
     * would be a non-issue — except that a *suspended* interval may not fire at
     * all until the next second boundary, and the operator is looking at the
     * screen right now.
     */
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') sample();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [startedAt, target]);

  const start = useCallback(
    (seconds?: number) => {
      notified.current = false;
      const nextTarget = seconds ?? target;
      if (seconds !== undefined) setTarget(seconds);
      // Both from one reading, so the first render shows 0:00 rather than a
      // fraction of a second's drift between the two.
      const reading = systemClock.nowMillis();
      setStartedAt(reading);
      setNow(reading);
      saveRest(store, { startedAt: reading, target: nextTarget });
    },
    [store, target],
  );

  const stop = useCallback(() => {
    notified.current = false;
    setStartedAt(null);
    clearRest(store);
  }, [store]);

  const adjust = useCallback(
    (deltaSeconds: number) => {
      setTarget((current) => {
        const next = Math.max(MIN_REST_SECONDS, current + deltaSeconds);
        /*
         * Mirrored from inside the updater because the adjustment is relative:
         * two taps in the same frame must persist 120 s, not 105 s twice. The
         * write is skipped when no clock is running, which is the case where the
         * "start rest" button is showing a target rather than counting one down.
         */
        if (startedAt !== null) saveRest(store, { startedAt, target: next });
        return next;
      });
      // Adjusting the target past the elapsed time re-arms the alert, so adding
      // thirty seconds mid-rest buzzes again when they are up.
      notified.current = false;
    },
    [store, startedAt],
  );

  return {
    elapsed,
    remaining: elapsed === null ? null : Math.max(0, target - elapsed),
    target,
    isResting: startedAt !== null,
    isOverdue: elapsed !== null && elapsed >= target,
    start,
    stop,
    adjust,
  };
}
