/**
 * The metric registry, read from the database.
 *
 * `core` declares {@link MetricRegistry} as a port and never reaches a
 * database; this is the adapter. §9.2 makes the registry the thing every write
 * is validated against, so it is on the hot path of every capture — which is
 * why it is cached rather than queried per request.
 *
 * ## Cache invalidation, or rather the deliberate absence of it
 *
 * There is no TTL and no busting. The registry changes when `pnpm db:seed`
 * runs, which is a deploy, which restarts the process. §5.6 permits exactly
 * this: reference data whose lifecycle is the deployment's lifecycle needs no
 * invalidation strategy, and inventing one would be a mechanism with no
 * failure it prevents.
 *
 * The consequence to know: seeding against a *running* production process does
 * not take effect until the next cold start. That is stated in the seed
 * runbook rather than solved here.
 */

import { eq } from 'drizzle-orm';
import type { Result } from '@naitikos/shared';
import { ok } from '@naitikos/shared';
import type { DomainError, MetricDefinition, MetricKey, MetricRegistry } from '@naitikos/core';
import { createMetricRegistry } from '@naitikos/core';

import type { Executor } from '../client';
import { metric } from '../schema/substrate';

/**
 * Row → definition.
 *
 * `allowedValues` is `jsonb`, so it arrives as `unknown`. It is narrowed rather
 * than cast: a hand-edited row containing `{"a":1}` would otherwise become an
 * `allowedValues` that `decodeValue` indexes into, and the failure would show
 * up as a wrong category label on a real observation.
 */
function toDefinition(row: typeof metric.$inferSelect): MetricDefinition {
  const raw: unknown = row.allowedValues;
  const allowedValues =
    Array.isArray(raw) && raw.every((value): value is string => typeof value === 'string') ? raw : null;

  return {
    key: row.key as MetricKey,
    domain: row.domain,
    displayName: row.displayName,
    description: row.description,
    valueType: row.valueType,
    canonicalUnit: row.canonicalUnit,
    minValue: row.minValue,
    maxValue: row.maxValue,
    aggregation: row.aggregation,
    allowedValues,
    inDailyClose: row.inDailyClose,
  };
}

export type MetricRepository = {
  /** The whole registry, cached for the life of the process. */
  registry(): Promise<Result<MetricRegistry, DomainError>>;
  /** One metric, from the same cache. */
  get(key: string): Promise<MetricDefinition | null>;
  /** Drop the cache. For tests and for the seed runner. */
  invalidate(): void;
};

export function createMetricRepository(db: Executor): MetricRepository {
  let cached: MetricRegistry | null = null;
  /*
   * The in-flight promise, not just the result.
   *
   * Without it, N concurrent requests on a cold start each issue the same
   * SELECT — the classic cache stampede. At n=1 that is three queries rather
   * than one, which is not a crisis; it is here because the fix is four lines
   * and the alternative is a comment explaining why it was fine.
   */
  let inFlight: Promise<MetricRegistry> | null = null;

  async function load(): Promise<MetricRegistry> {
    const rows = await db.select().from(metric).orderBy(metric.key);
    const registry = createMetricRegistry(rows.map(toDefinition));
    cached = registry;
    return registry;
  }

  return {
    async registry() {
      if (cached !== null) return ok(cached);
      inFlight ??= load().finally(() => {
        inFlight = null;
      });
      return ok(await inFlight);
    },

    async get(key) {
      if (cached !== null) return cached.get(key);
      const rows = await db.select().from(metric).where(eq(metric.key, key)).limit(1);
      const row = rows[0];
      return row === undefined ? null : toDefinition(row);
    },

    invalidate() {
      cached = null;
      inFlight = null;
    },
  };
}
