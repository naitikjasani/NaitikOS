/**
 * Hybrid logical clocks — §5.7's third structural property.
 *
 *   "Hybrid logical clocks on every write. Physical time on a phone is
 *    untrustworthy — timezone changes, clock drift, manual adjustment. An HLC
 *    gives a total causal order that survives all three."
 *
 * ## The problem, concretely
 *
 * The operator logs a set in a gym basement at 19:04 by the phone's clock. The
 * phone's clock is four minutes fast. Twenty minutes later the phone syncs, and
 * the server has to decide whether that set happened before or after a
 * bodyweight entry the laptop wrote at 19:02. Wall time says the set came
 * first. Causality says the opposite, and causality is right.
 *
 * A pure logical clock (Lamport) would order them correctly but produce
 * timestamps with no relationship to real time, so a five-year trend chart
 * could not use them. Physical time alone orders them wrongly. An HLC is the
 * pair: it tracks wall time closely enough to be *readable*, and it never goes
 * backwards, so it is also *sortable*.
 *
 * ## What this is not
 *
 * Not a replacement for `observed_at`. `observed_at` is when the fact was true
 * and it is what the user sees; the HLC is the write order and it is what the
 * system sorts by when two writes claim the same instant. Conflating them would
 * put clock-drift artifacts into the clinical record.
 *
 * ## Encoding
 *
 * `<12 hex: wall millis><4 hex: counter>-<node>` — for example
 * `01991f3c2a80-0003-3fa9b2c1de40`.
 *
 * Fixed width, so **lexicographic string order is causal order**. That is the
 * property the whole encoding exists for: `ORDER BY hlc` in Postgres, `.sort()`
 * in JavaScript, and `compareHlc` all agree without anybody parsing anything.
 * Twelve hex digits of milliseconds runs out in the year 10889 (C2 asks for
 * twenty years, so this is not the binding constraint).
 */

import type { Brand } from '@naitikos/shared';

/** An encoded HLC timestamp. Sortable as a plain string. */
export type Hlc = Brand<string, 'Hlc'>;

/** A device's clock state. Immutable; every operation returns a new one. */
export type HlcState = {
  /** Logical wall time, in milliseconds. Never decreases. */
  readonly wallMillis: number;
  /** Disambiguates events within the same logical millisecond. */
  readonly counter: number;
  /** Stable per device. A tiebreaker, not an authority — see {@link nodeIdFrom}. */
  readonly nodeId: string;
};

const WALL_HEX_DIGITS = 12;
const COUNTER_HEX_DIGITS = 4;
const MAX_COUNTER = 0xffff;
const NODE_HEX_DIGITS = 12;

/**
 * How far ahead of the local clock a received timestamp may be before it is
 * treated as a fault rather than as skew.
 *
 * §5.8 asks for skew "beyond five minutes ... flagged in diagnostics rather
 * than silently absorbed". Absorbing a *large* jump is worse than flagging it:
 * a phone whose clock was manually set to 2031 would otherwise drag the logical
 * clock forward five years, and every subsequent write on every device would
 * inherit that, permanently. The state is unrecoverable because the clock can
 * never go backwards. So the drift ceiling is a containment boundary, not a
 * warning.
 */
export const MAX_CLOCK_DRIFT_MS = 5 * 60 * 1000;

/**
 * Derive a node id from a device identifier.
 *
 * The last twelve hex digits of the device UUID: fixed width for the sort
 * property, and the *last* digits rather than the first because a UUIDv7's
 * leading bits are a timestamp shared by every device provisioned the same
 * millisecond.
 *
 * This is a tiebreaker for simultaneous writes and nothing more. It is not an
 * identity claim, it is not authenticated, and no authorization decision may
 * read it — §5.4 keeps authorization in one place, and it is not here.
 */
export function nodeIdFrom(deviceId: string): string {
  const hex = deviceId.replace(/[^0-9a-f]/gi, '').toLowerCase();
  return hex.slice(-NODE_HEX_DIGITS).padStart(NODE_HEX_DIGITS, '0');
}

export function initialHlcState(deviceId: string, physicalMillis = 0): HlcState {
  return { wallMillis: physicalMillis, counter: 0, nodeId: nodeIdFrom(deviceId) };
}

export function formatHlc(state: HlcState): Hlc {
  const wall = state.wallMillis.toString(16).padStart(WALL_HEX_DIGITS, '0');
  const counter = state.counter.toString(16).padStart(COUNTER_HEX_DIGITS, '0');
  return `${wall}${counter}-${state.nodeId}` as Hlc;
}

export function parseHlc(text: string): HlcState | null {
  const match = /^([0-9a-f]{12})([0-9a-f]{4})-([0-9a-f]{12})$/.exec(text);
  if (match === null) return null;
  const [, wall, counter, nodeId] = match;
  return {
    wallMillis: Number.parseInt(wall as string, 16),
    counter: Number.parseInt(counter as string, 16),
    nodeId: nodeId as string,
  };
}

/**
 * Total order over encoded timestamps.
 *
 * A plain string comparison, and that is the point of the fixed-width encoding
 * — this function exists so call sites read as an intent rather than so it can
 * do anything clever. Keep it that way: the moment it parses, Postgres's
 * `ORDER BY hlc` and this function stop agreeing.
 */
export function compareHlc(a: Hlc, b: Hlc): -1 | 0 | 1 {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Why a clock advance was refused or adjusted. */
export type ClockAnomaly =
  /** The local clock ran backwards. Logical time held; no data is at risk. */
  | 'local_regression'
  /** A peer's timestamp was implausibly far ahead. See {@link MAX_CLOCK_DRIFT_MS}. */
  | 'remote_drift'
  /** More than 65,535 events in one logical millisecond. Wall time borrowed one. */
  | 'counter_overflow';

export type HlcTick = {
  readonly state: HlcState;
  readonly hlc: Hlc;
  /** Non-empty when the caller should record something in diagnostics (§5.8). */
  readonly anomalies: readonly ClockAnomaly[];
};

/**
 * Advance the clock for a local write.
 *
 * `l' = max(l, pt)`; the counter increments when logical time did not move and
 * resets when it did. Kulkarni et al., unchanged — this is a published
 * algorithm and deviating from it to "simplify" is how the ordering guarantee
 * gets quietly lost.
 */
export function hlcTick(state: HlcState, physicalMillis: number): HlcTick {
  const anomalies: ClockAnomaly[] = [];

  const wallMillis = Math.max(state.wallMillis, physicalMillis);
  if (physicalMillis < state.wallMillis) anomalies.push('local_regression');

  let counter = wallMillis === state.wallMillis ? state.counter + 1 : 0;
  let logical = wallMillis;
  if (counter > MAX_COUNTER) {
    // Borrow a millisecond rather than wrap. Wrapping would make the encoding
    // non-monotonic, which is the one thing it must never be.
    logical = wallMillis + 1;
    counter = 0;
    anomalies.push('counter_overflow');
  }

  const next: HlcState = { wallMillis: logical, counter, nodeId: state.nodeId };
  return { state: next, hlc: formatHlc(next), anomalies };
}

/**
 * Merge a peer's timestamp into this clock.
 *
 * Called when the server accepts a write carrying a client HLC, and when a
 * client reconciles a sync response. Both directions matter: without the merge,
 * two devices' clocks never converge and the total order is only total per
 * device.
 */
export function hlcReceive(state: HlcState, remote: Hlc, physicalMillis: number): HlcTick {
  const parsed = parseHlc(remote);
  if (parsed === null) {
    // An unparseable peer timestamp is treated as no timestamp. Rejecting the
    // whole write instead would let one malformed record block a drain forever,
    // and §5.7 is explicit that "a failed drain must never silently discard a
    // write" — a stuck drain is the same loss wearing a different face.
    return hlcTick(state, physicalMillis);
  }

  const anomalies: ClockAnomaly[] = [];

  let remoteWall = parsed.wallMillis;
  if (remoteWall > physicalMillis + MAX_CLOCK_DRIFT_MS) {
    // Clamp rather than adopt. See MAX_CLOCK_DRIFT_MS: adopting an implausible
    // future would poison the logical clock permanently.
    remoteWall = physicalMillis + MAX_CLOCK_DRIFT_MS;
    anomalies.push('remote_drift');
  }

  const wallMillis = Math.max(state.wallMillis, remoteWall, physicalMillis);
  if (physicalMillis < state.wallMillis) anomalies.push('local_regression');

  let counter: number;
  if (wallMillis === state.wallMillis && wallMillis === remoteWall) {
    counter = Math.max(state.counter, parsed.counter) + 1;
  } else if (wallMillis === state.wallMillis) {
    counter = state.counter + 1;
  } else if (wallMillis === remoteWall) {
    counter = parsed.counter + 1;
  } else {
    counter = 0;
  }

  let logical = wallMillis;
  if (counter > MAX_COUNTER) {
    logical = wallMillis + 1;
    counter = 0;
    anomalies.push('counter_overflow');
  }

  const next: HlcState = { wallMillis: logical, counter, nodeId: state.nodeId };
  return { state: next, hlc: formatHlc(next), anomalies };
}

/**
 * Skew between this device and a peer, in milliseconds. Positive means the peer
 * is ahead. Persisted to `sync_state.clock_skew_ms` (§5.8).
 */
export function clockSkewMs(remote: Hlc, physicalMillis: number): number | null {
  const parsed = parseHlc(remote);
  return parsed === null ? null : parsed.wallMillis - physicalMillis;
}
