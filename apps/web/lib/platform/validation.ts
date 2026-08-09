/**
 * The validation service — §12's V1 instrumentation, assembled.
 *
 * One read that answers the only question the thirty days are asking: is the
 * ritual happening, and is it getting cheaper or more expensive?
 *
 * Everything here is arithmetic `core` already owns. This file's whole job is
 * to fetch the inputs, and its one decision is **which window each metric uses**:
 *
 * - The **gate** uses §12's fixed dates. It is a claim about a specific
 *   thirty-one days and moving its window would defeat it.
 * - The **health metrics** use a trailing window ending today, because "is
 *   capture getting slower" is a question about now.
 * - The **comparison** for `detectGaming` uses the window *before* that one, so
 *   "rising" means rising against the operator's own recent past rather than
 *   against a fixed baseline that stops being relevant in a fortnight.
 */

import 'server-only';

import type { Result } from '@naitikos/shared';
import { err, ok } from '@naitikos/shared';
import type {
  BudgetedMetric,
  CompletionFunnel,
  DomainError,
  GamingVerdict,
  GateEvaluation,
} from '@naitikos/core';
import {
  captureLatency,
  closeFunnel,
  correctionRate,
  derivedFactRatio,
  detectGaming,
  evaluateGate,
  foregroundMinutesByDay,
  shiftDayKey,
  timeInApp,
  windowDayKeys,
  zonedDayBounds,
} from '@naitikos/core';
import type { Database } from '@naitikos/db';
import { closedDaysBetween, createTelemetryRepository } from '@naitikos/db';

/** The trailing window the health metrics are computed over. */
export const HEALTH_WINDOW_DAYS = 30;

export type ValidationReport = {
  readonly todayDayKey: string;
  readonly windowDays: number;
  readonly gate: GateEvaluation;
  /** Days in the gate window with a completed Close, for the grid. */
  readonly closedDays: readonly string[];
  readonly gateWindowDays: readonly string[];

  readonly captureLatency: BudgetedMetric;
  readonly timeInApp: BudgetedMetric;
  readonly correctionRate: BudgetedMetric;
  readonly derivedFacts: BudgetedMetric;
  readonly closeFunnel: CompletionFunnel;
  readonly gaming: GamingVerdict;

  /** Raw counts, so the dashboard can show what is and is not being emitted. */
  readonly eventCounts: Readonly<Record<string, number>>;
  readonly syncFailures: number;
};

export async function loadValidationReport(
  db: Database,
  options: { readonly todayDayKey: string; readonly zone: string },
): Promise<Result<ValidationReport, DomainError>> {
  const { todayDayKey, zone } = options;

  const currentDays = windowDayKeys(todayDayKey, HEALTH_WINDOW_DAYS);
  const currentFrom = currentDays[0];
  const priorEnd = currentFrom === undefined ? null : shiftDayKey(currentFrom, -1);
  const priorDays = priorEnd === null ? [] : windowDayKeys(priorEnd, HEALTH_WINDOW_DAYS);
  const priorFrom = priorDays[0];

  if (currentFrom === undefined || priorFrom === undefined) {
    return err({ kind: 'validation', code: 'invalid_day', message: 'todayDayKey must be YYYY-MM-DD.', issues: [] });
  }

  const current = boundsFor(currentFrom, todayDayKey, zone);
  const prior = priorEnd === null ? null : boundsFor(priorFrom, priorEnd, zone);
  const gateBounds = boundsFor('2026-08-30', '2026-09-29', zone);

  if (current === null || prior === null || gateBounds === null) {
    return err({ kind: 'validation', code: 'invalid_day', message: 'Could not resolve the window.', issues: [] });
  }

  const telemetry = createTelemetryRepository(db);

  const [
    latencyNow,
    latencyBefore,
    transitionsNow,
    transitionsBefore,
    counts,
    priorCounts,
    sources,
    corrections,
    closedInGate,
  ] = await Promise.all([
    telemetry.valuesFor('capture.latency', current.start, current.end),
    telemetry.valuesFor('capture.latency', prior.start, prior.end),
    telemetry.transitions(current.start, current.end, zone),
    telemetry.transitions(prior.start, prior.end, zone),
    telemetry.countsByName(current.start, current.end),
    telemetry.countsByName(prior.start, prior.end),
    telemetry.observationsBySource(current.start, current.end),
    telemetry.correctionCounts(current.start, current.end),
    closedDaysBetween(db, gateBounds.start, gateBounds.end, zone),
  ]);

  for (const result of [
    latencyNow,
    latencyBefore,
    transitionsNow,
    transitionsBefore,
    counts,
    priorCounts,
    sources,
    corrections,
  ]) {
    if (!result.ok) return err(result.error);
  }
  if (
    !latencyNow.ok ||
    !latencyBefore.ok ||
    !transitionsNow.ok ||
    !transitionsBefore.ok ||
    !counts.ok ||
    !priorCounts.ok ||
    !sources.ok ||
    !corrections.ok
  ) {
    return err({ kind: 'validation', code: 'telemetry_unavailable', message: 'Telemetry unavailable.', issues: [] });
  }

  const minutesNow = [...foregroundMinutesByDay(transitionsNow.value).values()];
  const minutesBefore = [...foregroundMinutesByDay(transitionsBefore.value).values()];

  const latency = captureLatency(latencyNow.value);
  const foreground = timeInApp(minutesNow);

  const started = counts.value['daily_close.started'] ?? 0;
  const submitted = counts.value['daily_close.submitted'] ?? 0;

  return ok({
    todayDayKey,
    windowDays: HEALTH_WINDOW_DAYS,
    gate: evaluateGate({ todayDayKey, closes: closedInGate.length }),
    closedDays: closedInGate,
    gateWindowDays: windowDayKeys('2026-09-29', 31),

    captureLatency: latency,
    timeInApp: foreground,
    correctionRate: correctionRate(corrections.value.total, corrections.value.corrected),
    derivedFacts: derivedFactRatio(sources.value),
    closeFunnel: closeFunnel(started, submitted),
    gaming: detectGaming({
      /*
       * Compounding Days over each window, approximated by the Close-submitted
       * count rather than by a second pair of queries. The two differ only when
       * a day is closed twice, which the Close's own idempotency makes rare —
       * and `detectGaming` is a *direction* check, so a small absolute error in
       * both windows cancels.
       */
      compoundingDaysNow: submitted,
      compoundingDaysBefore: priorCounts.value['daily_close.submitted'] ?? 0,
      latencyP50Now: latency.value,
      latencyP50Before: captureLatency(latencyBefore.value).value,
      timeInAppNow: foreground.value,
      timeInAppBefore: timeInApp(minutesBefore).value,
    }),

    eventCounts: counts.value,
    syncFailures: counts.value['sync.failed'] ?? 0,
  });
}

function boundsFor(
  fromDayKey: string,
  toDayKey: string,
  zone: string,
): { readonly start: string; readonly end: string } | null {
  const from = zonedDayBounds(fromDayKey, zone);
  const to = zonedDayBounds(toDayKey, zone);
  if (from === null || to === null) return null;
  return { start: from.start, end: to.end };
}
