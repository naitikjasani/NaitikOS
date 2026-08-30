/**
 * The knowledge graph's edge model — §10.2.
 *
 * ## The one rule that shapes everything else
 *
 *   "**No edge is ever labelled causal.** The graph contains temporal
 *    precedence, statistical association, and clinical relationships from the
 *    medical record. Causation is a claim only a clinician makes."
 *
 * There is no `CAUSES` in {@link EDGE_TYPES} and there never will be. That is
 * not a gap to be filled later; it is the load-bearing absence, in the same way
 * that the insight schema's missing `diagnosis` field is (§10.10).
 *
 * ## `TRIGGERS` and `CORRELATES_WITH` are different kinds of thing
 *
 *   "The distinction... is doing real work. `TRIGGERS` is the user's belief,
 *    recorded as a belief; `CORRELATES_WITH` is a computed association.
 *    Conflating them would let a hunch harden into a fact through repetition —
 *    which is exactly how people acquire wrong ideas about their own bodies."
 *
 * So {@link EdgeOrigin} is a required field, and a `TRIGGERS` edge can only ever
 * be `asserted`. {@link edgeOriginFor} refuses the other combinations rather
 * than defaulting, because a default here is precisely the conflation the
 * blueprint warns about.
 *
 * ## The graph is supposed to get quieter
 *
 *   "Edges are recomputed as evidence accumulates and are **removed when they
 *    no longer meet threshold** — which means the graph gets *quieter* as data
 *    accumulates and spurious early associations wash out, which is the correct
 *    behaviour."
 *
 * That is the opposite of what a naive accumulating graph does, and it is why
 * {@link reconcileEdges} returns removals as a first-class part of its output
 * rather than only additions.
 */

/** §10.2's edge types, exactly. */
export const EDGE_TYPES = Object.freeze([
  /** Temporal, with a lag distribution. Computed. */
  'PRECEDES',
  /** Statistical, with r, n, p and the window. Computed. */
  'CORRELATES_WITH',
  /** Clinical, from the record. */
  'PRESCRIBED_FOR',
  /** Compositional — food → nutrient. Structural. */
  'CONTAINS',
  /** Structural — exercise → muscle group. */
  'PART_OF',
  /** The user's belief, recorded as a belief. **Never inferred.** */
  'TRIGGERS',
  /** Clinical. */
  'TREATS',
  /** Statistical. */
  'CO_OCCURS_WITH',
] as const);

export type EdgeType = (typeof EDGE_TYPES)[number];

/**
 * Where an edge came from, which determines what it is allowed to mean.
 *
 * - `computed` — a statistical test produced it. Carries a p-value and an n,
 *   is subject to the battery's controls, and washes out when it stops holding.
 * - `recorded` — it is in the medical record or the structural registry. A
 *   prescription is a fact about the record, not an inference from data.
 * - `asserted` — the operator said so. Never promoted to `computed` by
 *   repetition, and never demoted by a failing test: a belief that the data
 *   does not support is still the belief, and the system's job is to hold both.
 */
export type EdgeOrigin = 'computed' | 'recorded' | 'asserted';

/** Which origins each edge type permits. The empty combination is impossible. */
export const PERMITTED_ORIGINS: Readonly<Record<EdgeType, readonly EdgeOrigin[]>> = Object.freeze({
  PRECEDES: Object.freeze(['computed'] as const),
  CORRELATES_WITH: Object.freeze(['computed'] as const),
  PRESCRIBED_FOR: Object.freeze(['recorded'] as const),
  CONTAINS: Object.freeze(['recorded'] as const),
  PART_OF: Object.freeze(['recorded'] as const),
  /* The whole point. A trigger is a belief and stays one. */
  TRIGGERS: Object.freeze(['asserted'] as const),
  TREATS: Object.freeze(['recorded'] as const),
  CO_OCCURS_WITH: Object.freeze(['computed'] as const),
});

/**
 * The origin an edge type takes, or `null` if the combination is not permitted.
 *
 * Returning `null` rather than throwing, because the caller is a nightly job
 * building thousands of edges and one bad combination should drop one edge, not
 * the night's run. The `null` is not swallowed — {@link buildEdge} reports it.
 */
export function edgeOriginFor(type: EdgeType, origin: EdgeOrigin): EdgeOrigin | null {
  return PERMITTED_ORIGINS[type].includes(origin) ? origin : null;
}

/**
 * Statistical support, carried on the edge rather than looked up.
 *
 * §10.2: "every edge stores the observations that support it **and the
 * statistical method that produced it**". Method included, because an edge
 * built by Spearman over ranked taps and one built by a binomial test over
 * doses are different claims, and a reader who cannot tell which is which
 * cannot audit either.
 */
export type EdgeStatistics = {
  readonly method: 'spearman' | 'binomial' | 'count';
  readonly n: number;
  /** Spearman's rho, or the effect for a non-correlational method. */
  readonly effect: number;
  readonly pValue: number | null;
  readonly windowDays: number;
  /** Days the source leads the target by. 0 for same-day, absent for non-temporal. */
  readonly lagDays: number | null;
};

export type GraphEdge = {
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly type: EdgeType;
  readonly origin: EdgeOrigin;
  /**
   * |effect|, 0–1, for ranking during traversal. Not a confidence and not a
   * probability — an edge with weight 0.6 is not "60% true".
   */
  readonly weight: number;
  readonly statistics: EdgeStatistics | null;
  /**
   * The observations behind it. §9.3: "edges reference observations."
   *
   * An edge with an empty list and a `computed` origin is an assertion the
   * system is not entitled to make (P4), and {@link buildEdge} refuses it.
   */
  readonly observationIds: readonly string[];
};

export type EdgeRejection = {
  readonly reason:
    | 'origin_not_permitted'
    | 'computed_without_evidence'
    | 'computed_without_statistics'
    | 'self_edge';
  readonly type: EdgeType;
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
};

export type EdgeResult =
  | { readonly ok: true; readonly edge: GraphEdge }
  | { readonly ok: false; readonly rejection: EdgeRejection };

/**
 * Build an edge, or say why not.
 *
 * The refusals are the interesting part. A computed edge with no observations
 * behind it and a computed edge with no statistics are both edges that would
 * render identically to a real one and could not be audited — which is the
 * failure mode §9.3 attaches the evidence list to prevent.
 */
export function buildEdge(input: {
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly type: EdgeType;
  readonly origin: EdgeOrigin;
  readonly statistics?: EdgeStatistics | null;
  readonly observationIds?: readonly string[];
}): EdgeResult {
  const { sourceNodeId, targetNodeId, type } = input;

  if (sourceNodeId === targetNodeId) {
    return { ok: false, rejection: { reason: 'self_edge', type, sourceNodeId, targetNodeId } };
  }

  const origin = edgeOriginFor(type, input.origin);
  if (origin === null) {
    return { ok: false, rejection: { reason: 'origin_not_permitted', type, sourceNodeId, targetNodeId } };
  }

  const statistics = input.statistics ?? null;
  const observationIds = input.observationIds ?? [];

  if (origin === 'computed') {
    if (statistics === null) {
      return {
        ok: false,
        rejection: { reason: 'computed_without_statistics', type, sourceNodeId, targetNodeId },
      };
    }
    if (observationIds.length === 0) {
      return {
        ok: false,
        rejection: { reason: 'computed_without_evidence', type, sourceNodeId, targetNodeId },
      };
    }
  }

  return {
    ok: true,
    edge: {
      sourceNodeId,
      targetNodeId,
      type,
      origin,
      weight: statistics === null ? 1 : Math.min(1, Math.abs(statistics.effect)),
      statistics,
      observationIds,
    },
  };
}

/**
 * A stable key for an edge, matching the database's uniqueness constraint.
 *
 * `graph_edge_unique` is on `(source, target, relation)`, so this is the key the
 * reconciliation compares on. Direction is part of it: `PRECEDES(a, b)` and
 * `PRECEDES(b, a)` are different claims and must not collapse.
 */
export function edgeKey(edge: Pick<GraphEdge, 'sourceNodeId' | 'targetNodeId' | 'type'>): string {
  return `${edge.sourceNodeId}|${edge.targetNodeId}|${edge.type}`;
}
