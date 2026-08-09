import { describe, expect, it } from 'vitest';

import { levelFor } from './AdherenceGrid';

/**
 * The one distinction the grid exists to preserve.
 *
 * §9.2, about medication but true of everything: "a day with no record is not
 * counted as a missed dose — absence of data is not evidence of non-adherence,
 * and conflating them makes every figure quietly wrong."
 */
describe('levelFor', () => {
  it('separates “no record” from “recorded, and it was zero”', () => {
    expect(levelFor(undefined, 10)).toBe(0);
    // Zero volume is a session that happened. It gets the palest *filled* step,
    // never the empty one.
    expect(levelFor(0, 10)).toBe(1);
  });

  it('shades by magnitude, in four steps', () => {
    expect(levelFor(1, 100)).toBe(1);
    expect(levelFor(25, 100)).toBe(1);
    expect(levelFor(26, 100)).toBe(2);
    expect(levelFor(50, 100)).toBe(2);
    expect(levelFor(75, 100)).toBe(3);
    expect(levelFor(100, 100)).toBe(4);
  });

  it('never exceeds the top step, however large the value', () => {
    expect(levelFor(1000, 100)).toBe(4);
  });

  /**
   * A binary grid — "did it happen" with no magnitude — passes 1 for every
   * recorded day and gets a single shade, which is correct: there is nothing to
   * encode.
   */
  it('gives a binary grid one filled shade', () => {
    expect(levelFor(1, 1)).toBe(4);
    expect(levelFor(undefined, 1)).toBe(0);
  });

  it('does not divide by zero when nothing has a value', () => {
    expect(levelFor(0, 0)).toBe(1);
    expect(levelFor(5, 0)).toBe(1);
  });
});
