/**
 * §10.11's routing table, as a set of claims rather than a lookup.
 */

import { describe, expect, it } from 'vitest';

import { AI_TASKS, MODELS, ROUTES, TASK_PURPOSE } from './routing';

describe('routing', () => {
  it('routes the P1 capture path to the cheapest, fastest model', () => {
    /* §10.11: "High volume, narrow, latency-sensitive, in the P1 capture path."
     * Routing this to Opus would put a multi-second call inside §2.2's
     * ten-second budget. */
    expect(ROUTES.parse_meal.model).toBe(MODELS.haiku);
    expect(ROUTES.parse_meal.batch).toBe(false);
  });

  it('routes the two highest-stakes outputs to Opus at xhigh', () => {
    expect(ROUTES.consultation_pack.model).toBe(MODELS.opus);
    expect(ROUTES.consultation_pack.effort).toBe('xhigh');
    expect(ROUTES.monthly_review.effort).toBe('xhigh');
  });

  it('gives the thinking models room, because max_tokens bounds thinking too', () => {
    /*
     * On Opus 5 thinking is on by default and `max_tokens` bounds thinking plus
     * response together. A ceiling carried over from a non-thinking model
     * truncates mid-answer — for a pack, a page of questions that stops
     * halfway and reads like a printer fault.
     */
    expect(ROUTES.ask.maxTokens).toBeGreaterThanOrEqual(32_000);
    expect(ROUTES.consultation_pack.maxTokens).toBeGreaterThanOrEqual(32_000);
  });

  it('runs the nightly pipeline in batch and the interactive paths not', () => {
    /* §10.11: "Nothing overnight is latency-sensitive, so nothing overnight
     * pays full price." */
    expect(ROUTES.narrate_insight.batch).toBe(true);
    expect(ROUTES.classify_journal.batch).toBe(true);
    expect(ROUTES.ask.batch).toBe(false);
    expect(ROUTES.consultation_pack.batch).toBe(false);
  });

  it('gives every task a route, a purpose and a stated reason', () => {
    for (const task of AI_TASKS) {
      expect(ROUTES[task]).toBeDefined();
      expect(TASK_PURPOSE[task]).toBeDefined();
      /* The `why` is §10.11's own justification kept beside the decision. An
       * empty one means a route was added without one. */
      expect(ROUTES[task].why.length).toBeGreaterThan(20);
    }
  });

  it('exposes no temperature anywhere', () => {
    /* §10.11: "Sampling parameters are unavailable on Opus 5 and Sonnet 5...
     * Any design assuming a temperature knob is invalid." */
    for (const task of AI_TASKS) {
      expect(Object.keys(ROUTES[task])).not.toContain('temperature');
    }
  });
});
