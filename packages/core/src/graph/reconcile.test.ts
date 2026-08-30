/* eslint-disable @naitikos/no-bare-quantity -- Every `weight` in this file is
 * |rho|: a dimensionless scalar used to rank graph traversal. §6.2's rule
 * protects *measured quantities* from losing their unit, and a rank-order
 * correlation coefficient has none to lose. Disabled at file scope rather than
 * per line because the exemption is a property of the whole module. */
/**
 * §10.2's "the graph gets quieter", tested as the behaviour it is.
 *
 * An accumulating graph does not error. It just quietly gets worse, and there
 * is no moment at which anyone would notice — which is why removal gets more
 * tests here than addition does.
 */

import { describe, expect, it } from 'vitest';

import type { GraphEdge } from './edges';
import type { StoredEdge } from './reconcile';
import { UNSUPPORTED_NIGHTS_BEFORE_REMOVAL, edgesForCorrelation, reconcileEdges } from './reconcile';

function edge(overrides: Partial<GraphEdge> = {}): GraphEdge {
  return {
    sourceNodeId: 'a',
    targetNodeId: 'b',
    type: 'CORRELATES_WITH',
    origin: 'computed',
    weight: 0.45,
    statistics: { method: 'spearman', n: 90, effect: 0.45, pValue: 0.001, windowDays: 90, lagDays: 0 },
    observationIds: ['o1'],
    ...overrides,
  };
}

function stored(overrides: Partial<StoredEdge> = {}): StoredEdge {
  return { ...edge(), id: 'e1', unsupportedNights: 0, ...overrides };
}

describe('reconcileEdges', () => {
  it('adds an edge that is new tonight', () => {
    const result = reconcileEdges({ derived: [edge()], stored: [] });
    expect(result.added).toHaveLength(1);
  });

  it('refreshes an unchanged edge without rewriting it', () => {
    /* Rho moves in the fourth decimal every night. Writing each of those turns
     * a quiet job into a full rewrite and fills the audit log with changes
     * nobody made. */
    const result = reconcileEdges({ derived: [edge()], stored: [stored()] });
    expect(result.refreshed).toEqual(['e1']);
    expect(result.updated).toHaveLength(0);
  });

  it('updates when the reported effect actually moves', () => {
    const result = reconcileEdges({
      derived: [edge({ statistics: { method: 'spearman', n: 91, effect: 0.61, pValue: 0.0001, windowDays: 90, lagDays: 0 } })],
      stored: [stored()],
    });
    expect(result.updated).toHaveLength(1);
  });

  it('does not remove an edge after a single quiet night', () => {
    /*
     * One night of missing data is a holiday, not a change in the world. An
     * edge that took ninety days to establish should not be demolished by one
     * unlogged Tuesday.
     */
    const result = reconcileEdges({ derived: [], stored: [stored()] });
    expect(result.removed).toHaveLength(0);
    expect(result.decayed).toEqual(['e1']);
  });

  it('removes an edge on the third consecutive unsupported night', () => {
    /* §10.2's "washed out". This is the half an accumulating graph never
     * implements. */
    const result = reconcileEdges({
      derived: [],
      stored: [stored({ unsupportedNights: UNSUPPORTED_NIGHTS_BEFORE_REMOVAL - 1 })],
    });
    expect(result.removed).toEqual(['e1']);
  });

  it('never removes an asserted edge, however long the data disagrees', () => {
    /*
     * A TRIGGERS edge is the operator's belief. A job that deleted it because
     * the statistics stopped supporting it would be the system overruling the
     * person about their own body. The honest outcome is that the graph holds
     * both — the belief, and the absent correlation.
     */
    const belief = stored({
      id: 'belief',
      type: 'TRIGGERS',
      origin: 'asserted',
      statistics: null,
      unsupportedNights: 999,
    });

    const result = reconcileEdges({ derived: [], stored: [belief] });
    expect(result.removed).toHaveLength(0);
    expect(result.refreshed).toEqual(['belief']);
  });

  it('never removes a recorded edge', () => {
    /* A prescription in the record is a fact about the record. A statistical
     * job has no standing to delete it. */
    const prescription = stored({
      id: 'rx',
      type: 'PRESCRIBED_FOR',
      origin: 'recorded',
      statistics: null,
      unsupportedNights: 999,
    });

    expect(reconcileEdges({ derived: [], stored: [prescription] }).removed).toHaveLength(0);
  });

  it('does not admit an edge below the retention weight', () => {
    /* Something that never met the threshold should not enter and then be
     * removed three nights later — that is churn, not reconciliation. */
    const weak = edge({ weight: 0.05, statistics: { method: 'spearman', n: 90, effect: 0.05, pValue: 0.2, windowDays: 90, lagDays: 0 } });
    expect(reconcileEdges({ derived: [weak], stored: [] }).added).toHaveLength(0);
  });

  it('gets quieter, not louder, across a run of unsupported nights', () => {
    /*
     * The property §10.2 actually asserts, stated as a property. Three nights
     * of no support and the graph is empty; an accumulating implementation
     * would still hold the edge in year three.
     */
    let graph: StoredEdge[] = [stored()];

    for (let night = 0; night < UNSUPPORTED_NIGHTS_BEFORE_REMOVAL; night += 1) {
      const result = reconcileEdges({ derived: [], stored: graph });
      graph = graph
        .filter((entry) => !result.removed.includes(entry.id))
        .map((entry) =>
          result.decayed.includes(entry.id)
            ? { ...entry, unsupportedNights: entry.unsupportedNights + 1 }
            : entry,
        );
    }

    expect(graph).toHaveLength(0);
  });
});

describe('edgesForCorrelation', () => {
  it('emits both an association and a precedence when there is a lag', () => {
    /* Two different claims: they move together, and one moved first. Emitting
     * only PRECEDES would strongly imply the causation §10.2 forbids. */
    const edges = edgesForCorrelation({
      sourceNodeId: 'a',
      targetNodeId: 'b',
      rho: 0.5,
      n: 90,
      pValue: 0.001,
      lagDays: 2,
      windowDays: 90,
      observationIds: ['o1'],
    });

    expect(edges.map((entry) => entry.type)).toEqual(['CORRELATES_WITH', 'PRECEDES']);
  });

  it('emits no precedence at lag zero, because same-day is a weaker claim', () => {
    const edges = edgesForCorrelation({
      sourceNodeId: 'a',
      targetNodeId: 'b',
      rho: 0.5,
      n: 90,
      pValue: 0.001,
      lagDays: 0,
      windowDays: 90,
      observationIds: ['o1'],
    });

    expect(edges).toHaveLength(1);
    expect(edges[0]?.type).toBe('CORRELATES_WITH');
  });
});
