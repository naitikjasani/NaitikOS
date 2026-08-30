/**
 * §10.4's classifier.
 *
 * Deterministic on purpose: this decides which data classes get fetched, and a
 * model in that path would mean a misclassification is a retrieval the operator
 * did not consent to rather than merely a worse answer.
 */

import { describe, expect, it } from 'vitest';

import { classifyQuestion, resolveWindowDays } from './classify';

describe('classifyQuestion', () => {
  it('reads a why-question as causal', () => {
    expect(classifyQuestion('why has my skin been worse this month')).toBe('causal');
  });

  it('prefers the wider class when a question matches two', () => {
    /*
     * Guessing narrow produces an answer assembled from too little, which reads
     * as confident and is missing the thing that mattered. Guessing wide costs
     * tokens, which the budget step already handles.
     */
    expect(classifyQuestion('why was my mood low last month')).toBe('causal');
  });

  it('reads clinical vocabulary as clinical', () => {
    expect(classifyQuestion('what did my last vitamin D lab say')).toBe('clinical');
  });

  it('falls back to status rather than guessing', () => {
    /* The cheapest retrieval, which is the right default when the classifier is
     * guessing. */
    expect(classifyQuestion('protein')).toBe('status');
  });
});

describe('resolveWindowDays', () => {
  it('honours an explicit window over the kind default', () => {
    expect(resolveWindowDays('why was my mood low last month', 'causal')).toBe(30);
  });

  it('does not read "last year" as "ever"', () => {
    /* The ordering matters: an "ever" rule placed first would swallow it. */
    expect(resolveWindowDays('how has my weight moved over the last year', 'temporal')).toBe(365);
  });

  it('uses a short window for a status question and a long one for a clinical one', () => {
    expect(resolveWindowDays('protein', 'status')).toBeLessThan(resolveWindowDays('lab', 'clinical'));
  });
});
