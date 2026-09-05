/**
 * Predictions, persisted — and, more to the point, resolved (§10.9).
 *
 * §10.9's justification for this table is a single sentence:
 *
 *   "A prediction engine that does not report its own track record is asking
 *    for trust it has not earned."
 *
 * So the interesting method here is not `record`, it is {@link
 * PredictionRepository.resolve}. A prediction that is written and never scored
 * is worse than one that was never made: it looks like accountability while
 * providing none, and the calibration page built over it would report a track
 * record that quietly excludes every prediction the system got wrong and then
 * forgot about.
 *
 * ## `pending` is the nightly job's query, and it is deliberately narrow
 *
 * A prediction becomes resolvable on its horizon day and not before. The index
 * behind `pending` is partial on `resolved_at IS NULL`, so the scan is over the
 * handful of open predictions rather than over every one ever made — which
 * matters in year eight and not at all in month two, which is exactly the kind
 * of thing that is cheap now and expensive to retrofit (§9.6).
 *
 * ## Three resolution shapes, and the database enforces which are legal
 *
 * `prediction_resolution_complete` permits an unresolved row, a fully scored
 * row, and an unresolvable one — and nothing else. A `resolved_at` with a value
 * but no verdict is rejected by Postgres rather than by this file, because a
 * calibration rate computed over half-scored rows is a number nobody can
 * interpret and a repository convention is not a guarantee.
 */

import { and, asc, desc, eq, isNotNull, isNull, lte } from 'drizzle-orm';
import type { Result } from '@naitikos/shared';
import { ok } from '@naitikos/shared';
import type {
  DomainError,
  Prediction,
  PredictionInput,
  PredictionKind,
  PredictionMethod,
} from '@naitikos/core';
import { notFoundError } from '@naitikos/core';

import type { Database } from '../client';
import { prediction } from '../schema/prediction';

function toPrediction(row: typeof prediction.$inferSelect): Prediction {
  return {
    id: row.id,
    kind: row.kind as PredictionKind,
    metricKey: row.metricKey,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    madeAt: row.madeAt,
    horizonDayKey: row.horizonDayKey,
    predictedValue: row.predictedValue,
    intervalLow: row.intervalLow,
    intervalHigh: row.intervalHigh,
    unit: row.unit,
    method: row.method as PredictionMethod,
    observationCount: row.observationCount,
    fitConfidence: row.fitConfidence,
    assumptions: row.assumptions,
    resolvedAt: row.resolvedAt,
    resolvedValue: row.resolvedValue,
    wasWithinInterval: row.wasWithinInterval,
    unresolvableReason: row.unresolvableReason,
  };
}

/**
 * Scoring a prediction.
 *
 * Either a value with a verdict, or a reason it could not be scored. The union
 * is expressed as three nullable fields rather than a discriminated type
 * because that is the shape the columns take, and the CHECK constraint is what
 * actually rules out the illegal combinations.
 */
export type ResolvePredictionInput = {
  readonly id: string;
  readonly at: string;
  readonly resolvedValue?: string | null;
  readonly wasWithinInterval?: boolean | null;
  /** Set when the horizon arrived with nothing to compare against. */
  readonly unresolvableReason?: string | null;
};

export type PredictionRepository = {
  all(limit?: number): Promise<Result<readonly Prediction[], DomainError>>;
  byId(id: string): Promise<Result<Prediction | null, DomainError>>;
  /** Unresolved predictions whose horizon has arrived. The nightly job's query. */
  pending(onOrBeforeDayKey: string): Promise<Result<readonly Prediction[], DomainError>>;
  /** Idempotent on the client-minted id, so a replayed nightly run writes once. */
  record(input: PredictionInput): Promise<Result<Prediction, DomainError>>;
  resolve(input: ResolvePredictionInput): Promise<Result<Prediction, DomainError>>;
  forMetric(metricKey: string, limit?: number): Promise<Result<readonly Prediction[], DomainError>>;
  /** Everything scored, for the calibration report. Unresolved rows excluded. */
  resolved(limit?: number): Promise<Result<readonly Prediction[], DomainError>>;
};

export function createPredictionRepository(db: Database): PredictionRepository {
  return {
    async all(limit = 200) {
      const rows = await db
        .select()
        .from(prediction)
        .where(isNull(prediction.deletedAt))
        .orderBy(desc(prediction.madeAt))
        .limit(limit);
      return ok(rows.map(toPrediction));
    },

    async byId(id) {
      const rows = await db
        .select()
        .from(prediction)
        .where(and(eq(prediction.id, id), isNull(prediction.deletedAt)))
        .limit(1);
      const row = rows[0];
      return ok(row === undefined ? null : toPrediction(row));
    },

    async pending(onOrBeforeDayKey) {
      const rows = await db
        .select()
        .from(prediction)
        .where(
          and(
            isNull(prediction.deletedAt),
            isNull(prediction.resolvedAt),
            lte(prediction.horizonDayKey, onOrBeforeDayKey),
          ),
        )
        /* Oldest horizon first. A backlog is worked through in the order the
         * predictions came due, so a run that is interrupted has resolved a
         * prefix rather than a scattering. */
        .orderBy(asc(prediction.horizonDayKey));
      return ok(rows.map(toPrediction));
    },

    async record(input) {
      const rows = await db
        .insert(prediction)
        .values({
          id: input.id,
          kind: input.kind,
          metricKey: input.metricKey,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          madeAt: input.madeAt,
          horizonDayKey: input.horizonDayKey,
          predictedValue: input.predictedValue,
          intervalLow: input.intervalLow,
          intervalHigh: input.intervalHigh,
          unit: input.unit,
          method: input.method,
          observationCount: input.observationCount,
          fitConfidence: input.fitConfidence,
          assumptions: input.assumptions,
        })
        /*
         * §5.7: a replayed write arrives with the same client-minted UUIDv7.
         * The nightly job derives the id from the subject and the day for
         * exactly this reason — re-running an evening's predictions must not
         * double the denominator of every calibration figure.
         */
        .onConflictDoNothing()
        .returning();

      const row = rows[0];
      if (row !== undefined) return ok(toPrediction(row));

      const existing = await db.select().from(prediction).where(eq(prediction.id, input.id)).limit(1);
      const replayed = existing[0];
      return replayed === undefined
        ? { ok: false, error: notFoundError('prediction', input.id) }
        : ok(toPrediction(replayed));
    },

    async resolve(input) {
      const rows = await db
        .update(prediction)
        .set({
          resolvedAt: input.at,
          resolvedValue: input.resolvedValue ?? null,
          wasWithinInterval: input.wasWithinInterval ?? null,
          unresolvableReason: input.unresolvableReason ?? null,
          updatedAt: input.at,
        })
        /*
         * Only an unresolved prediction can be scored. Re-scoring one would let
         * a second nightly run flip a miss into a hit against a later reading —
         * §9.1's append-only spirit applied to a verdict: the record of what was
         * predicted, and of how it turned out, is written once.
         */
        .where(and(eq(prediction.id, input.id), isNull(prediction.resolvedAt), isNull(prediction.deletedAt)))
        .returning();

      const row = rows[0];
      return row === undefined
        ? { ok: false, error: notFoundError('prediction', input.id) }
        : ok(toPrediction(row));
    },

    async forMetric(metricKey, limit = 100) {
      const rows = await db
        .select()
        .from(prediction)
        .where(and(eq(prediction.metricKey, metricKey), isNull(prediction.deletedAt)))
        .orderBy(desc(prediction.madeAt))
        .limit(limit);
      return ok(rows.map(toPrediction));
    },

    async resolved(limit = 500) {
      const rows = await db
        .select()
        .from(prediction)
        .where(and(isNull(prediction.deletedAt), isNotNull(prediction.resolvedAt)))
        .orderBy(desc(prediction.resolvedAt))
        .limit(limit);
      return ok(rows.map(toPrediction));
    },
  };
}
