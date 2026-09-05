/**
 * The prediction engine's record, and the Life Timeline's structure — §10.8,
 * §10.9.
 *
 * These sit in one file because they are the two halves of the same idea at
 * two time scales: what the system expects to happen next, and what the
 * operator's life has actually looked like over decades.
 *
 * ## A prediction is stored so it can be marked wrong
 *
 * §10.9 is unambiguous about why this table exists:
 *
 *   "Predictions must state their interval and their assumptions, must degrade
 *    to *'insufficient data'* rather than guessing, and must be retrospectively
 *    scored — every prediction is stored and compared against what actually
 *    happened, with the calibration record visible to the user. **A prediction
 *    engine that does not report its own track record is asking for trust it
 *    has not earned.**"
 *
 * That sentence is the whole schema. `resolved_value`, `resolved_at` and
 * `was_within_interval` are not optional extras — a `prediction` row with no
 * path to resolution is a claim with no accountability, and the table would be
 * worse than nothing.
 *
 * `assumptions` is `notNull` for the same reason. §10.9 requires a prediction
 * to state its assumptions, and a nullable column would make that a habit
 * rather than a rule.
 *
 * ## What may not be predicted
 *
 * §10.9: "Prohibited: any prediction about a clinical outcome, a symptom
 * course, or a medication response." That is enforced in `core` against a
 * closed list of permitted subjects rather than here — the constraint is about
 * *what a metric means*, which the registry knows and Postgres does not. The
 * `prediction_kind` enum is the narrow gate: there is no `clinical_outcome`
 * member, so an unpermitted prediction has no kind to be written under.
 *
 * ## The Life Timeline is authored, not derived
 *
 * §10.8's eras and chapters are the one structure in this system the operator
 * writes by hand. The record can say where someone was and what they did; it
 * cannot say that 2024 was "the year I moved out", and a system that inferred
 * chapter boundaries from a change in observation density would be asserting a
 * shape onto a life (§10.0).
 */

import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, pgTable, text } from 'drizzle-orm/pg-core';

import { lifeSpanKind, predictionKind, predictionMethod } from './enums';
import { confidence, entityColumns, instant, quantity, reference, searchVector } from './columns';

/* =========================================================================
 * Predictions (§10.9)
 * ====================================================================== */

/**
 * One prediction, with its interval, its assumptions, and — eventually — what
 * actually happened.
 */
export const prediction = pgTable(
  'prediction',
  {
    ...entityColumns,

    kind: predictionKind().notNull(),
    /** The registry key being predicted. `core` checks it is a permitted one. */
    metricKey: text().notNull(),
    /** What the prediction is about, when it is not a bare metric — a goal, an exercise. */
    subjectType: text(),
    subjectId: reference(),

    /** When the prediction was made, and the day it is about. */
    madeAt: instant().notNull(),
    horizonDayKey: text().notNull(),

    /**
     * The point estimate and its interval. All three, always.
     *
     * §10.9 requires a prediction to "state their interval". A point estimate
     * with no bounds reads as certainty, and this engine's entire justification
     * is that it is honest about how little it knows.
     */
    predictedValue: quantity().notNull(),
    intervalLow: quantity().notNull(),
    intervalHigh: quantity().notNull(),
    unit: text().notNull(),

    method: predictionMethod().notNull(),
    /** How many observations the fit was drawn from. Part of the audit trail. */
    observationCount: integer().notNull(),
    /** 0–1. Not a probability of being right — a statement about the fit. */
    fitConfidence: confidence(),

    /**
     * What had to be true for this to hold, in plain words.
     *
     * Required. §10.9: predictions "must state their interval and their
     * assumptions". "Assuming intake and training stay as they have been for
     * the last three weeks" is the difference between a projection and a
     * fortune.
     */
    assumptions: text().notNull(),

    /* --- resolution, written when the horizon arrives ------------------ */

    resolvedAt: instant(),
    resolvedValue: quantity(),
    /** Whether the truth landed inside the stated interval. The calibration bit. */
    wasWithinInterval: boolean(),
    /**
     * Why a prediction could not be scored, when it could not be.
     *
     * A horizon that arrives with no observation on it is not a miss — it is an
     * unanswered question, and counting it as either a hit or a miss would
     * corrupt the calibration record in one direction or the other.
     */
    unresolvableReason: text(),
  },
  (t) => [
    index('prediction_horizon_idx').on(t.horizonDayKey).where(sql`${t.resolvedAt} IS NULL AND ${t.deletedAt} IS NULL`),
    index('prediction_metric_idx').on(t.metricKey, t.madeAt.desc()),
    check('prediction_interval_ordered', sql`${t.intervalLow} <= ${t.predictedValue} AND ${t.predictedValue} <= ${t.intervalHigh}`),
    /*
     * A resolution is all of its parts or none of them. A `resolved_at` with no
     * value, or a value with no verdict, is a half-scored prediction — and a
     * calibration rate computed over half-scored rows is a number nobody can
     * interpret.
     */
    check(
      'prediction_resolution_complete',
      sql`(${t.resolvedAt} IS NULL AND ${t.resolvedValue} IS NULL AND ${t.wasWithinInterval} IS NULL)
          OR (${t.resolvedAt} IS NOT NULL AND ${t.resolvedValue} IS NOT NULL AND ${t.wasWithinInterval} IS NOT NULL)
          OR (${t.resolvedAt} IS NOT NULL AND ${t.unresolvableReason} IS NOT NULL)`,
    ),
    check('prediction_observation_count', sql`${t.observationCount} >= 0`),
  ],
);

/* =========================================================================
 * The Life Timeline (§10.8)
 * ====================================================================== */

/**
 * An era or a chapter: a named span of life.
 *
 * One table with a `kind` discriminator rather than two, because an era and a
 * chapter differ only in scale and in nesting — both are a name, a span and a
 * colour, and two tables would mean two of every query that draws the
 * background of a timeline.
 *
 * `endedAt` is nullable: the current chapter has not ended, and writing today's
 * date into it every night would make the timeline's most important span the
 * one that is constantly being rewritten.
 */
export const lifeSpan = pgTable(
  'life_span',
  {
    ...entityColumns,

    kind: lifeSpanKind().notNull(),
    title: text().notNull(),
    description: text(),

    startedAt: instant().notNull(),
    endedAt: instant(),

    /** A chapter may sit inside an era. Eras do not nest. */
    parentId: reference(),

    /**
     * A palette slot, not a colour.
     *
     * §8.9's charts take a `slot` rather than a hex value so a theme change
     * repaints everything at once, and so no span can be given a colour that
     * fails contrast in one of the two themes.
     */
    slot: integer(),

    searchVector: searchVector('title', 'description'),
  },
  (t) => [
    index('life_span_started_idx').on(t.startedAt).where(sql`${t.deletedAt} IS NULL`),
    index('life_span_kind_idx').on(t.kind, t.startedAt),
    index('life_span_search_idx').using('gin', t.searchVector),
    check('life_span_ordered', sql`${t.endedAt} IS NULL OR ${t.startedAt} <= ${t.endedAt}`),
    check('life_span_slot_range', sql`${t.slot} IS NULL OR ${t.slot} BETWEEN 1 AND 8`),
  ],
);

/**
 * A discrete, significant event on the life timeline.
 *
 * Distinct from `timeline_entry`, which is the projection of the domain event
 * log and holds every logged set and every meal. This table holds the handful
 * of things a person would name if asked what happened in a given year, and it
 * is written by hand for the same reason `life_span` is: significance is a
 * judgement, and §10.0 keeps the system out of making it.
 */
export const lifeEvent = pgTable(
  'life_event',
  {
    ...entityColumns,

    title: text().notNull(),
    description: text(),
    occurredAt: instant().notNull(),
    spanId: reference(),

    /** 1–5. How large it looms, which is the operator's call and nobody else's. */
    significance: integer(),

    searchVector: searchVector('title', 'description'),
  },
  (t) => [
    index('life_event_occurred_idx').on(t.occurredAt.desc()).where(sql`${t.deletedAt} IS NULL`),
    index('life_event_search_idx').using('gin', t.searchVector),
    check('life_event_significance_range', sql`${t.significance} IS NULL OR ${t.significance} BETWEEN 1 AND 5`),
  ],
);
