/**
 * The knowledge graph, persisted — §10.2.
 *
 * ## The reconciliation decides; this writes
 *
 * `core/graph/reconcile.ts` is a pure function over tonight's derived edges and
 * the stored ones, and it returns additions, updates, refreshes, decays and
 * **removals**. This file is the half that touches the database, and it applies
 * all five — a caller that applied only the first three would have the
 * accumulating graph §10.2 is written against, and nothing would ever error.
 *
 * ## Removal is a soft delete, like everything else (§9.4)
 *
 * An edge that washed out is evidence about what the system used to believe,
 * and §9.4's argument for soft deletion applies to a derived row at least as
 * strongly as to a recorded one: a graph that hard-deleted its own history
 * could not answer "why did the March review say that?".
 *
 * ## The decay counter lives in `properties`, not in a column
 *
 * `graph_edge` has no `unsupported_nights` column. Adding one is a migration,
 * and §13.2 keeps migrations out of feature commits — so the counter goes in
 * the existing `properties` jsonb, which is exactly the kind of thing that
 * column exists for. If the counter turns out to need an index it earns a
 * column of its own later.
 */

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Result } from '@naitikos/shared';
import { ok } from '@naitikos/shared';
import type { DomainError, EdgeStatistics, EdgeType, GraphEdge, Reconciliation, StoredEdge } from '@naitikos/core';

import type { Database } from '../client';
import { graphEdge, graphNode } from '../schema/ai';
import type { GraphNodeKind } from '../schema/enums';

export type GraphNodeRow = {
  readonly id: string;
  readonly kind: GraphNodeKind;
  readonly label: string;
  readonly entityType: string | null;
  readonly entityId: string | null;
};

export type UpsertNodeInput = {
  readonly id: string;
  readonly kind: GraphNodeKind;
  readonly label: string;
  readonly entityType: string | null;
  readonly entityId: string | null;
};

export type GraphRepository = {
  nodes(): Promise<Result<readonly GraphNodeRow[], DomainError>>;
  /** Resolve a node for a row elsewhere in the schema, creating it if absent. */
  upsertNode(input: UpsertNodeInput): Promise<Result<GraphNodeRow, DomainError>>;
  /** Every live edge, with its decay counter, for tonight's reconciliation. */
  edges(): Promise<Result<readonly StoredEdge[], DomainError>>;
  /**
   * Neighbours of a node, depth 1.
   *
   * §10.4's RETRIEVE step traverses "neighbours of resolved entities, depth ≤
   * 2", and depth 2 is two calls rather than a recursive CTE. A single-user
   * graph is small enough that the round trip is cheaper than the query is to
   * read, and a recursive CTE with a cycle guard is a lot of SQL to get subtly
   * wrong for a saving nobody would measure.
   */
  neighbours(nodeId: string, minWeight?: number): Promise<Result<readonly StoredEdge[], DomainError>>;
  /** Apply a whole reconciliation, including its removals. */
  applyReconciliation(
    reconciliation: Reconciliation,
    newEdgeId: () => string,
  ): Promise<Result<{ readonly added: number; readonly removed: number }, DomainError>>;
};

const NODE_COLUMNS = {
  id: graphNode.id,
  kind: graphNode.kind,
  label: graphNode.label,
  entityType: graphNode.entityType,
  entityId: graphNode.entityId,
} as const;

export function createGraphRepository(db: Database): GraphRepository {
  return {
    async nodes() {
      const rows = await db
        .select({
          id: graphNode.id,
          kind: graphNode.kind,
          label: graphNode.label,
          entityType: graphNode.entityType,
          entityId: graphNode.entityId,
        })
        .from(graphNode)
        .where(isNull(graphNode.deletedAt));

      return ok(rows);
    },

    async upsertNode(input) {
      /*
       * Two genuinely different cases, so two statements rather than one clever
       * one.
       *
       * A node that stands for a row elsewhere — a medication, a food — has a
       * natural key, and `graph_node_entity_unique` enforces it. That index is
       * **partial** (`where entity_type is not null`), and Postgres will only
       * infer a partial index as a conflict target if the predicate is repeated
       * in the `ON CONFLICT` clause. Omitting it fails with 42P10 rather than
       * silently picking another index, which is the good outcome.
       *
       * A node that stands for nothing — a concept — has no natural key at all.
       * There is nothing to conflict *on*, so it is a plain insert on its
       * client-minted id, and re-running the nightly job with the same id is
       * handled by the primary key.
       */
      if (input.entityType === null || input.entityId === null) {
        const [inserted] = await db
          .insert(graphNode)
          .values({ id: input.id, kind: input.kind, label: input.label, entityType: null, entityId: null })
          .onConflictDoNothing({ target: graphNode.id })
          .returning(NODE_COLUMNS);

        return ok(inserted ?? { ...input });
      }

      const [row] = await db
        .insert(graphNode)
        .values({
          id: input.id,
          kind: input.kind,
          label: input.label,
          entityType: input.entityType,
          entityId: input.entityId,
        })
        .onConflictDoUpdate({
          target: [graphNode.entityType, graphNode.entityId],
          targetWhere: sql`${graphNode.entityType} is not null`,
          set: { label: input.label },
        })
        .returning(NODE_COLUMNS);

      return ok(row ?? { ...input });
    },

    async edges() {
      const rows = await db.select().from(graphEdge).where(isNull(graphEdge.deletedAt));
      return ok(rows.map(toStoredEdge));
    },

    async neighbours(nodeId, minWeight = 0) {
      const rows = await db
        .select()
        .from(graphEdge)
        .where(
          and(
            isNull(graphEdge.deletedAt),
            eq(graphEdge.sourceNodeId, nodeId),
            sql`coalesce(${graphEdge.weight}, 1) >= ${String(minWeight)}`,
          ),
        );

      return ok(rows.map(toStoredEdge));
    },

    async applyReconciliation(reconciliation, newEdgeId) {
      await db.transaction(async (tx) => {
        for (const edge of reconciliation.added) {
          await tx
            .insert(graphEdge)
            .values({ id: newEdgeId(), ...toRow(edge, 0) })
            /* The unique index is `(source, target, relation)`. A concurrent
             * night — or a replayed job — must not produce a second copy. */
            .onConflictDoNothing();
        }

        for (const { id, edge } of reconciliation.updated) {
          await tx
            .update(graphEdge)
            .set({ ...toRow(edge, 0), updatedAt: sql`now()` })
            .where(eq(graphEdge.id, id));
        }

        if (reconciliation.refreshed.length > 0) {
          /* Reset the counter only. Rewriting `properties` wholesale here would
           * discard the statistics on an edge whose numbers had not moved,
           * which is every refreshed edge by definition. */
          await tx
            .update(graphEdge)
            .set({
              properties: sql`jsonb_set(coalesce(${graphEdge.properties}, '{}'::jsonb), '{unsupportedNights}', '0'::jsonb)`,
            })
            .where(inArray(graphEdge.id, [...reconciliation.refreshed]));
        }

        for (const id of reconciliation.decayed) {
          /* Incremented in SQL rather than read-modify-written, so two nights
           * that overlap cannot lose a count. */
          await tx
            .update(graphEdge)
            .set({
              properties: sql`jsonb_set(coalesce(${graphEdge.properties}, '{}'::jsonb), '{unsupportedNights}', to_jsonb(coalesce((${graphEdge.properties} ->> 'unsupportedNights')::int, 0) + 1))`,
            })
            .where(eq(graphEdge.id, id));
        }

        if (reconciliation.removed.length > 0) {
          /* §9.4. An edge that washed out is evidence about what the system
           * used to believe, and a graph that hard-deleted its own history
           * could not answer "why did the March review say that?". */
          await tx
            .update(graphEdge)
            .set({ deletedAt: sql`now()`, deleteReason: 'washed_out' })
            .where(inArray(graphEdge.id, [...reconciliation.removed]));
        }
      });

      return ok({ added: reconciliation.added.length, removed: reconciliation.removed.length });
    },
  };
}

/**
 * The row for an edge, **including its statistics**.
 *
 * §10.2: "every edge stores the observations that support it and **the
 * statistical method that produced it**." Those live in `properties` beside the
 * decay counter, because `graph_edge` has no columns for them and adding some is
 * a migration (§13.2). The `confidence` column carries 1 − p separately because
 * it is indexed-adjacent and a reader filtering on it should not have to open a
 * jsonb.
 */
function toRow(edge: GraphEdge, unsupportedNights: number): {
  sourceNodeId: string;
  targetNodeId: string;
  relation: string;
  weight: string;
  confidence: string | null;
  observationIds: readonly string[];
  properties: Record<string, unknown>;
} {
  return {
    properties: {
      unsupportedNights,
      ...(edge.statistics === null ? {} : { statistics: edge.statistics }),
    },
    sourceNodeId: edge.sourceNodeId,
    targetNodeId: edge.targetNodeId,
    /* Stored lower-cased to match the column's stated vocabulary
     * ("co_occurs_with, precedes, treats"). The domain type stays upper-case
     * because §10.2 writes it that way. */
    relation: edge.type.toLowerCase(),
    weight: edge.weight.toFixed(6),
    /*
     * `confidence` here is 1 − p, and only for a computed edge. A recorded
     * edge has no confidence: a prescription is not 80% true, and writing 1.0
     * would put a statistic-shaped number on a fact that is not a statistic.
     */
    confidence:
      edge.statistics?.pValue == null ? null : Math.max(0, Math.min(1, 1 - edge.statistics.pValue)).toFixed(4),
    observationIds: edge.observationIds,
  };
}

function toStoredEdge(row: typeof graphEdge.$inferSelect): StoredEdge {
  const properties = (row.properties ?? {}) as Record<string, unknown>;
  const nights = properties['unsupportedNights'];

  return {
    id: row.id,
    sourceNodeId: row.sourceNodeId,
    targetNodeId: row.targetNodeId,
    type: row.relation.toUpperCase() as EdgeType,
    origin: originFor(row.relation),
    weight: row.weight === null ? 1 : Number(row.weight),
    statistics: readStatistics(properties),
    observationIds: Array.isArray(row.observationIds) ? (row.observationIds as string[]) : [],
    unsupportedNights: typeof nights === 'number' ? nights : 0,
  };
}

/**
 * The origin, derived from the relation rather than stored.
 *
 * `PERMITTED_ORIGINS` in core already says which origins each type allows, and
 * every type currently allows exactly one — so storing the origin would be
 * storing a value that is a function of another column, which is the shape a
 * disagreement grows in. If a type ever permits two, this becomes a column.
 */
function originFor(relation: string): StoredEdge['origin'] {
  switch (relation) {
    case 'correlates_with':
    case 'precedes':
    case 'co_occurs_with':
      return 'computed';
    case 'triggers':
      return 'asserted';
    default:
      return 'recorded';
  }
}

function readStatistics(properties: Record<string, unknown>): EdgeStatistics | null {
  const stats = properties['statistics'];
  if (typeof stats !== 'object' || stats === null) return null;

  const record = stats as Record<string, unknown>;
  const method = record['method'];
  if (method !== 'spearman' && method !== 'binomial' && method !== 'count') return null;

  return {
    method,
    n: numberOr(record['n'], 0),
    effect: numberOr(record['effect'], 0),
    pValue: typeof record['pValue'] === 'number' ? record['pValue'] : null,
    windowDays: numberOr(record['windowDays'], 0),
    lagDays: typeof record['lagDays'] === 'number' ? record['lagDays'] : null,
  };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
