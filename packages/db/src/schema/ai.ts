/**
 * AI — §9.2 ("AI") and §10.
 *
 * §5.10 makes the architectural status of this whole area explicit: the AI layer
 * is "a sidecar, not a dependency — every feature in the application must
 * function correctly with the AI layer entirely disabled." Nothing outside this
 * file has a foreign key pointing into it.
 *
 * P4 is the rule these tables are shaped by: "Statistics are computed by code.
 * Language models explain, rank, and narrate — they never discover a
 * correlation, never compute a number, and never assert a fact that did not
 * come from a query. The boundary is architectural, not a prompt instruction."
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  vector,
} from 'drizzle-orm/pg-core';

import { aiPurpose, consentScope, graphNodeKind } from './enums';
import {
  confidence,
  entityColumns,
  instant,
  primaryKey,
  quantity,
  reference,
  rowTimestamps,
} from './columns';

/**
 * Dimension of the embedding space — 384, from §10's table.
 *
 * §10 chose a "small quantised sentence-transformer (BGE-small class), 384
 * dimensions, ONNX runtime" and the reasoning is P7, not convenience:
 *
 *   "The content requiring embedding is journal entries, therapy notes, symptom
 *    descriptions, and medical documents — categorically the most sensitive text
 *    in the system. Sending it to a third-party embedding API purely to build a
 *    search index would mean the most private data in the database has the
 *    widest egress footprint. That is unacceptable, and it is avoidable."
 *
 * Changing this number is a migration plus a full re-embed of every row. §10:
 * "a model change triggers a full backfill rather than mixing vector spaces."
 */
const EMBEDDING_DIMENSIONS = 384;

/**
 * A vector over a chunk of text.
 *
 * Model identity and version are stored per row so a partially completed
 * backfill is detectable rather than silently producing a mixed vector space —
 * where cosine distances between two models' vectors are meaningless numbers
 * that still sort.
 */
export const embedding = pgTable(
  'embedding',
  {
    id: primaryKey(),
    ...rowTimestamps,

    /** What was embedded. Polymorphic, as §9.3(3). */
    sourceType: text().notNull(),
    sourceId: reference().notNull(),

    /** Position within the source, for multi-chunk documents. */
    chunkIndex: integer().notNull().default(0),
    chunkText: text().notNull(),
    /** Character offsets back into the source, so a hit can be located. */
    chunkStart: integer(),
    chunkEnd: integer(),

    vector: vector({ dimensions: EMBEDDING_DIMENSIONS }).notNull(),

    modelIdentity: text().notNull(),
    modelVersion: text().notNull(),
  },
  (t) => [
    uniqueIndex('embedding_chunk_unique').on(t.sourceType, t.sourceId, t.chunkIndex, t.modelVersion),
    index('embedding_source_idx').on(t.sourceType, t.sourceId),
    /**
     * §9.6: "Semantic search — HNSW on the embedding column."
     *
     * Cosine, because sentence-transformer vectors are direction-normalised and
     * magnitude carries no meaning. §10 also notes that pure vector search is
     * poor at exact terms — drug names, lab analytes — so retrieval is hybrid:
     * this index serves the semantic half, `pg_trgm` and full-text the lexical
     * half, fused by reciprocal rank.
     */
    index('embedding_hnsw_idx').using('hnsw', t.vector.op('vector_cosine_ops')),
  ],
);

/** A node in the knowledge graph (§9.2, §10). */
export const graphNode = pgTable(
  'graph_node',
  {
    ...entityColumns,

    kind: graphNodeKind().notNull(),
    label: text().notNull(),
    /** Set when this node stands for a row elsewhere in the schema. */
    entityType: text(),
    entityId: reference(),
    properties: jsonb().notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [
    index('graph_node_kind_idx').on(t.kind),
    uniqueIndex('graph_node_entity_unique')
      .on(t.entityType, t.entityId)
      .where(sql`${t.entityType} IS NOT NULL`),
  ],
);

/**
 * An edge.
 *
 * `observationIds` is what keeps the graph honest: §9.3's diagram notes that
 * "edges reference observations". An edge with no supporting observations is an
 * assertion the system is not entitled to make (P4), so the evidence travels
 * with the relationship rather than being recomputed on demand.
 */
export const graphEdge = pgTable(
  'graph_edge',
  {
    ...entityColumns,

    sourceNodeId: reference()
      .notNull()
      .references(() => graphNode.id),
    targetNodeId: reference()
      .notNull()
      .references(() => graphNode.id),

    /** `co_occurs_with`, `precedes`, `treats`, `aggravates`. */
    relation: text().notNull(),
    weight: quantity(),
    confidence: confidence(),

    /** Observation IDs supporting this edge. */
    observationIds: jsonb().notNull().default(sql`'[]'::jsonb`),

    /**
     * The statistics behind the edge, and its decay counter.
     *
     * §10.2 requires an edge to store "the observations that support it **and
     * the statistical method that produced it**" — `observationIds` covers the
     * first and this covers the second. An edge built by Spearman over ranked
     * taps and one built by a binomial test over doses are different claims,
     * and a reader who cannot tell which is which cannot audit either.
     *
     * It also carries `unsupportedNights`, which is what makes §10.2's "edges
     * are removed when they no longer meet threshold" implementable: an
     * accumulating graph never errors, it just quietly gets worse.
     *
     * Jsonb rather than columns because neither field is filtered on. If the
     * decay counter is ever swept by a query rather than read per edge, it
     * earns a column.
     */
    properties: jsonb().notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [
    index('graph_edge_source_idx').on(t.sourceNodeId, t.relation),
    index('graph_edge_target_idx').on(t.targetNodeId, t.relation),
    uniqueIndex('graph_edge_unique').on(t.sourceNodeId, t.targetNodeId, t.relation),
  ],
);

/**
 * Durable derived facts about the user (§9.2).
 *
 * The stable half of §10.4's context pack — the part that is "byte-identical
 * across calls so it caches". §10 warns that "a `new Date()` interpolated into
 * the profile block would silently destroy cache hits across every request in
 * the system", so nothing time-varying belongs in a memory fact's text.
 */
export const memoryFact = pgTable(
  'memory_fact',
  {
    ...entityColumns,

    /** Stable key so a fact is updated rather than duplicated. */
    key: text().notNull(),
    fact: text().notNull(),
    category: text(),

    confidence: confidence(),
    /** Which detector or derivation established this. */
    derivedFrom: text(),
    lastConfirmedAt: instant(),

    /** Whether this fact may enter a prompt, and under which scope. */
    aiConsent: consentScope().notNull().default('none'),
  },
  (t) => [uniqueIndex('memory_fact_key_unique').on(t.key)],
);

/**
 * Every model call, without exception.
 *
 * §9.2: "**Complete auditability of everything the AI layer has ever done** is a
 * requirement, not a nicety."
 *
 * Two columns carry more weight than they look like they do. `consentScope`
 * records what the user had actually granted at the moment of the call, so a
 * later consent change cannot retroactively justify an earlier one. And
 * `outputHash` lets a stored narrative be checked against what the model
 * actually returned — an insight whose text has drifted from its generation is
 * no longer auditable.
 *
 * §10 also requires a hard monthly spend cap "enforced before the call", which
 * reads its running total from this table.
 */
export const aiInteraction = pgTable(
  'ai_interaction',
  {
    id: primaryKey(),
    ...rowTimestamps,

    purpose: aiPurpose().notNull(),
    model: text().notNull(),

    inputTokens: integer(),
    outputTokens: integer(),
    cacheReadTokens: integer(),
    cacheWriteTokens: integer(),

    /** Minor units, to stay consistent with §5.3's no-floats-for-money rule. */
    costMinor: integer(),
    currency: text(),
    latencyMs: integer(),

    /** What the user had granted when this call was made. */
    consentScope: consentScope().notNull(),
    /** SHA-256 of the returned content. */
    outputHash: text(),
    /** Set when the call was refused by the guardrail layer (§10.10). */
    blockedReason: text(),

    succeeded: boolean().notNull().default(true),
    errorCode: text(),
  },
  (t) => [
    index('ai_interaction_created_idx').on(t.createdAt.desc()),
    index('ai_interaction_purpose_idx').on(t.purpose, t.createdAt.desc()),
    /* Spend cap enforcement reads this window. */
    index('ai_interaction_cost_idx').on(t.createdAt.desc()).where(sql`${t.costMinor} IS NOT NULL`),
  ],
);
