'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { systemClock } from '@naitikos/core';

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
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [target, setTarget] = useState(defaultSeconds);
  /** The clock reading the current render is drawn from. Advanced by the tick. */
  const [now, setNow] = useState(0);
  const notified = useRef(false);

  // Derived, never accumulated. A throttled or suspended interval changes how
  // often this is recomputed, not what it says.
  const elapsed = startedAt === null ? null : Math.max(0, Math.floor((now - startedAt) / 1000));

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

  const start = useCallback((seconds?: number) => {
    notified.current = false;
    if (seconds !== undefined) setTarget(seconds);
    // Both from one reading, so the first render shows 0:00 rather than a
    // fraction of a second's drift between the two.
    const reading = systemClock.nowMillis();
    setStartedAt(reading);
    setNow(reading);
  }, []);

  const stop = useCallback(() => {
    notified.current = false;
    setStartedAt(null);
  }, []);

  const adjust = useCallback((deltaSeconds: number) => {
    setTarget((current) => Math.max(15, current + deltaSeconds));
    // Adjusting the target past the elapsed time re-arms the alert, so adding
    // thirty seconds mid-rest buzzes again when they are up.
    notified.current = false;
  }, []);

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
