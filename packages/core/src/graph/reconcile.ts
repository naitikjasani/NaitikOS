/* eslint-disable @naitikos/no-bare-quantity -- Every `weight` in this file is
 * |rho|: a dimensionless scalar used to rank graph traversal. §6.2's rule
 * protects *measured quantities* from losing their unit, and a rank-order
 * correlation coefficient has none to lose. Disabled at file scope rather than
 * per line because the exemption is a property of the whole module. */
/**
 * Nightly graph reconciliation — §10.2's "the graph gets quieter".
 *
 *   "Graph construction runs nightly, incrementally, from the observation log.
 *    Edges are recomputed as evidence accumulates and **are removed when they
 *    no longer meet threshold** — which means the graph gets *quieter* as data
 *    accumulates and spurious early associations wash out, which is the correct
 *    behaviour."
 *
 * ## Why removal is the hard half
 *
 * An accumulating graph is easy and wrong. Every spurious association ever
 * detected stays in it forever, the graph grows monotonically, and by year
 * three the context engine is traversing a dense mesh of relationships that
 * stopped holding in month four. Nothing errors; the answers just quietly get
 * worse, and there is no moment at which anyone would notice.
 *
 * So this function's contract is symmetric: it returns what to add, what to
 * update, **and what to remove**, and a caller that ignores the third has an
 * accumulating graph again.
 *
 * ## `asserted` edges are never removed
 *
 * A `TRIGGERS` edge is the operator's belief. A nightly job that deleted it
 * because the statistics stopped supporting it would be the system overruling
 * the person about their own body — and §10.2 is explicit that a belief is
 * recorded *as* a belief, which means it does not answer to a p-value. If the
 * data disagrees, the honest outcome is that the graph holds both, which is
 * exactly what keeping the `TRIGGERS` edge alongside an absent
 * `CORRELATES_WITH` one does.
 *
 * `recorded` edges are likewise untouched: a prescription that is in the record
 * is a fact about the record, and a statistical job has no standing to delete
 * it.
 */

import type { EdgeType, GraphEdge } from './edges';
import { edgeKey } from './edges';

/**
 * The |effect| an edge must retain to stay in the graph.
 *
 * Deliberately *below* the correlation detector's `MIN_REPORTABLE_RHO` of 0.3.
 * The two thresholds answer different questions: 0.3 is "is this worth telling
 * the operator about tonight", 0.2 is "is this still worth traversing when
 * assembling context". An edge that has weakened but not vanished is still a
 * useful hint for retrieval, and dropping it at the same threshold would make
 * the graph flicker in and out around the reporting boundary.
 */
export const EDGE_RETENTION_WEIGHT = 0.2;

/**
 * How many nights an edge may go unsupported before it is removed.
 *
 * Three. One night of missing data — a holiday, a stretch of unlogged days —
 * should not demolish an edge that took ninety days to establish, and a single
 * night's absence is much more likely to be a gap in logging than a change in
 * the world. Three consecutive nights is a signal.
 */
export const UNSUPPORTED_NIGHTS_BEFORE_REMOVAL = 3;

/** An edge as it currently exists in the graph, with its decay counter. */
export type StoredEdge = GraphEdge & {
  readonly id: string;
  /** Consecutive nights this edge was not re-derived. */
  readonly unsupportedNights: number;
};

export type Reconciliation = {
  readonly added: readonly GraphEdge[];
  /** Same key, changed statistics. The counter resets. */
  readonly updated: readonly { readonly id: string; readonly edge: GraphEdge }[];
  /** Re-derived and unchanged; only the counter needs resetting. */
  readonly refreshed: readonly string[];
  /** Not re-derived tonight, and not yet at the removal threshold. */
  readonly decayed: readonly string[];
  /** Removed. §10.2's "washed out". */
  readonly removed: readonly string[];
};

/**
 * Compare tonight's derived edges against the stored graph.
 *
 * Pure: it decides, and the repository writes. That split is what makes this
 * testable against a table of cases rather than against a database, which
 * matters because the interesting behaviour — an edge surviving two quiet
 * nights and dying on the third — is tedious to set up in SQL and trivial here.
 */
export function reconcileEdges(input: {
  readonly derived: readonly GraphEdge[];
  readonly stored: readonly StoredEdge[];
  readonly retentionWeight?: number;
  readonly nightsBeforeRemoval?: number;
}): Reconciliation {
  const retention = input.retentionWeight ?? EDGE_RETENTION_WEIGHT;
  const limit = input.nightsBeforeRemoval ?? UNSUPPORTED_NIGHTS_BEFORE_REMOVAL;

  const derivedByKey = new Map<string, GraphEdge>();
  for (const edge of input.derived) {
    /* A weak edge is not derived at all rather than derived-and-then-removed:
     * the retention threshold is about what stays, and something that never
     * met it should not enter. */
    if (edge.origin === 'computed' && edge.weight < retention) continue;
    derivedByKey.set(edgeKey(edge), edge);
  }

  const added: GraphEdge[] = [];
  const updated: { id: string; edge: GraphEdge }[] = [];
  const refreshed: string[] = [];
  const decayed: string[] = [];
  const removed: string[] = [];

  const seen = new Set<string>();

  for (const stored of input.stored) {
    const key = edgeKey(stored);
    seen.add(key);

    const derived = derivedByKey.get(key);

    if (derived !== undefined) {
      if (statisticsChanged(stored, derived)) updated.push({ id: stored.id, edge: derived });
      else refreshed.push(stored.id);
      continue;
    }

    /*
     * Not re-derived. A belief and a record are not the statistics' to delete —
     * see the note at the top. Only computed edges decay.
     */
    if (stored.origin !== 'computed') {
      refreshed.push(stored.id);
      continue;
    }

    if (stored.unsupportedNights + 1 >= limit) removed.push(stored.id);
    else decayed.push(stored.id);
  }

  for (const [key, edge] of derivedByKey) {
    if (!seen.has(key)) added.push(edge);
  }

  return { added, updated, refreshed, decayed, removed };
}

/**
 * Whether an edge's supporting statistics have moved enough to rewrite the row.
 *
 * Compared on the *reported* precision rather than exactly. Spearman's rho over
 * a rolling window moves in the fourth decimal place every single night, and
 * writing every one of those would turn a quiet nightly job into a full rewrite
 * of the graph — which is expensive, and which fills the audit log with changes
 * nobody made.
 */
function statisticsChanged(stored: GraphEdge, derived: GraphEdge): boolean {
  const a = stored.statistics;
  const b = derived.statistics;

  if (a === null || b === null) return a !== b;
  return (
    a.method !== b.method ||
    a.n !== b.n ||
    a.lagDays !== b.lagDays ||
    a.windowDays !== b.windowDays ||
    a.effect.toFixed(2) !== b.effect.toFixed(2)
  );
}

/**
 * Turn a confirmed correlation finding into an edge pair.
 *
 * A correlation with a non-zero lag produces **two** edges, and the distinction
 * is §10.2's: `CORRELATES_WITH` records that two things move together, and
 * `PRECEDES` records that one of them moved first. Neither says the first
 * caused the second, and emitting only `PRECEDES` would strongly imply it.
 *
 * At lag zero there is no precedence to record, so only the association edge is
 * produced. That asymmetry is the point — same-day association is a weaker
 * claim, and the graph should represent it as one.
 */
export function edgesForCorrelation(input: {
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly rho: number;
  readonly n: number;
  readonly pValue: number | null;
  readonly lagDays: number;
  readonly windowDays: number;
  readonly observationIds: readonly string[];
}): readonly { readonly type: EdgeType; readonly lagDays: number | null }[] {
  const association = { type: 'CORRELATES_WITH' as EdgeType, lagDays: null };
  if (input.lagDays === 0) return [association];
  return [association, { type: 'PRECEDES' as EdgeType, lagDays: input.lagDays }];
}
