import { describe, expect, it } from 'vitest';

import type { Narration, Reference } from '../schemas/references';
import {
  UNRESOLVED_MARKER,
  isFullyResolved,
  referenceKey,
  referencesIn,
  renderNarration,
  renderedToText,
} from './narration';

const OBSERVATION: Reference = { kind: 'observation', observationId: '11111111-1111-4111-8111-111111111111' };
const OTHER: Reference = { kind: 'observation', observationId: '22222222-2222-4222-8222-222222222222' };
const METRIC: Reference = { kind: 'metric', metricKey: 'body.weight' };

function narration(template: string, references: readonly Reference[] = []): Narration {
  /* `Narration` comes from a Zod inference and its `references` is mutable.
   * Copying keeps the test literals readonly without widening the type. */
  return { template, references: [...references] };
}

describe('referenceKey', () => {
  it('is structural, so the same target from two paragraphs is one key', () => {
    expect(referenceKey(OBSERVATION)).toBe(referenceKey({ ...OBSERVATION }));
  });

  it('includes the field for a statistic', () => {
    // `r` and `n` of one finding are two different figures. A key on the
    // finding alone would render whichever was fetched last for both.
    const finding = '33333333-3333-4333-8333-333333333333';
    const asR = referenceKey({ kind: 'statistic', findingId: finding, field: 'r' });
    const asN = referenceKey({ kind: 'statistic', findingId: finding, field: 'n' });

    expect(asR).not.toBe(asN);
  });

  it('distinguishes the kinds', () => {
    const keys = new Set([
      referenceKey(OBSERVATION),
      referenceKey(METRIC),
      referenceKey({ kind: 'entity', nodeId: OBSERVATION.observationId }),
      referenceKey({ kind: 'document', documentId: OBSERVATION.observationId }),
    ]);

    expect(keys.size).toBe(4);
  });
});

describe('renderNarration', () => {
  it('substitutes a resolved value and keeps the prose around it', () => {
    const rendered = renderNarration(
      narration('Weight was {0} this morning.', [OBSERVATION]),
      new Map([[referenceKey(OBSERVATION), '74.2 kg']]),
    );

    expect(renderedToText(rendered)).toBe('Weight was 74.2 kg this morning.');
    expect(rendered.segments.map((s) => s.kind)).toEqual(['text', 'value', 'text']);
    expect(isFullyResolved(rendered)).toBe(true);
  });

  it('marks the value segment so the UI can say it came from the record', () => {
    // §10.10's guarantee is invisible if a resolved figure looks exactly like a
    // written one.
    const rendered = renderNarration(
      narration('{0} today.', [OBSERVATION]),
      new Map([[referenceKey(OBSERVATION), '74.2 kg']]),
    );

    const [first] = rendered.segments;
    expect(first?.kind).toBe('value');
    if (first?.kind === 'value') expect(first.reference).toEqual(OBSERVATION);
  });

  it('renders a gap rather than dropping an unresolvable reference', () => {
    // Substituting nothing gives "Weight was this morning" — a sentence that
    // reads as complete and is missing its subject, which is worse than either
    // the slot or an error because it looks fine.
    const rendered = renderNarration(narration('Weight was {0} this morning.', [OBSERVATION]), new Map());

    expect(renderedToText(rendered)).toBe(`Weight was ${UNRESOLVED_MARKER} this morning.`);
    expect(rendered.unresolved).toEqual([OBSERVATION]);
    expect(isFullyResolved(rendered)).toBe(false);
  });

  it('never renders a number for an unresolved reference', () => {
    const rendered = renderNarration(narration('{0}', [OBSERVATION]), new Map());

    expect(renderedToText(rendered)).not.toMatch(/\d/);
  });

  it('renders a repeated slot from one reference', () => {
    // `{0} rose, then {0} fell` is an ordinary English sentence. Forcing the
    // model to emit the same reference twice to say it would be a worse schema.
    const rendered = renderNarration(
      narration('{0} rose, then {0} fell.', [OBSERVATION]),
      new Map([[referenceKey(OBSERVATION), 'mood']]),
    );

    expect(renderedToText(rendered)).toBe('mood rose, then mood fell.');
  });

  it('handles slots out of order', () => {
    const rendered = renderNarration(
      narration('{1} before {0}.', [OBSERVATION, OTHER]),
      new Map([
        [referenceKey(OBSERVATION), 'first'],
        [referenceKey(OTHER), 'second'],
      ]),
    );

    expect(renderedToText(rendered)).toBe('second before first.');
  });

  it('handles adjacent slots with no prose between them', () => {
    const rendered = renderNarration(
      narration('{0}{1}', [OBSERVATION, OTHER]),
      new Map([
        [referenceKey(OBSERVATION), 'a'],
        [referenceKey(OTHER), 'b'],
      ]),
    );

    expect(renderedToText(rendered)).toBe('ab');
    expect(rendered.segments).toHaveLength(2);
  });

  it('passes prose with no slots through untouched', () => {
    const rendered = renderNarration(narration('Nothing to substitute here.'), new Map());

    expect(renderedToText(rendered)).toBe('Nothing to substitute here.');
    expect(isFullyResolved(rendered)).toBe(true);
  });

  it('reports a slot pointing past the reference list', () => {
    // `narrationSchema` refuses this, so it should be unreachable — but an
    // answer read back from a table in three years has not been through the
    // schema, and trusting it would put literal braces on the page.
    const rendered = renderNarration(narration('{0} and {5}.', [OBSERVATION]), new Map([[referenceKey(OBSERVATION), 'x']]));

    expect(rendered.orphanSlots).toEqual([5]);
    expect(isFullyResolved(rendered)).toBe(false);
    expect(renderedToText(rendered)).toBe(`x and ${UNRESOLVED_MARKER}.`);
  });

  it('leaves a lone brace alone', () => {
    const rendered = renderNarration(narration('A { brace and a } brace.'), new Map());

    expect(renderedToText(rendered)).toBe('A { brace and a } brace.');
  });
});

describe('referencesIn', () => {
  it('deduplicates across paragraphs, in order of first use', () => {
    // One observation named in four paragraphs should cost one row read.
    const found = referencesIn([
      narration('{0}', [OBSERVATION]),
      narration('{0} and {1}', [OBSERVATION, METRIC]),
      narration('{0}', [OTHER]),
    ]);

    expect(found).toEqual([OBSERVATION, METRIC, OTHER]);
  });

  it('returns the declared references, not only the ones a slot names', () => {
    // Fetching the declared list is the shape that cannot under-fetch. An
    // unused reference costs one wasted read; a missed one is a visible gap.
    const found = referencesIn([narration('no slots at all', [OBSERVATION])]);

    expect(found).toEqual([OBSERVATION]);
  });

  it('is empty for narrations with no references', () => {
    expect(referencesIn([narration('plain prose')])).toEqual([]);
  });
});
