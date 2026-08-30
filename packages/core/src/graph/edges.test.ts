/**
 * §10.2's edge model, tested on its refusals.
 */

import { describe, expect, it } from 'vitest';

import { EDGE_TYPES, buildEdge, edgeKey, edgeOriginFor } from './edges';

const STATS = {
  method: 'spearman' as const,
  n: 90,
  effect: 0.45,
  pValue: 0.001,
  windowDays: 90,
  lagDays: 2,
};

describe('edge types', () => {
  it('has no causal edge, and that absence is load-bearing', () => {
    /* §10.2: "No edge is ever labelled causal... Causation is a claim only a
     * clinician makes." Same class of absence as the insight schema's missing
     * `diagnosis` field. */
    for (const type of EDGE_TYPES) {
      expect(type).not.toMatch(/CAUSE/u);
    }
  });

  it('permits TRIGGERS only as an assertion, never as a computation', () => {
    /*
     * "Conflating them would let a hunch harden into a fact through repetition
     * — which is exactly how people acquire wrong ideas about their own bodies."
     */
    expect(edgeOriginFor('TRIGGERS', 'asserted')).toBe('asserted');
    expect(edgeOriginFor('TRIGGERS', 'computed')).toBeNull();
  });

  it('permits CORRELATES_WITH only as a computation, never as an assertion', () => {
    /* The other half of the same distinction. A believed correlation is a
     * TRIGGERS edge, and calling it CORRELATES_WITH would give a hunch the
     * appearance of a test. */
    expect(edgeOriginFor('CORRELATES_WITH', 'computed')).toBe('computed');
    expect(edgeOriginFor('CORRELATES_WITH', 'asserted')).toBeNull();
  });
});

describe('buildEdge', () => {
  it('refuses a computed edge with no observations behind it', () => {
    /* §9.3: "edges reference observations". An edge with none renders
     * identically to a real one and cannot be audited (P4). */
    const result = buildEdge({
      sourceNodeId: 'a',
      targetNodeId: 'b',
      type: 'CORRELATES_WITH',
      origin: 'computed',
      statistics: STATS,
      observationIds: [],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.reason).toBe('computed_without_evidence');
  });

  it('refuses a computed edge with no statistics', () => {
    const result = buildEdge({
      sourceNodeId: 'a',
      targetNodeId: 'b',
      type: 'CORRELATES_WITH',
      origin: 'computed',
      observationIds: ['o1'],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.reason).toBe('computed_without_statistics');
  });

  it('accepts a recorded edge with neither, because a prescription is not an inference', () => {
    const result = buildEdge({
      sourceNodeId: 'med',
      targetNodeId: 'condition',
      type: 'PRESCRIBED_FOR',
      origin: 'recorded',
    });

    expect(result.ok).toBe(true);
  });

  it('refuses a self-edge', () => {
    const result = buildEdge({
      sourceNodeId: 'a',
      targetNodeId: 'a',
      type: 'CO_OCCURS_WITH',
      origin: 'computed',
      statistics: STATS,
      observationIds: ['o1'],
    });
    expect(result.ok).toBe(false);
  });

  it('sets weight from |effect| and clamps it', () => {
    const result = buildEdge({
      sourceNodeId: 'a',
      targetNodeId: 'b',
      type: 'CORRELATES_WITH',
      origin: 'computed',
      statistics: { ...STATS, effect: -0.6 },
      observationIds: ['o1'],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    /* A strong negative association is a strong association. Weight ranks
     * traversal; the sign lives in the statistics. */
    expect(result.edge.weight).toBeCloseTo(0.6, 10);
  });
});

describe('edgeKey', () => {
  it('keeps direction, because PRECEDES is not symmetric', () => {
    const forward = edgeKey({ sourceNodeId: 'a', targetNodeId: 'b', type: 'PRECEDES' });
    const backward = edgeKey({ sourceNodeId: 'b', targetNodeId: 'a', type: 'PRECEDES' });
    expect(forward).not.toBe(backward);
  });
});
