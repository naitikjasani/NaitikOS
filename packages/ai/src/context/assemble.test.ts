/**
 * §10.4's assembly, tested on the two things that fail silently.
 *
 * A destroyed cache does not error and a truncated pack does not error. Both
 * show up months later — one as a bill, the other as an answer that read
 * complete and was not.
 */

import { describe, expect, it } from 'vitest';

import { NO_CONSENT, fromStoredScope } from '../guardrails/consent';
import type { ContextItem } from './assemble';
import { assemble, scoreItem, stableBlockProblems } from './assemble';

function item(overrides: Partial<ContextItem> = {}): ContextItem {
  return {
    id: 'i1',
    retrievalClass: 'observation',
    text: 'Mood: mean 3.4 over 88 recorded days, sd 0.8.',
    recency: 0.5,
    relevance: 0.5,
    strength: 0.5,
    ...overrides,
  };
}

const GRANT = fromStoredScope('journal');

describe('the stable prefix', () => {
  it('refuses a prefix containing a timestamp', () => {
    /*
     * §10.4 names this exact bug: "a `new Date()` interpolated into the profile
     * block would silently destroy cache hits across every request in the
     * system". Silently is the operative word — nothing errors, nothing slows
     * perceptibly, and it appears as a bill.
     */
    const result = assemble({
      stableBlocks: ['Profile: assembled at 2026-12-01T09:14:22Z'],
      items: [],
      question: 'how is my sleep',
      grant: GRANT,
      tokenBudget: 10_000,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems[0]).toContain('cache boundary');
  });

  it('refuses a relative time reference, which moves just as reliably', () => {
    expect(stableBlockProblems('Currently at 82 kg today.')).not.toHaveLength(0);
  });

  it('accepts a prefix of stable facts', () => {
    const result = assemble({
      stableBlocks: ['Profile: vegetarian plus eggs. Trains four days a week, push/pull/legs/upper.'],
      items: [],
      question: 'how is my sleep',
      grant: GRANT,
      tokenBudget: 10_000,
    });
    expect(result.ok).toBe(true);
  });

  it('is byte-identical across two assemblies with the same inputs', () => {
    /* The property the whole split exists for. If this ever fails, the prefix
     * is not cacheable and nothing else about the design matters. */
    const input = {
      stableBlocks: ['Profile: vegetarian plus eggs.', 'Protocols: evening skincare routine.'],
      items: [item()],
      question: 'how is my sleep',
      grant: GRANT,
      tokenBudget: 10_000,
    };

    const first = assemble(input);
    const second = assemble({ ...input, question: 'a completely different question' });

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.pack.stable).toBe(second.pack.stable);
  });
});

describe('the budget', () => {
  it('states what it dropped rather than truncating silently', () => {
    /* §10.4: "Never silently truncate — state what was omitted." An answer
     * assembled from a partial pack that does not say so reads complete. */
    const items = Array.from({ length: 20 }, (_, index) =>
      item({ id: `i${String(index)}`, text: 'x'.repeat(400), relevance: index / 20 }),
    );

    const result = assemble({
      stableBlocks: ['Profile: stable.'],
      items,
      question: 'why',
      grant: GRANT,
      tokenBudget: 300,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pack.droppedIds.length).toBeGreaterThan(0);
    expect(result.pack.omitted).toContain('context budget');
  });

  it('claims "nothing was omitted" explicitly rather than by silence', () => {
    /* An empty field is indistinguishable from a step that forgot to fill it. */
    const result = assemble({
      stableBlocks: ['Profile: stable.'],
      items: [item()],
      question: 'why',
      grant: GRANT,
      tokenBudget: 10_000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pack.omitted).toBe('Nothing was omitted.');
  });

  it('keeps a pinned item even when it breaks the budget', () => {
    /*
     * The other three signals are the system's guesses about what matters; the
     * pin is the operator telling it. Dropping a pin because a
     * four-characters-per-token estimate said so is the system overruling them
     * on the strength of an approximation.
     */
    const result = assemble({
      stableBlocks: ['Profile: stable.'],
      items: [item({ id: 'pinned', text: 'y'.repeat(4000), pinned: true, relevance: 0 })],
      question: 'why',
      grant: GRANT,
      tokenBudget: 50,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pack.included.map((entry) => entry.id)).toContain('pinned');
  });
});

describe('consent at assembly', () => {
  it('drops an unconsented class and names the setting rather than apologising', () => {
    /*
     * Two different absences. Something dropped for budget is a limitation of
     * this answer; something refused by consent is a choice the operator made
     * and can unmake, so the sentence points at the setting.
     */
    const result = assemble({
      stableBlocks: ['Profile: stable.'],
      items: [item({ id: 'j', retrievalClass: 'journal' })],
      grant: fromStoredScope('clinical'),
      question: 'how have I been feeling',
      tokenBudget: 10_000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pack.included).toHaveLength(0);
    expect(result.pack.refusedClasses).toContain('journal');
    expect(result.pack.omitted).toContain('consent scope is off');
  });

  it('retrieves nothing at all under no consent', () => {
    const result = assemble({
      stableBlocks: ['Profile: stable.'],
      items: [item(), item({ id: 'i2', retrievalClass: 'lab' })],
      grant: NO_CONSENT,
      question: 'anything',
      tokenBudget: 10_000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pack.included).toHaveLength(0);
  });
});

describe('ranking', () => {
  it('weights relevance above recency, so March beats yesterday when it matters', () => {
    /*
     * Lexicographic ordering on recency would put yesterday's irrelevant note
     * above a strongly-relevant finding from March, which for a causal question
     * is exactly backwards.
     */
    const relevantOld = item({ id: 'old', recency: 0.1, relevance: 1, strength: 0.9 });
    const irrelevantNew = item({ id: 'new', recency: 1, relevance: 0.1, strength: 0.1 });

    expect(scoreItem(relevantOld)).toBeGreaterThan(scoreItem(irrelevantNew));
  });

  it('clamps a score into 0–1 whatever it is handed', () => {
    expect(scoreItem(item({ recency: 99, relevance: 99, strength: 99 }))).toBeLessThanOrEqual(1);
    expect(scoreItem(item({ recency: Number.NaN, relevance: -5, strength: 0 }))).toBe(0);
  });
});
