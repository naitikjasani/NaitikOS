/**
 * The substrate — §9.2, and the reason this system is not sixteen apps in a
 * trenchcoat.
 *
 * P3: "There is no 'gym database' and no 'skin database.' There is one
 * observation log and one entity graph. *Gym* and *Skin* are queries with a UI
 * attached."
 *
 * §9.3 states four properties this file has to make true:
 *
 *   1. Every observation names a registered metric. No free-floating numbers.
 *   2. Every observation names its source. No unattributable facts.
 *   3. The subject reference is polymorphic and optional.
 *   4. Cross-cutting entities read widely and write narrowly.
 *
 * (1) and (2) are foreign keys below. (3) is two loose columns, and the reason
 * it is not a real foreign key is recorded at {@link observation}.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { aggregation, domain, metricValueType, sourceKind } from './enums';
import {
  confidence,
  entityColumns,
  ianaZone,
  instant,
  primaryKey,
  quantity,
  reference,
  rowTimestamps,
} from './columns';

/**
 * The metric registry — §9.2 calls it "the most important table in the system."
 *
 *   "Every measurable thing is registered before it can be observed... This
 *    registry is what makes P3 real. Skin can query training volume without
 *    knowing Gym exists, because both speak the metric vocabulary. It is also
 *    the thing that makes the data self-describing in year fifteen — a bare
 *    `74.2` is meaningless, but `74.2` joined to its metric row is a complete
 *    fact."
 *
 * The key is the stable identifier and it is what travels in the export (§9.10),
 * so it is the primary key rather than a surrogate. Renaming a metric key is
 * therefore a migration that rewrites observations — which is correct, because
 * it is exactly as consequential as that sounds.
 */
export const metric = pgTable(
  'metric',
  {
    /** Dotted, stable, permanent: `body.weight`, `mind.mood`, `gym.set.load`. */
    key: text().primaryKey(),

    domain: domain().notNull(),
    displayName: text().notNull(),
    /** What this measures, in a sentence, for a reader who has never seen the app. */
    description: text().notNull(),

    valueType: metricValueType().notNull(),
    /**
     * The unit every observation of this metric is stored in — `kg`, `hours`,
     * `count`, or the empty string for unitless scales like mood.
     *
     * Conversion happens at the edges. §5.3's "no floats" rule plus a single
     * canonical unit means a five-year trend never has to reconcile pounds
     * against kilograms mid-series.
     */
    canonicalUnit: text().notNull(),

    /** Inclusive bounds, rejected on write when violated. Null means unbounded. */
    minValue: quantity(),
    maxValue: quantity(),

    /** How this metric combines over a period. See {@link aggregation}. */
    aggregation: aggregation().notNull(),

    /** For `categorical` metrics: the permitted values, as a JSON string array. */
    allowedValues: jsonb(),

    /**
     * Whether the Daily Close collects this metric (§4.0).
     *
     * The Close is "a fixed budget, not a growing form" — adding a field
     * requires removing one. This flag is where that budget is enforced.
     */
    inDailyClose: boolean().notNull().default(false),

    ...rowTimestamps,
  },
  (t) => [
    index('metric_domain_idx').on(t.domain),
    check('metric_range_ordered', sql`${t.minValue} IS NULL OR ${t.maxValue} IS NULL OR ${t.minValue} <= ${t.maxValue}`),
  ],
);

/**
 * Provenance — §9.2: "Provenance is mandatory, not optional."
 *
 * A row per distinct origin, referenced by every observation. Separating this
 * from a bare enum column on `observation` buys the detail that makes an
 * origin auditable years later: which device, which model version, which
 * document, which derivation rule.
 *
 *   "A derived value must be distinguishable from a measured one forever, and a
 *    model-inferred value must be distinguishable from both."
 */
export const observationSource = pgTable(
  'observation_source',
  {
    id: primaryKey(),
    kind: sourceKind().notNull(),

    /** `apple_health`, `derivation:sleep_debt`, `claude-opus-5`, `manual`. */
    identifier: text().notNull(),
    /** Version of the importer, derivation rule, or model that produced this. */
    version: text(),

    /** Set when `kind = 'document_extraction'` — points at `document`. */
    documentId: reference(),

    ...rowTimestamps,
  },
  (t) => [
    uniqueIndex('observation_source_unique').on(t.kind, t.identifier, t.version),
    index('observation_source_kind_idx').on(t.kind),
  ],
);

/**
 * The spine. Append-only, forever.
 *
 * §9.1 is unambiguous about why this table has no `updatedAt`, no `version`,
 * and no `deletedAt`:
 *
 *   "Observations are append-only. This is not a stylistic preference; it is
 *    what makes a twenty-year record trustworthy. If a weight from 2027 can be
 *    silently edited in 2031, then no number in the system can be relied upon
 *    and the entire premise fails."
 *
 * Corrections are additive: write a new observation, point the old one's
 * {@link observation.supersededById} at it, and both persist. The timeline can
 * then be replayed as it was known at any past moment.
 *
 * **The append-only rule is not enforced by this file.** Drizzle can express
 * the columns but not the prohibition; migration `0001_observation_immutable`
 * adds the `BEFORE UPDATE OR DELETE` trigger that makes it real. A convention
 * that the database does not enforce is a convention that will be broken at
 * 2am in year four.
 */
export const observation = pgTable(
  'observation',
  {
    id: primaryKey(),

    /** FK to the registry. §9.3(1): no free-floating numbers. */
    metricKey: text()
      .notNull()
      .references(() => metric.key, { onUpdate: 'cascade' }),

    /**
     * The value, as `numeric`. Booleans store 0/1 and categoricals store their
     * ordinal; `metric.valueType` says how to read it.
     *
     * One column rather than one per type. The alternative — `valueNumeric`,
     * `valueText`, `valueBoolean` — means every cross-domain query carries a
     * COALESCE, and correlation work across domains is the entire point (P3).
     */
    value: quantity().notNull(),
    /** Free-text values (a journal line in the Close) that have no numeric form. */
    valueText: text(),

    /**
     * Denormalised from `metric.canonicalUnit` at write time.
     *
     * Deliberate redundancy. If the registry's canonical unit is ever changed,
     * historical observations must still say what they meant when recorded —
     * P2's "no fact whose meaning depends on application code to interpret."
     */
    unit: text().notNull(),

    /** When the fact was true. */
    observedAt: instant().notNull(),
    /** The IANA zone it was captured in (§5.3). */
    observedZone: ianaZone().notNull(),
    /** When the system was told. Diverges from `observedAt` constantly (§9.5). */
    recordedAt: instant().notNull().default(sql`now()`),

    /** FK to provenance. §9.3(2): no unattributable facts. */
    sourceId: reference()
      .notNull()
      .references(() => observationSource.id),

    /** 0–1. Null means "measured directly, no uncertainty to record". */
    confidence: confidence(),

    /**
     * Polymorphic subject reference — §9.3(3).
     *
     * A bodyweight has no subject; a set belongs to a `workout_session`. These
     * two columns are deliberately **not** a foreign key, and §9.3 explains the
     * choice: enforcement is "by application-level validation per metric rather
     * than by database polymorphism, which Postgres handles badly."
     *
     * The alternatives were worse. A nullable FK per subject type means a new
     * column every time a domain is added, forever. A single FK to a
     * supertype table means an insert into two tables for every set logged, on
     * the P1 hot path.
     */
    subjectType: text(),
    subjectId: reference(),

    /** Domain-specific extras that do not earn a column. Never queried hot. */
    context: jsonb(),

    /**
     * The correction pointer. Set on the *old* row when a newer observation
     * replaces it; both rows survive (§9.1).
     */
    supersededById: reference(),
    supersededAt: instant(),
    supersedeReason: text(),

    /**
     * Hybrid logical clock, for offline causal ordering (§5.7(3)).
     *
     * "Physical time on a phone is untrustworthy — timezone changes, clock
     * drift, manual adjustment. An HLC gives a total causal order that survives
     * all three."
     */
    hlc: text().notNull(),
  },
  (t) => [
    /* §9.6, "the workhorse": recent observations for a metric. */
    index('observation_metric_observed_idx').on(t.metricKey, t.observedAt.desc()),

    /**
     * §9.6: "everything on a given day", for the timeline.
     *
     * **Deviation from §9.6, recorded deliberately.** That row also asks for "a
     * date-truncated expression index". It is not implementable here, and the
     * reason is interesting enough to keep:
     * `date_trunc(text, timestamptz)` is STABLE rather than IMMUTABLE, because
     * its result depends on the session `TimeZone`. Postgres therefore refuses
     * it in an index expression.
     *
     * Forcing it — `date_trunc('day', observed_at AT TIME ZONE 'UTC')` — would
     * compile and be wrong. It buckets by UTC day, so for a user in
     * Asia/Kolkata every observation before 05:30 local lands on the previous
     * day. §5.3 cares about exactly this: "A workout at '7am' during travel is
     * a materially different fact from one at 7am at home."
     *
     * A day query is therefore a half-open range scan over this plain index —
     * `observed_at >= start AND observed_at < end`, with the bounds computed in
     * the relevant zone by `core/temporal`. Same cost, and it stays correct
     * when the user crosses a timezone.
     */
    index('observation_observed_at_idx').on(t.observedAt.desc()),

    /* §9.6: observations for a subject. */
    index('observation_subject_idx').on(t.subjectType, t.subjectId, t.observedAt.desc()),

    index('observation_source_idx').on(t.sourceId),

    /* Current values only — the correction chain is cold data. §9.6's partial
     * index pattern, applied to supersession rather than soft deletion. */
    index('observation_current_idx')
      .on(t.metricKey, t.observedAt.desc())
      .where(sql`${t.supersededById} IS NULL`),

    check('observation_supersede_consistent', sql`(${t.supersededById} IS NULL) = (${t.supersededAt} IS NULL)`),
    check('observation_no_self_supersede', sql`${t.supersededById} IS NULL OR ${t.supersededById} <> ${t.id}`),
    check('observation_subject_paired', sql`(${t.subjectType} IS NULL) = (${t.subjectId} IS NULL)`),
  ],
);

/**
 * Device-generated samples — kept structurally apart from {@link observation}.
 *
 * §9.7 does the arithmetic that justifies the split. Human observations run to
 * "under 400,000 rows" over twenty years, "a rounding error for Postgres" that
 * needs no partitioning and no retention policy. Device streams reach "tens of
 * millions", and mixing them
 *
 *   "would force partitioning and retention complexity onto the human record —
 *    the part that must remain simple, complete, and forever — in order to
 *    accommodate device data whose value beyond 90 days is entirely in its
 *    aggregates anyway."
 *
 * **Partitioning is not expressible in Drizzle.** This declares the logical
 * table; a later migration converts it to `PARTITION BY RANGE (observed_at)`
 * with monthly children and installs the 90-day downsample job. That is
 * deliberately deferred: wearable ingestion is V3 (§2.3), the table stays empty
 * until then, and converting an empty table is free — whereas partitioning a
 * populated one is not.
 */
export const sample = pgTable(
  'sample',
  {
    id: primaryKey(),
    metricKey: text()
      .notNull()
      .references(() => metric.key, { onUpdate: 'cascade' }),
    value: quantity().notNull(),
    unit: text().notNull(),
    observedAt: instant().notNull(),
    observedZone: ianaZone().notNull(),
    recordedAt: instant().notNull().default(sql`now()`),
    sourceId: reference()
      .notNull()
      .references(() => observationSource.id),
    /** Set once the raw rows behind this window have been dropped (§9.7). */
    isDownsampled: boolean().notNull().default(false),
  },
  (t) => [index('sample_metric_observed_idx').on(t.metricKey, t.observedAt.desc())],
);

/**
 * Controlled tag vocabulary (§9.2).
 *
 * "A controlled vocabulary applied across every domain, enabling cross-cutting
 * queries like 'everything tagged *travel*.'" Controlled, not free-form: an
 * uncontrolled tag set becomes `travel`, `Travel`, and `travelling` within a
 * year and stops being queryable.
 */
export const tag = pgTable(
  'tag',
  {
    ...entityColumns,
    slug: text().notNull(),
    label: text().notNull(),
    description: text(),
    /** Hex, for timeline rendering. Presentation, but it lives with the vocabulary. */
    colour: text(),
  },
  (t) => [uniqueIndex('tag_slug_unique').on(t.slug)],
);

/**
 * Tag application. Polymorphic for the same reason {@link observation}'s
 * subject reference is (§9.3(3)) — anything can be tagged.
 */
export const entityTag = pgTable(
  'entity_tag',
  {
    id: primaryKey(),
    tagId: reference()
      .notNull()
      .references(() => tag.id),
    entityType: text().notNull(),
    entityId: reference().notNull(),
    ...rowTimestamps,
  },
  (t) => [
    uniqueIndex('entity_tag_unique').on(t.tagId, t.entityType, t.entityId),
    index('entity_tag_entity_idx').on(t.entityType, t.entityId),
  ],
);

/**
 * Daily and weekly rollups per metric (§5.6, §9.7).
 *
 * "Turns a five-year trend chart into an index scan over a few thousand rows
 * instead of an aggregation over millions of observations." Refreshed by the
 * single nightly job (§5.2), never written by the application.
 *
 * A real table rather than a materialised view: incremental refresh of one day
 * is cheap, `REFRESH MATERIALIZED VIEW` over twenty years of history is not,
 * and at C3 the nightly job must stay boring.
 */
export const metricRollup = pgTable(
  'metric_rollup',
  {
    id: primaryKey(),
    metricKey: text()
      .notNull()
      .references(() => metric.key, { onUpdate: 'cascade' }),
    /** `day` or `week`. */
    grain: text().notNull(),
    /** Start of the bucket, in the profile's zone, stored as an instant. */
    bucketStart: instant().notNull(),

    /** The aggregate named by `metric.aggregation`. */
    value: quantity().notNull(),
    sampleCount: integer().notNull(),
    minValue: quantity(),
    maxValue: quantity(),

    computedAt: instant().notNull().default(sql`now()`),
  },
  (t) => [
    uniqueIndex('metric_rollup_unique').on(t.metricKey, t.grain, t.bucketStart),
    index('metric_rollup_lookup_idx').on(t.metricKey, t.grain, t.bucketStart.desc()),
  ],
);
