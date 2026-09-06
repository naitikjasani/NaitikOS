/**
 * The two nightly steps that keep `sample` from becoming the reason this
 * database needs a bigger machine (§9.7).
 *
 * Both are here rather than in the route for the reason every other nightly
 * step is: the route is transport (§5.2), and a step that composed a repository
 * inline would be a step nobody could call from anywhere else — including from
 * the manual trigger on `/settings/developer`, which is the one place these two
 * will actually be exercised before the first month rolls over.
 *
 * ## Neither halts the run, and they fail in opposite directions
 *
 * A missed partition means an import lands in DEFAULT — stored, findable,
 * slightly slower. A missed collapse means the table stays at full resolution
 * for another day. Both are recoverable by running again tomorrow, and neither
 * is worth stopping the integrity check over.
 */

import 'server-only';

import type { Result } from '@naitikos/shared';
import { ok } from '@naitikos/shared';
import type { DomainError } from '@naitikos/core';
import { SAMPLE_RETENTION_DAYS, downsampleCutoff, isoFromMillis, parseInstant, systemClock } from '@naitikos/core';
import type { Database } from '@naitikos/db';
import { createMetricRepository, createSampleRepository } from '@naitikos/db';

export type PartitionOutcome = {
  /** Partition names that now exist, whether created tonight or already there. */
  readonly ensured: readonly string[];
  /** Rows in DEFAULT. Expected to be zero, and reported when it is not. */
  readonly stranded: number;
};

/**
 * How many months ahead to guarantee a partition for.
 *
 * Two. One is enough in the ordinary case — the job runs every night, so the
 * month ahead is always covered — but C3 says the system "must survive
 * three-week gaps in attention", and the failure mode of a missed month is an
 * import silently landing in DEFAULT. A second month costs one catalogue lookup
 * and buys a whole missed month of nightly runs.
 */
export const PARTITION_LOOKAHEAD_MONTHS = 2;

/** Month starts, as `YYYY-MM-01`, from this month forward. */
function upcomingMonths(nowIso: string, count: number): readonly string[] {
  const now = parseInstant(nowIso);
  if (now === null) return [];
  const months: string[] = [];
  for (let ahead = 0; ahead <= count; ahead += 1) {
    /*
     * `Date.UTC` with an overflowing month index, which rolls the year for
     * free. Computed in UTC rather than in the profile's zone deliberately: a
     * partition boundary is a `timestamptz` range, and `sample.observed_at` is
     * an instant. Bucketing the boundary locally would leave the first five and
     * a half hours of each month in Asia/Kolkata belonging to the previous
     * partition — correct arithmetic producing an off-by-one nobody would find
     * until a month's readings were split across two children.
     */
    months.push(isoFromMillis(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + ahead, 1)).slice(0, 10));
  }
  return months;
}

export async function maintainSamplePartitions(db: Database): Promise<Result<PartitionOutcome, DomainError>> {
  const samples = createSampleRepository(db);
  const nowIso = isoFromMillis(systemClock.nowMillis());

  const ensured: string[] = [];
  for (const month of upcomingMonths(nowIso, PARTITION_LOOKAHEAD_MONTHS)) {
    const created = await samples.ensurePartition(month);
    if (!created.ok) return created;
    ensured.push(created.value);
  }

  const stranded = await samples.strandedCount();
  if (!stranded.ok) return stranded;

  return ok({ ensured, stranded: stranded.value });
}

export type CollapseOutcome = {
  readonly written: number;
  readonly dropped: number;
  readonly preserved: readonly string[];
  readonly cutoff: string;
};

export async function collapseOldSamples(db: Database): Promise<Result<CollapseOutcome, DomainError>> {
  const samples = createSampleRepository(db);
  const metrics = createMetricRepository(db);

  const registry = await metrics.registry();
  if (!registry.ok) return registry;

  /*
   * The cutoff comes from `core` rather than being computed here, and it is
   * truncated to the hour there — which is what makes a re-run at 03:47
   * collapse exactly the same set as the run at 03:00 that failed. §5.2's
   * "idempotent, safe to re-run" is a property of that arithmetic, not of this
   * function.
   */
  const cutoff = downsampleCutoff(isoFromMillis(systemClock.nowMillis()), SAMPLE_RETENTION_DAYS);

  const outcome = await samples.downsample(cutoff, registry.value);
  if (!outcome.ok) return outcome;

  return ok({ ...outcome.value, cutoff });
}
