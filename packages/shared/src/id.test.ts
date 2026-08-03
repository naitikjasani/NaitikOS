import { describe, expect, it } from 'vitest';

import {
  createUuidV7Generator,
  isUuid,
  isUuidV7,
  timestampFromUuidV7,
  uuidV7,
} from './id';

/**
 * Blueprint §5.7 depends on these properties for offline correctness: a record
 * created in a gym basement must carry its permanent, correctly-ordered
 * identity from the moment it exists. Monotonicity under a backwards clock
 * (§5.8) is the case most likely to be got wrong and least likely to be
 * noticed.
 */
describe('uuidV7', () => {
  const T = 1_754_000_000_000; // 2025-08-01T00:53:20Z

  it('produces canonical UUID form', () => {
    expect(isUuid(uuidV7(T))).toBe(true);
  });

  it('sets version 7 and the RFC 9562 variant bits', () => {
    const id = uuidV7(T);
    expect(id[14]).toBe('7');
    expect(isUuidV7(id)).toBe(true);
    // Variant is 0b10xx → first hex of the 4th group is 8, 9, a, or b.
    expect(['8', '9', 'a', 'b']).toContain(id[19]);
  });

  it('round-trips the embedded timestamp', () => {
    expect(timestampFromUuidV7(uuidV7(T))).toBe(T);
  });

  it('sorts lexicographically in creation order', () => {
    const gen = createUuidV7Generator();
    const ids = [gen.next(T), gen.next(T + 1), gen.next(T + 2), gen.next(T + 1000)];
    expect([...ids].sort()).toEqual(ids);
  });

  it('stays monotonic within a single millisecond', () => {
    const gen = createUuidV7Generator();
    const ids = Array.from({ length: 500 }, () => gen.next(T));

    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
  });

  it('stays monotonic when the clock jumps backwards', () => {
    // §5.8: device clocks drift, get NTP-corrected, and get manually adjusted.
    // A backwards jump must never produce an ID that sorts before one already
    // issued, or the append-only timeline (§9.1) silently reorders.
    const gen = createUuidV7Generator();
    const before = gen.next(T + 10_000);
    const after = gen.next(T); // clock moved backwards 10s

    expect(after > before).toBe(true);
  });

  it('borrows the next millisecond when the 12-bit counter is exhausted', () => {
    const gen = createUuidV7Generator();
    const ids = Array.from({ length: 5000 }, () => gen.next(T));

    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
  });

  it('rejects timestamps outside the 48-bit field', () => {
    expect(() => uuidV7(-1)).toThrow(RangeError);
    expect(() => uuidV7(1.5)).toThrow(RangeError);
    expect(() => uuidV7(2 ** 49)).toThrow(RangeError);
  });

  it('rejects non-v7 input when extracting a timestamp', () => {
    expect(timestampFromUuidV7('not-a-uuid')).toBeNull();
    // A well-formed v4 UUID must not be mistaken for v7.
    expect(timestampFromUuidV7('9f1b7c2e-4a3d-4f6b-8c1d-2e3f4a5b6c7d')).toBeNull();
  });
});
