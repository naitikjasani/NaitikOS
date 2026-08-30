/**
 * §10.11's cap.
 *
 * The tests are about the *edges*, because a cap that is approximately enforced
 * is one nobody trusts — and §5.16 makes this fail-closed.
 */

import { describe, expect, it } from 'vitest';

import { MONTHLY_CAP_MINOR, checkBudget, estimateCostMinor } from './budget';

describe('budget', () => {
  it('refuses a call that would cross the cap, rather than noticing afterwards', () => {
    /*
     * Checking only the spend so far means the cap is exceeded by exactly one
     * call every month, forever — and given the routing table that call is the
     * Opus one.
     */
    const verdict = checkBudget({ spentMinor: MONTHLY_CAP_MINOR - 10, estimatedMinor: 50 });
    expect(verdict.allowed).toBe(false);
    expect(verdict.state).toBe('exhausted');
  });

  it('allows a call that lands exactly on the cap', () => {
    const verdict = checkBudget({ spentMinor: MONTHLY_CAP_MINOR - 50, estimatedMinor: 50 });
    expect(verdict.allowed).toBe(true);
  });

  it('warns at 70% without blocking', () => {
    const verdict = checkBudget({ spentMinor: Math.ceil(MONTHLY_CAP_MINOR * 0.75), estimatedMinor: 0 });
    expect(verdict.state).toBe('warning');
    expect(verdict.allowed).toBe(true);
  });

  it('says what still works when it blocks', () => {
    /* §13.1 lists abandonment as the fatal risk. A fail-closed message that
     * reads like the app is broken is a reason to stop opening it; one that
     * says every number is unaffected is not. */
    const verdict = checkBudget({ spentMinor: MONTHLY_CAP_MINOR, estimatedMinor: 100 });
    expect(verdict.sentence).toContain('without a model');
  });

  it('rounds an estimate up, never down', () => {
    /* A tenth of a cent per call, over a nightly batch, is how a cap becomes
     * approximate. */
    const cost = estimateCostMinor({ task: 'narrate_insight', inputTokens: 1, outputTokens: 1 });
    expect(cost).toBe(1);
  });

  it('halves the batch path, per §10.11', () => {
    const full = estimateCostMinor({ task: 'narrate_insight', inputTokens: 1_000_000, outputTokens: 100_000 });
    const batch = estimateCostMinor({
      task: 'narrate_insight',
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      batch: true,
    });
    expect(batch).toBeLessThan(full);
    expect(batch).toBe(Math.ceil(full / 2));
  });

  it('prices Opus above Haiku for the same tokens, which is what makes routing matter', () => {
    const opus = estimateCostMinor({ task: 'ask', inputTokens: 100_000, outputTokens: 10_000 });
    const haiku = estimateCostMinor({ task: 'parse_meal', inputTokens: 100_000, outputTokens: 10_000 });
    expect(opus).toBeGreaterThan(haiku);
  });
});
