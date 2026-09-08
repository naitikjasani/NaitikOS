/**
 * What `/settings/developer` knows — §3.2's "feature flags, diagnostics, schema
 * version", plus the nightly run §5.2 says is triggerable from there.
 *
 * ## Four reads, one page, and three of them are about absence
 *
 * This loader assembles an unusually negative report, and that is the honest
 * shape of the thing rather than a gap in it:
 *
 * - `job_run` has no rows at all, because the cron has never fired against this
 *   database. §5.16 alerts on exactly that absence, so the page states it as the
 *   finding it is instead of rendering an empty list.
 * - `schema_migration` has no rows either, and never will until something writes
 *   to it. See {@link SchemaVersionReport}.
 * - `feature_flag` has four rows that nothing reads. See {@link DeveloperDiagnostics}.
 *
 * §8.9's rule — missing data is shown as missing — usually governs a chart with
 * a hole in it. Here it governs a whole page, and the temptation it guards
 * against is worse than a misleading sparkline: a dashboard that displays a
 * confident "schema v18" or a toggle that appears to arm a kill switch is a
 * surface actively lying about operational state to the one person who would
 * act on it.
 *
 * ## Why the registered-step list is duplicated here
 *
 * `stepsFor` lives inside the route handler and is not exported; a page cannot
 * import from `app/api` without turning a route module into a library. So
 * {@link REGISTERED_STEPS} restates it, and restating a list is how lists drift.
 *
 * The mitigation is that the drift is *detectable* and the page says so: every
 * completed run records the exact set of step names that executed, so
 * {@link NightlyReport.declarationDrift} compares this declaration against the
 * last run's own account of itself. A step registered in the route and forgotten
 * here shows up as a disagreement the first night after it lands, rather than as
 * a quietly wrong table.
 */

import 'server-only';

import type { Result } from '@naitikos/shared';
import { ok } from '@naitikos/shared';
import type { DomainError, JobStepName } from '@naitikos/core';
import { ABANDONED_RUN_AFTER_MS, JOB_STEPS, isoFromMillis, systemClock } from '@naitikos/core';
import type {
  Database,
  DatabaseIdentity,
  FeatureFlagRow,
  JobRunDetail,
  SchemaMigrationRow,
} from '@naitikos/db';
import {
  NIGHTLY_JOB_NAME,
  abandonedJobRuns,
  createDiagnosticsReader,
  hasCompletedRunSince,
  recentJobRuns,
} from '@naitikos/db';

/**
 * The steps `stepsFor` registers, as of 7 September 2026.
 *
 * Nine of the seventeen in `JOB_STEPS`. The eight absent ones do **domain** work
 * and arrive with their domains — `docs/background-jobs.md` puts it as "a rollup
 * step is meaningless before there is anything to roll up" — so their absence is
 * a statement about which modules exist, not about the pipeline being broken.
 *
 * Ordered as `JOB_STEPS` orders them rather than as the route lists them,
 * because that is the order they execute in: `runNightly` walks the canonical
 * list, and two pairs in it are load-bearing (resolve before make; partition
 * before downsample).
 */
export const REGISTERED_STEPS: readonly JobStepName[] = Object.freeze([
  'resolve-predictions',
  'make-predictions',
  'run-detectors',
  'verify-media-integrity',
  'maintain-partitions',
  'downsample-samples',
  'prune-idempotency',
  'prune-telemetry',
  'drain-task-queue',
]);

/** How many past runs the page lists. */
export const RUN_HISTORY_LIMIT = 8;

export type StepRegistration = {
  readonly name: JobStepName;
  readonly registered: boolean;
};

export type NightlyReport = {
  /** Newest first, across every job name. Empty when the cron has never run. */
  readonly runs: readonly JobRunDetail[];
  readonly last: JobRunDetail | null;
  /**
   * §5.16's own reading: a *successful, non-manual* run in the last 24 hours.
   *
   * Non-manual deliberately — a human pressing the button must not satisfy the
   * alert that exists to detect the cron having stopped, or debugging the
   * problem is what makes the symptom disappear.
   */
  readonly healthy: boolean;
  /**
   * Runs that started and never recorded an ending, older than
   * `ABANDONED_RUN_AFTER_MS` (defined in `core`, beside the budget it is twice).
   *
   * `adjudicated` says whether the recorder has since *proved* the run dead — a
   * later run of the same job recorded an ending — rather than merely observing
   * that this one is late. An unadjudicated row is the louder signal: nothing
   * has finished since it started.
   */
  readonly abandoned: readonly {
    readonly id: string;
    readonly jobName: string;
    readonly startedAt: string;
    readonly adjudicated: boolean;
  }[];
  readonly steps: readonly StepRegistration[];
  readonly registeredCount: number;
  /**
   * Step names the last full nightly executed that {@link REGISTERED_STEPS} does
   * not claim, and vice versa. Empty is the healthy answer; `null` means no run
   * has ever completed, so there is nothing to check the declaration against.
   */
  readonly declarationDrift: readonly string[] | null;
};

/**
 * What can honestly be said about the schema version.
 *
 * **Nothing writes to `public.schema_migration`.** It is declared in
 * `schema/operations.ts` with `checksum`, `applied_by` and `is_data_migration`,
 * it is indexed, it is carried by §9.10's export — and it is empty. The ledger
 * that actually records what has been applied is drizzle-kit's
 * `drizzle.__drizzle_migrations`, which held eighteen rows when this was
 * written.
 *
 * Two things follow, and the page states both.
 *
 * **This report does not read drizzle's table.** It is another tool's private
 * bookkeeping — a separate schema, a leading double underscore, a shape with no
 * compatibility promise across drizzle-kit versions — and application code that
 * read it would silently acquire a dependency on the migration tool's internals
 * in order to display a number. Worse, it would *look* authoritative while
 * papering over the actual defect, which is that the table §9.4 gave the
 * application has no writer. The honest display is the application's own ledger,
 * empty, next to a sentence explaining why and where the real one lives.
 *
 * **The fix is a migration runner that records what it applied**, not a read
 * that reaches across. `packages/db/src/migrate.ts` is where that belongs, and
 * it is out of this page's hands.
 */
export type SchemaVersionReport = {
  /** Rows of `public.schema_migration`, newest first. Empty today. */
  readonly applied: readonly SchemaMigrationRow[];
  /** The real ledger's location, named on the page rather than read. */
  readonly authoritativeLedger: string;
};

export type RuntimeReport = {
  /** `VERCEL_ENV` where deployed, else `NODE_ENV`. */
  readonly environment: string;
  /**
   * The deployed commit, or null.
   *
   * Null on a local machine and that is shown as unknown rather than as
   * "development": §8.9 again. There is no application version to fall back on
   * — every `package.json` in the monorepo is at `0.0.0` because nothing is
   * published — so the commit is the only build identifier that exists, and it
   * only exists when a platform injects it.
   */
  readonly commit: string | null;
  readonly database: DatabaseIdentity;
  /** The zone the nightly's 03:00 is local to. A constant today (§5.3). */
  readonly zone: string;
  readonly generatedAt: string;
  /** Milliseconds the four reads took. Real, measured here, and nowhere else. */
  readonly readMillis: number;
};

export type DeveloperDiagnostics = {
  readonly nightly: NightlyReport;
  readonly schema: SchemaVersionReport;
  /**
   * `feature_flag`, read-only.
   *
   * §5.15 asks for "feature flags for anything touching the substrate" so a bad
   * change can be turned off without a deploy. These four rows are seeded and
   * **no code path consults any of them** — the AI kill switch included, which
   * is currently enforced by there being no LLM call to switch off rather than
   * by the flag. Until something reads them, rollback is the only lever, and the
   * page says so instead of offering a toggle that would write a value into a
   * table nothing queries.
   */
  readonly flags: readonly FeatureFlagRow[];
  readonly runtime: RuntimeReport;
};

export async function loadDeveloperDiagnostics(
  db: Database,
  options: { readonly zone: string },
): Promise<Result<DeveloperDiagnostics, DomainError>> {
  const startedMillis = systemClock.nowMillis();
  const nowIso = isoFromMillis(startedMillis);
  const reader = createDiagnosticsReader(db);

  const [runs, healthy, abandoned, flags, applied, database] = await Promise.all([
    recentJobRuns(db, { limit: RUN_HISTORY_LIMIT }),
    /*
     * The same 24-hour window `GET /api/jobs/nightly` reports as `healthy`, so
     * the page and the alert cannot disagree about whether tonight happened.
     */
    hasCompletedRunSince(db, isoFromMillis(startedMillis - 24 * 60 * 60 * 1000)),
    abandonedJobRuns(db, isoFromMillis(startedMillis - ABANDONED_RUN_AFTER_MS)),
    reader.featureFlags(),
    reader.schemaLedger(),
    reader.database(),
  ]);

  if (!runs.ok) return runs;
  if (!flags.ok) return flags;
  if (!applied.ok) return applied;
  if (!database.ok) return database;

  const last = runs.value[0] ?? null;

  return ok({
    nightly: {
      runs: runs.value,
      last,
      healthy,
      abandoned,
      steps: JOB_STEPS.map((name) => ({ name, registered: REGISTERED_STEPS.includes(name) })),
      registeredCount: REGISTERED_STEPS.length,
      declarationDrift: driftAgainst(runs.value),
    },
    schema: {
      applied: applied.value,
      /* Named, not read. See {@link SchemaVersionReport}. */
      authoritativeLedger: 'drizzle.__drizzle_migrations',
    },
    flags: flags.value,
    runtime: {
      environment: process.env['VERCEL_ENV'] ?? process.env['NODE_ENV'] ?? 'unknown',
      commit: process.env['VERCEL_GIT_COMMIT_SHA'] ?? null,
      database: database.value,
      zone: options.zone,
      generatedAt: nowIso,
      readMillis: systemClock.nowMillis() - startedMillis,
    },
  });
}

/**
 * Compare {@link REGISTERED_STEPS} against what a run actually executed.
 *
 * The most recent *complete* nightly is the witness — a run filtered by `only`,
 * or one halted part-way, executed a subset by design and would report every
 * unreached step as drift. `only` runs are indistinguishable from full ones in
 * `job_run` (nothing records the filter), so the check settles for the most
 * recent nightly that recorded no skipped steps: a halted run is excluded, and a
 * single-step `only` run is not, which makes a false positive possible after a
 * manual partial run. A disagreement is therefore *reported*, never acted upon,
 * and the page words it as a prompt to look rather than as a fault.
 */
function driftAgainst(runs: readonly JobRunDetail[]): readonly string[] | null {
  const witness = runs.find(
    (run) =>
      run.jobName === NIGHTLY_JOB_NAME &&
      run.finishedAt !== null &&
      run.steps.length > 0 &&
      !run.steps.some((step) => step.status === 'skipped'),
  );
  if (witness === undefined) return null;

  const executed = new Set(witness.steps.map((step) => step.name));
  const declared = new Set<string>(REGISTERED_STEPS);

  return [
    ...[...executed].filter((name) => !declared.has(name)),
    ...[...declared].filter((name) => !executed.has(name)),
  ].sort();
}
