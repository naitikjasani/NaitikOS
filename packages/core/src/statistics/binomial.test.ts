import { describe, expect, it } from 'vitest';

import { binomialTailBelow, logChoose, logGamma } from './binomial';

describe('logGamma', () => {
  it('reproduces small factorials', () => {
    // Γ(n+1) = n!
    expect(Math.exp(logGamma(1))).toBeCloseTo(1, 9);
    expect(Math.exp(logGamma(5))).toBeCloseTo(24, 7);
    expect(Math.exp(logGamma(11))).toBeCloseTo(3_628_800, 2);
  });

  it('knows Γ(1/2) = √π', () => {
    expect(Math.exp(logGamma(0.5))).toBeCloseTo(Math.sqrt(Math.PI), 9);
  });

  it('is NaN outside the domain', () => {
    expect(Number.isNaN(logGamma(0))).toBe(true);
    expect(Number.isNaN(logGamma(-2))).toBe(true);
    expect(Number.isNaN(logGamma(Number.NaN))).toBe(true);
  });
});

describe('logChoose', () => {
  it('matches exact binomial coefficients', () => {
    expect(Math.exp(logChoose(10, 3))).toBeCloseTo(120, 6);
    expect(Math.exp(logChoose(52, 5))).toBeCloseTo(2_598_960, -1);
  });

  it('is -∞ outside the range', () => {
    expect(logChoose(5, 6)).toBe(Number.NEGATIVE_INFINITY);
    expect(logChoose(5, -1)).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe('binomialTailBelow', () => {
  it('matches a hand-computed small case', () => {
    // P(X ≤ 1) for n = 5, p = 0.5 is 6/32.
    expect(binomialTailBelow(1, 5, 0.5)).toBeCloseTo(6 / 32, 12);
  });

  it('is 1 at the top of the range and 0 below the bottom', () => {
    expect(binomialTailBelow(5, 5, 0.3)).toBe(1);
    expect(binomialTailBelow(-1, 5, 0.3)).toBe(0);
  });

  it('does not underflow to zero on a long high-adherence history', () => {
    // The naive `(1-p)^n` implementation returns exactly 0 here, which would
    // make every finding clear every threshold. See the header of binomial.ts.
    const p = binomialTailBelow(170, 180, 0.97);
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(0.05);
  });

  it('is unsurprised by a run at the established rate', () => {
    expect(binomialTailBelow(13, 14, 0.95)).toBeGreaterThan(0.3);
  });

  it('is surprised by a run well below it', () => {
    expect(binomialTailBelow(7, 14, 0.95)).toBeLessThan(0.001);
  });

  it('handles the degenerate rates without producing NaN', () => {
    expect(binomialTailBelow(0, 10, 0)).toBe(1);
    expect(binomialTailBelow(3, 10, 1)).toBe(0);
  });

  it('returns 1 for a window with nothing in it', () => {
    expect(binomialTailBelow(0, 0, 0.9)).toBe(1);
    expect(binomialTailBelow(0, -4, 0.9)).toBe(1);
    expect(binomialTailBelow(1.5, 10, 0.9)).toBe(1);
  });

  it('returns 1 for a rate outside [0, 1] rather than a nonsense probability', () => {
    expect(binomialTailBelow(3, 10, 1.4)).toBe(1);
    expect(binomialTailBelow(3, 10, Number.NaN)).toBe(1);
  });

  it('is monotone in k', () => {
    let previous = -1;
    for (let k = 0; k <= 20; k += 1) {
      const value = binomialTailBelow(k, 20, 0.6);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
    expect(previous).toBe(1);
  });
});
