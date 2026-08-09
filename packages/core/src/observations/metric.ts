/**
 * The metric registry, as the domain sees it.
 *
 * §9.2 calls the `metric` table "the most important table in the system", and
 * explains what it buys:
 *
 *   "Every measurable thing is registered before it can be observed... This
 *    registry is what makes P3 real. Skin can query training volume without
 *    knowing Gym exists, because both speak the metric vocabulary."
 *
 * This file is the framework-free half of that. The table is the storage; these
 * types are the *contract*, and they live in `core` because §5.0 requires the
 * substrate's meaning to be defined below every feature — a lens over the
 * observation log cannot depend on Drizzle in order to know what a metric is.
 *
 * ## Duplication with `packages/db/src/schema/enums.ts`, on purpose
 *
 * The three unions below restate the `metric_value_type`, `aggregation` and
 * `domain` Postgres enums. That is a deliberate duplication in the direction
 * §5.0 permits — `db` may depend on `core`, never the reverse — and `db`
 * carries a compile-time assertion that the two lists still agree, so a drift
 * is a build failure rather than a runtime surprise.
 */

import type { Brand } from '@naitikos/shared';

/** A registered metric key: `body.weight`, `mind.mood`, `gym.set.load`. */
export type MetricKey = Brand<string, 'MetricKey'>;

/** The shape of a metric's value, so the registry can validate on write. */
export type MetricValueType =
  | 'numeric'
  | 'integer'
  | 'boolean'
  | 'text'
  /** Rendered as a duration; stored as a number in `canonicalUnit`. */
  | 'duration'
  /** One of a fixed set, listed per metric in {@link MetricDefinition.allowedValues}. */
  | 'categorical';

/**
 * How a metric combines over a period.
 *
 * §9.2: "Summing bodyweight over a week is nonsense and averaging training
 * volume hides a taper; the registry is what stops a chart from doing either."
 */
export type MetricAggregation = 'sum' | 'mean' | 'median' | 'last' | 'min' | 'max' | 'count';

/** Which pillar a metric belongs to (§3.2). */
export type MetricDomain = 'body' | 'mind' | 'work' | 'money' | 'life' | 'system';

export const METRIC_VALUE_TYPES: readonly MetricValueType[] = [
  'numeric',
  'integer',
  'boolean',
  'text',
  'duration',
  'categorical',
];

export const METRIC_AGGREGATIONS: readonly MetricAggregation[] = [
  'sum',
  'mean',
  'median',
  'last',
  'min',
  'max',
  'count',
];

export const METRIC_DOMAINS: readonly MetricDomain[] = ['body', 'mind', 'work', 'money', 'life', 'system'];

/**
 * One registered metric.
 *
 * Nullable fields are `| null` rather than optional, matching what a database
 * read produces. An optional property and a null one are different things under
 * `exactOptionalPropertyTypes`, and the row is the source of truth here.
 */
export type MetricDefinition = {
  readonly key: MetricKey;
  readonly domain: MetricDomain;
  readonly displayName: string;
  /**
   * What this measures, in a sentence, for a reader who has never seen the app.
   *
   * Data, not documentation. It travels in the export (§9.10) and it is what
   * makes a bare `74.2` legible in 2046.
   */
  readonly description: string;

  readonly valueType: MetricValueType;
  /** The single unit every observation of this metric is stored in. */
  readonly canonicalUnit: string;

  /** Inclusive bounds, as decimal strings. `null` means unbounded. */
  readonly minValue: string | null;
  readonly maxValue: string | null;

  readonly aggregation: MetricAggregation;
  /** For `categorical` metrics: the permitted values, in ordinal order. */
  readonly allowedValues: readonly string[] | null;

  /** Whether the Daily Close collects this metric (§4.0). */
  readonly inDailyClose: boolean;
};

/**
 * A read-only view over the registered metrics.
 *
 * A port, not a class: `core` cannot reach a database, so the write path takes
 * this and the repository supplies it. It also makes the whole validation layer
 * testable from a literal, which is why every test in this package builds one
 * rather than standing up Postgres.
 */
export type MetricRegistry = {
  /** `null` for an unregistered key. §9.2: "rejected on write." */
  get(key: string): MetricDefinition | null;
  has(key: string): boolean;
  all(): readonly MetricDefinition[];
  /** The Daily Close subset, in registration order (§4.0). */
  dailyClose(): readonly MetricDefinition[];
};

/**
 * Build a registry from a list of definitions.
 *
 * A `Map` rather than an object, so a metric key can never collide with
 * `Object.prototype`. `constructor` is not a plausible metric key, but the
 * lookup runs on request input and "not plausible" is not a security boundary.
 */
export function createMetricRegistry(definitions: readonly MetricDefinition[]): MetricRegistry {
  const byKey = new Map<string, MetricDefinition>();
  for (const definition of definitions) byKey.set(definition.key, definition);

  const ordered = [...definitions];
  const closeMetrics = ordered.filter((m) => m.inDailyClose);

  return {
    get: (key) => byKey.get(key) ?? null,
    has: (key) => byKey.has(key),
    all: () => ordered,
    dailyClose: () => closeMetrics,
  };
}

/**
 * §4.0: "Never more than eleven interactive elements."
 *
 * The cap lives here rather than in the UI because §4.0 frames it as a property
 * of the ritual, not of a screen: "The Close is a fixed budget, not a growing
 * form. Adding a field requires removing a field." A budget enforced by whoever
 * is laying out the page is a budget that is gone within a year.
 */
export const DAILY_CLOSE_ELEMENT_BUDGET = 11;
