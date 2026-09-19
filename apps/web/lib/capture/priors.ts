/**
 * The last value this device recorded for a metric.
 *
 * §8.10: *"**Last value pre-filled** wherever a sensible prior exists.
 * Confirming beats typing."* §4.1 says the same thing again, harder, about the
 * set logger: "typing a weight from scratch every set is a P1 violation."
 *
 * ## The arithmetic that makes this necessary
 *
 * Bodyweight is a `number` control with a step of 0.1 kg and a floor of 20. A
 * stepper that starts from nothing starts from the floor, so recording 74.2 kg
 * is five hundred and forty-two presses of `+`. Sleep duration steps by half an
 * hour from zero: fifteen presses for a normal night, every morning, forever.
 * Both are technically typeable into the text input beside the stepper, and
 * both are P1 failures — §1.3 budgets a logging interaction at "under five
 * seconds, under three taps, from a cold start" and neither of those is
 * survivable at 6am.
 *
 * With a prior, both become *confirm, or nudge once*.
 *
 * ## Why this is not on the server
 *
 * It could be, and one day it should be — the record already holds every
 * observation and the last one is a query. It is here because the alternative
 * costs a round trip in the middle of a sheet that opens instantly, and §2.2
 * budgets quick capture at ten seconds end to end. A prior that arrives after
 * the operator has already started tapping is worse than no prior: the value
 * changes under their thumb.
 *
 * The consequence is stated rather than hidden: a prior is per-device. A weight
 * logged on a laptop does not pre-fill the phone. That is acceptable because a
 * missing prior degrades to today's behaviour exactly, and because capture
 * happens on one device in practice.
 *
 * ## Why a prior is never silently submitted
 *
 * Nothing in this module writes an answer. A caller decides whether a prior is
 * a *default* — correct for quick capture, where opening the weight sheet is
 * already the intent to record a weight — or an *offer*, which is what the
 * Daily Close does, because §4.0 makes every Close field optional and a
 * pre-filled sleep duration submitted untouched would be a fabricated
 * measurement in a medical record.
 */

import { systemClock } from '@naitikos/core';

/** Namespaced and versioned, so a shape change cannot be read as the old one. */
const PRIOR_KEY_PREFIX = 'naitikos.prior.v1.';

/**
 * How stale a prior may be before it stops being a sensible default.
 *
 * Ninety days, matching §1.5's trailing window — not because the two are
 * related, but because it is the horizon this product already treats as "recent
 * enough to reason from". A bodyweight from last quarter is a worse guess than
 * a bodyweight from last night and a much better one than the 20 kg floor of
 * the stepper; a bodyweight from two years ago is neither, and an expiry is
 * cheaper than explaining to the operator why the field opened on a number from
 * a different body.
 */
const PRIOR_TTL_MS = 90 * 24 * 60 * 60 * 1000;

type StoredPrior = {
  readonly value: number;
  readonly at: number;
};

/**
 * `localStorage`, or `null` where it is not usable.
 *
 * Returns `null` rather than throwing on the server, in a private window, and
 * behind the storage-blocked settings some browsers ship. Every caller treats a
 * missing prior as "there isn't one", which is the same code path as the first
 * ever capture, so a blocked store costs a feature rather than a screen.
 */
function priorStorage(): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * The last value recorded on this device for `metricKey`, or `null`.
 *
 * Anything unparseable, non-finite, or older than {@link PRIOR_TTL_MS} reads as
 * `null` and is not repaired. A prior is a convenience with a zero-cost
 * fallback, so the correct response to a corrupt one is to ignore it — a
 * migration path for a cache would be more code than the cache.
 */
export function readPrior(metricKey: string): number | null {
  const store = priorStorage();
  if (store === null) return null;

  let raw: string | null;
  try {
    raw = store.getItem(`${PRIOR_KEY_PREFIX}${metricKey}`);
  } catch {
    return null;
  }
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const candidate = parsed as Partial<StoredPrior>;
  if (typeof candidate.value !== 'number' || !Number.isFinite(candidate.value)) return null;
  if (typeof candidate.at !== 'number') return null;
  if (systemClock.nowMillis() - candidate.at > PRIOR_TTL_MS) return null;

  return candidate.value;
}

/**
 * Remember `value` as the prior for `metricKey`.
 *
 * Called after a write is durable, never on keystroke. A prior recorded while
 * the operator is still adjusting the stepper would mean an abandoned sheet
 * changes tomorrow's default, and the failure would be invisible: the number is
 * plausible, it is simply not the one they meant.
 *
 * Failures are swallowed. A full or blocked quota must not surface as an error
 * on a capture that has already succeeded — the observation is recorded, and
 * the only thing lost is a convenience the next capture can live without.
 */
export function writePrior(metricKey: string, value: number): void {
  const store = priorStorage();
  if (store === null || !Number.isFinite(value)) return;

  const entry: StoredPrior = { value, at: systemClock.nowMillis() };
  try {
    store.setItem(`${PRIOR_KEY_PREFIX}${metricKey}`, JSON.stringify(entry));
  } catch {
    /* See above. A prior is never worth a failed capture. */
  }
}
