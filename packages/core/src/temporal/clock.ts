/**
 * The clock. The one sanctioned place in the system that reads wall time.
 *
 * §11.3 bans raw `Date` construction repo-wide via `no-restricted-syntax`, and
 * the ban needs somewhere to point. This is it.
 *
 * ## Why a clock is an object rather than a function call
 *
 * Two reasons, and neither is testing convenience alone.
 *
 * §5.8 states plainly that device clocks are untrustworthy: "Physical time on a
 * phone is untrustworthy — timezone changes, clock drift, manual adjustment."
 * Code that calls `Date.now()` inline has no way to be handed a corrected time,
 * and no way to be told it is running against a hybrid logical clock instead
 * (§5.7). An injected clock can be replaced with one that knows better.
 *
 * And the step-up window in `auth/actor.ts` is a security boundary measured in
 * time. A test that cannot control the clock cannot assert that a fifteen-minute
 * window actually closes — it can only assert that the code compiles.
 *
 * ## What this deliberately is not
 *
 * Not a date library, and not the timezone-aware helpers §5.3 requires for
 * observations. Those are the rest of `temporal/`, still to be written
 * (§12, Week 1–2). This is the narrow piece the identity layer needs: an
 * injectable source of "now".
 */

/** A source of the current instant. */
export type Clock = {
  /** The current instant as a `Date`. Always UTC internally. */
  now(): Date;
  /** The current instant in epoch milliseconds — for UUIDv7 and HLCs. */
  nowMillis(): number;
};

/**
 * The real clock.
 *
 * The `eslint-disable` below is the single permitted `new Date()` in the
 * codebase, and it is permitted precisely because everything else is banned
 * from doing it. Moving this line, or adding a second one elsewhere, defeats
 * the rule.
 */
export const systemClock: Clock = Object.freeze({
  now(): Date {
    // eslint-disable-next-line no-restricted-syntax -- The sanctioned clock (§11.3). Every other site injects a Clock instead.
    return new Date();
  },
  nowMillis(): number {
    // eslint-disable-next-line no-restricted-syntax -- As above.
    return Date.now();
  },
});

/**
 * A clock frozen at a fixed instant, for tests.
 *
 * Lives in the source tree rather than a test helper because it is part of the
 * contract: anything taking a `Clock` should be exercisable against a known
 * time without importing test infrastructure.
 */
export function fixedClock(instant: Date): Clock {
  const millis = instant.getTime();
  return Object.freeze({
    // A fresh Date each call, so a caller mutating the result cannot corrupt
    // the clock for everyone else.
    // eslint-disable-next-line no-restricted-syntax -- Derived from an injected instant, not read from the wall clock. That is the distinction §11.3 cares about.
    now: () => new Date(millis),
    nowMillis: () => millis,
  });
}

/**
 * A clock that advances only when told to.
 *
 * For asserting that a time-bounded rule actually expires — the step-up window
 * being the case that matters today.
 */
export function manualClock(start: Date): Clock & { advance(ms: number): void } {
  let millis = start.getTime();
  return {
    // eslint-disable-next-line no-restricted-syntax -- As in fixedClock: derived from an injected instant.
    now: () => new Date(millis),
    nowMillis: () => millis,
    advance: (ms: number) => {
      millis += ms;
    },
  };
}
