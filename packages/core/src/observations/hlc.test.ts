import { describe, expect, it } from 'vitest';

import {
  type Hlc,
  MAX_CLOCK_DRIFT_MS,
  clockSkewMs,
  compareHlc,
  formatHlc,
  hlcReceive,
  hlcTick,
  initialHlcState,
  nodeIdFrom,
  parseHlc,
} from './hlc';

const PHONE = '01991f3c-2a80-7000-8000-3fa9b2c1de40';
const LAPTOP = '01991f3c-2a80-7000-8000-aabbccddeeff';

describe('nodeIdFrom', () => {
  /**
   * The *last* twelve hex digits, not the first: a UUIDv7's leading bits are a
   * timestamp, so two devices provisioned in the same millisecond would share a
   * prefix and stop being distinguishable as tiebreakers.
   */
  it('takes the trailing hex digits of the device id', () => {
    expect(nodeIdFrom(PHONE)).toBe('3fa9b2c1de40');
    expect(nodeIdFrom(LAPTOP)).toBe('aabbccddeeff');
    expect(nodeIdFrom(PHONE)).not.toBe(nodeIdFrom(LAPTOP));
  });

  it('is fixed width even for a short or non-hex device id', () => {
    expect(nodeIdFrom('abc')).toHaveLength(12);
    expect(nodeIdFrom('')).toBe('000000000000');
    expect(nodeIdFrom('device-one')).toHaveLength(12);
  });
});

describe('encoding', () => {
  it('round-trips', () => {
    const state = { wallMillis: 1_754_000_000_000, counter: 3, nodeId: nodeIdFrom(PHONE) };
    expect(parseHlc(formatHlc(state))).toEqual(state);
  });

  it('rejects anything that is not the fixed-width form', () => {
    expect(parseHlc('')).toBeNull();
    expect(parseHlc('nonsense')).toBeNull();
    expect(parseHlc('01991f3c2a80-0003')).toBeNull();
    expect(parseHlc('01991F3C2A800003-3fa9b2c1de40')).toBeNull();
  });

  /**
   * The property the whole encoding exists for. `ORDER BY hlc` in Postgres,
   * `.sort()` in JavaScript and `compareHlc` all have to agree without anybody
   * parsing anything — which is only true while the width is fixed.
   */
  it('sorts lexicographically in causal order', () => {
    const node = nodeIdFrom(PHONE);
    const earlier = formatHlc({ wallMillis: 1_754_000_000_000, counter: 9, nodeId: node });
    const later = formatHlc({ wallMillis: 1_754_000_000_001, counter: 0, nodeId: node });

    expect(compareHlc(earlier, later)).toBe(-1);
    expect([later, earlier].sort()).toEqual([earlier, later]);
    expect(earlier < later).toBe(true);
    expect(compareHlc(earlier, earlier)).toBe(0);
  });

  it('keeps counter order within a millisecond', () => {
    const node = nodeIdFrom(PHONE);
    const first = formatHlc({ wallMillis: 1_754_000_000_000, counter: 2, nodeId: node });
    const second = formatHlc({ wallMillis: 1_754_000_000_000, counter: 10, nodeId: node });
    expect(compareHlc(first, second)).toBe(-1);
  });
});

describe('hlcTick', () => {
  it('follows the physical clock forward and resets the counter', () => {
    const start = initialHlcState(PHONE, 1000);
    const first = hlcTick(start, 2000);
    expect(first.state).toMatchObject({ wallMillis: 2000, counter: 0 });

    const second = hlcTick(first.state, 3000);
    expect(second.state).toMatchObject({ wallMillis: 3000, counter: 0 });
  });

  it('increments the counter for writes in the same millisecond', () => {
    let state = initialHlcState(PHONE, 1000);
    const issued: Hlc[] = [];
    for (let i = 0; i < 5; i += 1) {
      const tick = hlcTick(state, 1000);
      state = tick.state;
      issued.push(tick.hlc);
    }
    expect(state.counter).toBe(5);
    expect([...issued].sort()).toEqual(issued);
  });

  /**
   * §5.7's whole justification: "Physical time on a phone is untrustworthy —
   * timezone changes, clock drift, manual adjustment." Logical time must not
   * follow a clock that goes backwards, or two writes get the same order twice.
   */
  it('never goes backwards when the local clock does', () => {
    const start = hlcTick(initialHlcState(PHONE, 0), 5000);
    const backwards = hlcTick(start.state, 1000);

    expect(backwards.state.wallMillis).toBe(5000);
    expect(backwards.state.counter).toBe(1);
    expect(backwards.anomalies).toContain('local_regression');
    expect(compareHlc(start.hlc, backwards.hlc)).toBe(-1);
  });

  it('borrows a millisecond rather than wrapping the counter', () => {
    const saturated = { wallMillis: 1000, counter: 0xffff, nodeId: nodeIdFrom(PHONE) };
    const tick = hlcTick(saturated, 1000);

    expect(tick.state.wallMillis).toBe(1001);
    expect(tick.state.counter).toBe(0);
    expect(tick.anomalies).toContain('counter_overflow');
    expect(compareHlc(formatHlc(saturated), tick.hlc)).toBe(-1);
  });
});

describe('hlcReceive', () => {
  /**
   * The scenario §5.7 describes: a phone four minutes fast writes a set, syncs
   * twenty minutes later, and the server must not let the phone's drift decide
   * the order of everything that followed.
   */
  it('converges two devices onto one order', () => {
    const phone = initialHlcState(PHONE, 1_000_000);
    const server = initialHlcState(LAPTOP, 1_000_000);

    // The phone writes while offline, with a clock four minutes fast.
    const phoneWrite = hlcTick(phone, 1_000_000 + 240_000);

    // The server receives it twenty minutes later by its own correct clock.
    const received = hlcReceive(server, phoneWrite.hlc, 1_000_000 + 1_200_000);

    expect(compareHlc(phoneWrite.hlc, received.hlc)).toBe(-1);
    expect(received.state.wallMillis).toBe(1_000_000 + 1_200_000);
  });

  it('advances past a peer that shares the logical millisecond', () => {
    const node = nodeIdFrom(LAPTOP);
    const local = { wallMillis: 5000, counter: 2, nodeId: node };
    const remote = formatHlc({ wallMillis: 5000, counter: 7, nodeId: nodeIdFrom(PHONE) });

    const received = hlcReceive(local, remote, 4000);
    expect(received.state).toMatchObject({ wallMillis: 5000, counter: 8 });
    expect(compareHlc(remote, received.hlc)).toBe(-1);
  });

  it('takes the peer’s counter when the peer is ahead of local logical time', () => {
    const local = { wallMillis: 4000, counter: 9, nodeId: nodeIdFrom(LAPTOP) };
    const remote = formatHlc({ wallMillis: 5000, counter: 3, nodeId: nodeIdFrom(PHONE) });

    const received = hlcReceive(local, remote, 4500);
    expect(received.state).toMatchObject({ wallMillis: 5000, counter: 4 });
  });

  /**
   * The containment boundary. Adopting a wildly-future peer timestamp would
   * drag the logical clock forward permanently — it can never go back — so
   * every subsequent write on every device would inherit the fault.
   */
  it('clamps an implausibly future peer instead of adopting it', () => {
    const local = initialHlcState(LAPTOP, 1_000_000);
    const fiveYearsOn = formatHlc({
      wallMillis: 1_000_000 + 5 * 365 * 24 * 3_600_000,
      counter: 0,
      nodeId: nodeIdFrom(PHONE),
    });

    const received = hlcReceive(local, fiveYearsOn, 1_000_000);
    expect(received.anomalies).toContain('remote_drift');
    expect(received.state.wallMillis).toBe(1_000_000 + MAX_CLOCK_DRIFT_MS);
  });

  it('absorbs drift inside the ceiling without flagging it', () => {
    const local = initialHlcState(LAPTOP, 1_000_000);
    const slightlyAhead = formatHlc({
      wallMillis: 1_000_000 + 60_000,
      counter: 0,
      nodeId: nodeIdFrom(PHONE),
    });

    const received = hlcReceive(local, slightlyAhead, 1_000_000);
    expect(received.anomalies).not.toContain('remote_drift');
    expect(received.state.wallMillis).toBe(1_060_000);
  });

  /**
   * §5.7: "A failed drain must never silently discard a write." A malformed
   * peer timestamp that rejected the whole write would block the drain forever,
   * which is the same loss wearing a different face.
   */
  it('treats an unparseable peer timestamp as no timestamp rather than an error', () => {
    const local = initialHlcState(LAPTOP, 1000);
    const received = hlcReceive(local, 'garbage' as Hlc, 2000);
    expect(received.state.wallMillis).toBe(2000);
  });

  it('borrows a millisecond on overflow during a receive', () => {
    const node = nodeIdFrom(LAPTOP);
    const local = { wallMillis: 5000, counter: 0xffff, nodeId: node };
    const remote = formatHlc({ wallMillis: 5000, counter: 0xffff, nodeId: nodeIdFrom(PHONE) });

    const received = hlcReceive(local, remote, 4000);
    expect(received.anomalies).toContain('counter_overflow');
    expect(received.state.wallMillis).toBe(5001);
    expect(received.state.counter).toBe(0);
  });
});

describe('clockSkewMs', () => {
  it('reports how far ahead a peer is, for sync diagnostics (§5.8)', () => {
    const remote = formatHlc({ wallMillis: 1_000_000 + 90_000, counter: 0, nodeId: nodeIdFrom(PHONE) });
    expect(clockSkewMs(remote, 1_000_000)).toBe(90_000);
    expect(clockSkewMs('garbage' as Hlc, 1_000_000)).toBeNull();
  });
});
