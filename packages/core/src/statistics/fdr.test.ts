import { describe, expect, it } from 'vitest';

import { benjaminiHochberg } from './fdr';

describe('benjaminiHochberg', () => {
  it('is inert on an empty battery', () => {
    expect(benjaminiHochberg([])).toEqual({ rejected: [], threshold: null, alpha: 0.05, comparisons: 0 });
  });

  it('rejects up to the largest index that clears its bound', () => {
    // m = 5, α = 0.05, so the bounds are 0.01, 0.02, 0.03, 0.04, 0.05.
    // Only k = 1 and k = 2 clear theirs; the cutoff is the second p-value.
    const result = benjaminiHochberg([0.001, 0.008, 0.039, 0.041, 0.9]);
    expect(result.threshold).toBe(0.008);
    expect(result.rejected).toEqual([true, true, false, false, false]);
  });

  it('is step-up, not step-down: a later clearing index pulls the middle back in', () => {
    // Same first four p-values, but k = 5 now clears 0.05 — so everything
    // below it is rejected too. This is the property that distinguishes
    // Benjamini–Hochberg from a naive "reject while the bound holds" loop, and
    // getting it wrong makes the correction quietly stricter than specified.
    const result = benjaminiHochberg([0.009, 0.011, 0.039, 0.041, 0.042]);
    expect(result.threshold).toBe(0.042);
    expect(result.rejected).toEqual([true, true, true, true, true]);
  });

  it('rejects nothing when the smallest p-value misses its bound', () => {
    const result = benjaminiHochberg([0.02, 0.6, 0.7]);
    expect(result.threshold).toBeNull();
    expect(result.rejected).toEqual([false, false, false]);
  });

  it('is stricter as the battery grows — the point of the correction', () => {
    expect(benjaminiHochberg([0.04]).rejected).toEqual([true]);
    const wide = benjaminiHochberg([0.04, ...Array<number>(50).fill(0.9)]);
    expect(wide.rejected[0]).toBe(false);
    expect(wide.comparisons).toBe(51);
  });

  it('gives tied p-values the same decision regardless of order', () => {
    const result = benjaminiHochberg([0.01, 0.01, 0.9, 0.9]);
    expect(result.rejected).toEqual([true, true, false, false]);
  });

  it('treats a non-finite or out-of-range entry as p = 1 rather than dropping it', () => {
    const result = benjaminiHochberg([0.001, Number.NaN, 4, -1]);
    expect(result.comparisons).toBe(4);
    expect(result.rejected).toEqual([true, false, false, false]);
  });

  it('honours a custom alpha', () => {
    expect(benjaminiHochberg([0.04], 0.01).rejected).toEqual([false]);
  });
});
