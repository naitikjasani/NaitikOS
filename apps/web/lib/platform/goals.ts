/**
 * The Goals service — §4.10's projection, assembled.
 *
 * Everything on a goal screen except the title is derived here, on every read,
 * from observations other modules wrote. That is the whole architecture of the
 * feature and it is worth restating because it is the thing a later refactor
 * would be tempted to "optimise" into a cached column:
 *
 *   observations → dailyRollup → linearTrend → deriveProgress → the screen
 *
 * §4.10: "Recording progress separately from the underlying observations would
 * create two sources of truth and guarantee drift."
 *
 * ## One query per metric, not per target
 *
 * Two goals can target the same metric — a bulk and a lean goal both read
 * `body.weight`. The observation read is therefore keyed by metric and shared,
 * which matters because the window is ninety days and this page loads on every
 * visit to `/life/goals`.
 */

import 'server-only';

import type { Result } from '@naitikos/shared';
import { ok } from '@naitikos/shared';
import type {
  DailyValue,
  DomainError,
  Goal,
  GoalProgress,
  GoalTarget,
  GoalTension,
  MetricDefinition,
  Observation,
  ProgressSnapshot,
} from '@naitikos/core';
import {
  dailyRollup,
  dayKeyInZone,
  detectTensions,
  deriveProgress,
  isoFromMillis,
  planSnapshot,
  snapshotDrift,
  systemClock,
} from '@naitikos/core';
import type { Database } from '@naitikos/db';
import { createGoalRepository, createMetricRepository, createObservationRepository } from '@naitikos/db';

/**
 * How far back the series behind a goal is read.
 *
 * Ninety days rather than the goal's whole life. A bulk started in March should
 * be projected from how it is going *now*, not from a line fitted through a
 * deload in April — and `MAX_PROJECTION_DAYS` caps the forecast at a fortnight
 * anyway, so a longer fit buys precision the projection cannot use.
 */
export const GOAL_WINDOW_DAYS = 90;

export type GoalWithProgress = {
  readonly goal: Goal;
  readonly targets: readonly GoalTarget[];
  readonly progress: readonly GoalProgress[];
};

export type GoalsOverview = {
  readonly goals: readonly GoalWithProgress[];
  readonly tensions: readonly GoalTension[];
  readonly todayDayKey: string;
};

export async function loadGoals(db: Database, zone: string): Promise<Result<GoalsOverview, DomainError>> {
  const goals = createGoalRepository(db);

  const [all, targets] = await Promise.all([goals.all(), goals.targets()]);
  if (!all.ok) return all;
  if (!targets.ok) return targets;

  const nowMillis = systemClock.nowMillis();
  const todayDayKey = dayKeyInZone(isoFromMillis(nowMillis), zone);

  const series = await seriesByMetric(db, targets.value, zone, nowMillis);
  if (!series.ok) return series;

  const withProgress = all.value.map((goal) => {
    const own = targets.value.filter((target) => target.goalId === goal.id);
    return {
      goal,
      targets: own,
      progress: own.map((target) =>
        deriveProgress({
          target,
          series: series.value.get(target.metricKey) ?? [],
          horizonDayKey: goal.horizonAt === null ? null : goal.horizonAt.slice(0, 10),
          todayDayKey,
        }),
      ),
    };
  });

  return ok({ goals: withProgress, tensions: detectTensions(all.value, targets.value), todayDayKey });
}

export type GoalDetail = GoalWithProgress & {
  readonly snapshots: readonly ProgressSnapshot[];
  readonly todayDayKey: string;
  readonly metrics: ReadonlyMap<string, MetricDefinition>;
};

export async function loadGoal(
  db: Database,
  id: string,
  zone: string,
): Promise<Result<GoalDetail | null, DomainError>> {
  const goals = createGoalRepository(db);

  const found = await goals.byId(id);
  if (!found.ok) return found;
  if (found.value === null) return ok(null);

  const [targets, snapshots, registry] = await Promise.all([
    goals.targets([id]),
    goals.snapshots(id),
    createMetricRepository(db).registry(),
  ]);
  if (!targets.ok) return targets;
  if (!snapshots.ok) return snapshots;
  if (!registry.ok) return registry;

  const nowMillis = systemClock.nowMillis();
  const todayDayKey = dayKeyInZone(isoFromMillis(nowMillis), zone);

  const series = await seriesByMetric(db, targets.value, zone, nowMillis);
  if (!series.ok) return series;

  const metrics = new Map<string, MetricDefinition>();
  for (const target of targets.value) {
    const definition = registry.value.get(target.metricKey);
    if (definition !== null) metrics.set(target.metricKey, definition);
  }

  return ok({
    goal: found.value,
    targets: targets.value,
    progress: targets.value.map((target) =>
      deriveProgress({
        target,
        series: series.value.get(target.metricKey) ?? [],
        horizonDayKey: found.value?.horizonAt === null ? null : (found.value?.horizonAt ?? null)?.slice(0, 10) ?? null,
        todayDayKey,
      }),
    ),
    snapshots: snapshots.value,
    todayDayKey,
    metrics,
  });
}

/* -------------------------------------------------------------------------
 * The review ritual
 * ---------------------------------------------------------------------- */

export type ReviewLine = {
  readonly goal: Goal;
  readonly target: GoalTarget;
  readonly progress: GoalProgress;
  /** How the believed trajectory has moved since the last review. */
  readonly ratioDelta: number | null;
  readonly arrivalMoved: boolean;
  readonly comparedTo: string | null;
};

export type GoalReview = {
  readonly lines: readonly ReviewLine[];
  readonly tensions: readonly GoalTension[];
  readonly since: string;
};

/**
 * §4.10's review ritual.
 *
 * The content is deliberately not "where am I" — the overview already shows
 * that. It is *"has the picture changed since I last looked, and did it change
 * because I moved or because the data was corrected?"* Nothing here can tell
 * those two apart, and it does not pretend to; the point is to make the
 * divergence visible so the operator goes and looks.
 */
export async function loadGoalReview(
  db: Database,
  zone: string,
  sinceDays = 30,
): Promise<Result<GoalReview, DomainError>> {
  const overview = await loadGoals(db, zone);
  if (!overview.ok) return overview;

  const nowMillis = systemClock.nowMillis();
  const since = isoFromMillis(nowMillis - sinceDays * 86_400_000);

  const previous = await createGoalRepository(db).latestSnapshots(since);
  if (!previous.ok) return previous;

  const byTarget = new Map(previous.value.map((row) => [row.goalTargetId ?? '', row]));
  const lines: ReviewLine[] = [];

  for (const entry of overview.value.goals) {
    if (entry.goal.status !== 'active') continue;
    for (const [index, target] of entry.targets.entries()) {
      const progress = entry.progress[index];
      if (progress === undefined) continue;

      const earlier = byTarget.get(target.id) ?? null;
      /* Today's derivation, expressed as a snapshot so the two are compared
       * like with like rather than one being a row and one being a live fit. */
      const now = planSnapshot('review', entry.goal.id, target, progress, isoFromMillis(nowMillis));
      const drift = earlier === null || now === null ? null : snapshotDrift(earlier, now);

      lines.push({
        goal: entry.goal,
        target,
        progress,
        ratioDelta: drift?.ratioDelta ?? null,
        arrivalMoved: drift?.arrivalMoved ?? false,
        comparedTo: earlier?.takenAt ?? null,
      });
    }
  }

  return ok({ lines, tensions: overview.value.tensions, since });
}

/* -------------------------------------------------------------------------
 * The nightly snapshot
 * ---------------------------------------------------------------------- */

/**
 * Write tonight's belief for every active goal.
 *
 * The row id is derived from the target and the day, not minted randomly, so a
 * job re-run on the same evening is a no-op rather than a second row. `n`
 * snapshots per target per night would make the trajectory-as-believed history
 * unreadable within a month.
 */
export async function snapshotGoalProgress(db: Database, zone: string): Promise<Result<number, DomainError>> {
  const overview = await loadGoals(db, zone);
  if (!overview.ok) return overview;

  const takenAt = isoFromMillis(systemClock.nowMillis());
  const rows = [];

  for (const entry of overview.value.goals) {
    if (entry.goal.status !== 'active') continue;
    for (const [index, target] of entry.targets.entries()) {
      const progress = entry.progress[index];
      if (progress === undefined) continue;
      const row = planSnapshot(
        snapshotId(target.id, overview.value.todayDayKey),
        entry.goal.id,
        target,
        progress,
        takenAt,
      );
      if (row !== null) rows.push(row);
    }
  }

  return createGoalRepository(db).recordSnapshots(rows);
}

/**
 * A UUID-shaped id from the target and the day.
 *
 * Deterministic so the nightly write is idempotent. Not a real UUIDv5 — there
 * is no namespace hashing — but well-formed and stable, which is the property
 * `ON CONFLICT DO NOTHING` needs. Same approach as the lab confirmation path.
 */
function snapshotId(targetId: string, dayKey: string): string {
  const digits = targetId.replace(/-/gu, '').padEnd(32, '0');
  let hash = 0x811c_9dc5;
  for (let index = 0; index < dayKey.length; index += 1) {
    hash ^= dayKey.charCodeAt(index);
    hash = Math.imul(hash, 0x0100_0193) >>> 0;
  }
  const tail = hash.toString(16).padStart(8, '0').padEnd(12, '0').slice(0, 12);
  return `${digits.slice(0, 8)}-${digits.slice(8, 12)}-5${digits.slice(13, 16)}-8${digits.slice(17, 20)}-${tail}`;
}

/* -------------------------------------------------------------------------
 * Shared series read
 * ---------------------------------------------------------------------- */

async function seriesByMetric(
  db: Database,
  targets: readonly GoalTarget[],
  zone: string,
  nowMillis: number,
): Promise<Result<ReadonlyMap<string, readonly DailyValue[]>, DomainError>> {
  const keys = [...new Set(targets.map((target) => target.metricKey))];
  const series = new Map<string, readonly DailyValue[]>();
  if (keys.length === 0) return ok(series);

  const registry = await createMetricRepository(db).registry();
  if (!registry.ok) return registry;

  const observations = await createObservationRepository(db).query({
    metricKeys: keys,
    from: isoFromMillis(nowMillis - GOAL_WINDOW_DAYS * 86_400_000),
    until: isoFromMillis(nowMillis + 86_400_000),
    currentOnly: true,
  });
  if (!observations.ok) return observations;

  const byKey = new Map<string, Observation[]>();
  for (const observation of observations.value) {
    const bucket = byKey.get(observation.metricKey);
    if (bucket === undefined) byKey.set(observation.metricKey, [observation]);
    else bucket.push(observation);
  }

  for (const key of keys) {
    const definition = registry.value.get(key);
    /*
     * A target on an unregistered metric produces an empty series rather than
     * an error. The metric may be registered later — a goal on
     * `nutrition.protein` written before Nutrition ships is a reasonable thing
     * to have done — and failing the whole page for it would be wrong.
     */
    if (definition === null) continue;
    series.set(key, dailyRollup(byKey.get(key) ?? [], definition, { zone }));
  }

  return ok(series);
}
