/**
 * Inserting the MVP metric registry — Week 1's "metric registry seeded with the
 * MVP's metrics" (§12).
 *
 * ## The list itself is no longer here
 *
 * It moved to `@naitikos/core` (`observations/mvp-metrics.ts`) when the Daily
 * Close landed. §4.0's form is generated from `in_daily_close` and its
 * eleven-element budget is arithmetic over these rows — both domain rules, and
 * §5.0 puts domain rules below the database. A Close that needed Drizzle in
 * order to know its own field list would be a Close that could not be tested
 * without Postgres.
 *
 * What is left here is the part that genuinely belongs to `db`: mapping the
 * domain shape onto the column shape, which is a one-line difference (`null`
 * versus absent) and a JSON encoding for `allowedValues`.
 */

import {
  MVP_METRICS as CORE_METRICS,
  DAILY_CLOSE_METRICS as CORE_DAILY_CLOSE,
  HEALTH_METRICS as CORE_HEALTH,
} from '@naitikos/core';
import type { MetricDefinition } from '@naitikos/core';

import type { Aggregation, Domain, MetricValueType } from '../schema/enums';

/**
 * A row of the `metric` table, ready to insert.
 *
 * The three enum fields are re-typed against the *Postgres* enums rather than
 * carried over from `core`. That is the load-bearing part of this file: if the
 * two vocabularies ever diverge — a value type added in `core`, a `pgEnum` not
 * updated — this assignment stops compiling. A drift between the domain's idea
 * of a metric and the column's would otherwise show up as a runtime insert
 * failure on a machine nobody is watching.
 */
export type MetricSeed = {
  readonly key: string;
  readonly domain: Domain;
  readonly displayName: string;
  readonly description: string;
  readonly valueType: MetricValueType;
  readonly canonicalUnit: string;
  readonly minValue: string | null;
  readonly maxValue: string | null;
  readonly aggregation: Aggregation;
  readonly allowedValues: readonly string[] | null;
  readonly inDailyClose: boolean;
};

function toRow(definition: MetricDefinition): MetricSeed {
  return {
    key: definition.key,
    domain: definition.domain,
    displayName: definition.displayName,
    description: definition.description,
    valueType: definition.valueType,
    canonicalUnit: definition.canonicalUnit,
    minValue: definition.minValue,
    maxValue: definition.maxValue,
    aggregation: definition.aggregation,
    allowedValues: definition.allowedValues,
    inDailyClose: definition.inDailyClose,
  };
}

/** Every metric the MVP can write, as rows. */
export const MVP_METRICS: readonly MetricSeed[] = CORE_METRICS.map(toRow);

/**
 * Health core's vocabulary (§4.4), as rows.
 *
 * A separate list because the two have different lifecycles: the MVP's is
 * closed and budgeted against §4.0's eleven elements, while this one grows
 * every time a laboratory reports an analyte the catalogue has not met. The
 * concatenation below is the composition, and it belongs to this layer — the
 * domain defines the vocabulary, the database inserts it.
 */
export const HEALTH_METRICS: readonly MetricSeed[] = CORE_HEALTH.map(toRow);

/**
 * Everything the metric table should contain.
 *
 * Asserted unique at seed time. Two definitions for one key would make the
 * upsert order decide which unit a metric has, and a metric whose unit depends
 * on insertion order is §6.2's failure with extra steps.
 */
export const REGISTERED_METRICS: readonly MetricSeed[] = [...MVP_METRICS, ...HEALTH_METRICS];

/** The Daily Close subset, in presentation order. Asserted against §4.0's cap. */
export const DAILY_CLOSE_METRICS: readonly MetricSeed[] = CORE_DAILY_CLOSE.map(toRow);
