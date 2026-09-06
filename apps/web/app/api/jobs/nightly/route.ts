/**
 * The single scheduled entry point (§5.2).
 *
 *   POST — run it. Cron fires this at 03:00 local; a human can too.
 *   GET  — the last run, for `/settings/developer` and for §5.16's alert.
 *
 * §5.2: "Exactly one scheduled entry point — a nightly job at 03:00 local, which
 * runs derivation, detectors, and rollups in sequence. One cron, idempotent, safe
 * to re-run, and manually triggerable from `/settings/developer`. Every
 * additional scheduled job must justify itself against C3."
 *
 * ## Not every registered step is implemented, and that is deliberate
 *
 * `JOB_STEPS` names the full sequence, including steps whose domains have not
 * been built. Each arrives with its domain rather than as an empty shell —
 * derivation, rollups, embeddings, thumbnails. What runs tonight is the list in
 * {@link stepsFor}, and `runNightly` walks `JOB_STEPS` order rather than
 * registration order so a step landing later slots into its place without
 * anyone remembering to reorder this file.
 *
 * Running a partial list is not incomplete. §5.16's alert watches for the
 * *absence* of a completion record, so a record has to be written from the
 * first night the cron is enabled — otherwise the alert's first firing is a
 * false positive, and an alert that cries wolf once gets muted.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { runJobSchema } from '@naitikos/api';
import type { JobStep, JobStepName } from '@naitikos/core';
import { JOB_STEPS, dayKeyInZone, isoFromMillis, runNightly, systemClock } from '@naitikos/core';
import {
  createJobRunRecorder,
  createTelemetryRepository,
  hasCompletedRunSince,
  lastJobRun,
  retentionCutoff,
} from '@naitikos/db';
import { ok } from '@naitikos/shared';

import {
  guard,
  internalErrorResponse,
  isGuardFailure,
  parseJson,
  traceIdFor,
} from '../../../../lib/platform/context';
import type { PlatformContext } from '../../../../lib/platform/context';
import { loadInsights, recordInsightNight } from '../../../../lib/platform/insights';
import { generatePredictions, resolveDuePredictions } from '../../../../lib/platform/predictions';
import { collapseOldSamples, maintainSamplePartitions } from '../../../../lib/platform/samples';

/**
 * The registered steps.
 *
 * Three are operational — they keep the queues from silently stranding rows and
 * the telemetry table from growing without bound, which is the failure §5.2's
 * "safe to re-run" depends on. Two more are custodial: they keep `sample`
 * partitioned ahead of itself and collapsed behind itself, which is what stops
 * §9.7's "tens of millions" of device rows from becoming an operational problem
 * rather than a storage one.
 *
 * `run-detectors` is the first domain step, and it is here rather than on a page
 * render for a specific reason: §10.6 control 4 confirms a finding by seeing it
 * in a *second independent window*, and a control that a page refresh can
 * satisfy is not a control. Opening `/today` twice in an evening must not
 * produce two nights of evidence.
 */
function stepsFor(platform: PlatformContext): readonly JobStep[] {
  // Six hours. Longer than any run's fifteen-minute budget by a wide margin, so a
  // task still legitimately in flight is never stolen from a running invocation.
  const staleThreshold = isoFromMillis(systemClock.nowMillis() - 6 * 60 * 60 * 1000);

  return [
    {
      name: 'drain-task-queue',
      describes: 'Recovers tasks stranded by a killed run, then drains what is due.',
      // Independent of everything else. A queue problem must not stop the
      // integrity check.
      haltOnFailure: false,
      async run() {
        // Recovery first. A run killed by a serverless timeout leaves its claims
        // held forever, and the partial unique index then makes the *next* enqueue
        // dedupe against a task nobody will ever drain.
        const recovered = await platform.tasks.recoverStale(staleThreshold);
        const rows = recovered.ok ? recovered.value : 0;

        const pending = await platform.tasks.pendingCount();
        return ok({
          rowsAffected: rows,
          note: `${String(rows)} recovered, ${String(pending)} pending`,
        });
      },
    },
    {
      name: 'verify-media-integrity',
      describes: 'Reports outbox health, which §5.16 alerts on.',
      haltOnFailure: false,
      async run() {
        const health = await platform.outbox.health(systemClock.now().toISOString());
        const stale = await platform.outbox.recoverStale(staleThreshold);

        platform.observability.metrics.gauge('sync.outbox.depth', health.pending + health.failed);
        if (health.oldestAgeSeconds !== null) {
          platform.observability.metrics.gauge(
            'sync.outbox.oldest_age_seconds',
            health.oldestAgeSeconds,
          );
        }

        return ok({
          rowsAffected: stale.ok ? stale.value : 0,
          note: `${String(health.pending)} pending, ${String(health.failed)} failed`,
        });
      },
    },
    {
      name: 'prune-telemetry',
      describes: 'Discards app_event rows past the ninety-day retention (§5.11).',
      /*
       * Never halts the run. Telemetry is the least important thing in the
       * system by construction — it exists to protect the metrics, not to be
       * one — and a failed sweep must not stop the media integrity check.
       */
      haltOnFailure: false,
      async run() {
        const cutoff = retentionCutoff(systemClock.nowMillis());
        const removed = await createTelemetryRepository(platform.db).pruneEvents(cutoff);
        return ok({
          rowsAffected: removed.ok ? removed.value : 0,
          note: `retention cutoff ${cutoff.slice(0, 10)}`,
        });
      },
    },
    {
      name: 'resolve-predictions',
      describes: 'Scores every prediction whose horizon has arrived, and says which could not be scored.',
      /*
       * Does not halt the run. An unscored prediction stays pending and is
       * picked up tomorrow — `pending` is a day-key comparison, not a
       * one-shot queue — so a failure here delays the calibration record
       * rather than losing anything from it.
       */
      haltOnFailure: false,
      async run() {
        const outcome = await resolveDuePredictions(platform.db, platform.zone);
        if (!outcome.ok) return outcome;

        const { scored, hits, unresolvable } = outcome.value;
        return ok({
          rowsAffected: scored + unresolvable,
          /* The unresolvable count is reported alongside the hits rather than
           * folded into them. §10.9's record is only worth reading if the
           * denominator is visible. */
          note: `${String(hits)} of ${String(scored)} inside the interval, ${String(unresolvable)} unscorable`,
        });
      },
    },
    {
      name: 'make-predictions',
      describes: "Writes tonight's predictions, and counts the subjects that had too little to say.",
      haltOnFailure: false,
      async run() {
        const outcome = await generatePredictions(platform.db, platform.zone);
        if (!outcome.ok) return outcome;

        const { predicted, insufficient, refused, notes } = outcome.value;
        return ok({
          rowsAffected: predicted,
          /*
           * `insufficient` is reported, not hidden. §10.9 requires degrading to
           * "insufficient data" rather than guessing, and a run that silently
           * wrote nothing would be indistinguishable from a broken one.
           */
          note:
            notes.length === 0
              ? `${String(predicted)} written`
              : `${String(predicted)} written, ${String(insufficient)} insufficient, ${String(refused)} refused — ${notes.join('; ')}`,
        });
      },
    },
    {
      name: 'maintain-partitions',
      describes: 'Creates the sample partitions for the months ahead, and reports anything stranded in DEFAULT.',
      /*
       * Does not halt the run. A missing partition sends the next import to the
       * DEFAULT partition, where it is stored and findable rather than lost —
       * so the cost of a failure here is a slower query, not a gap.
       */
      haltOnFailure: false,
      async run() {
        const outcome = await maintainSamplePartitions(platform.db);
        if (!outcome.ok) return outcome;

        const { ensured, stranded } = outcome.value;
        return ok({
          rowsAffected: ensured.length,
          /* The stranded count is in the note rather than only in a metric,
           * because it is the one number on this step that means something is
           * wrong with an exporting device rather than with this system. */
          note:
            stranded === 0
              ? ensured.join(', ')
              : `${ensured.join(', ')} — ${String(stranded)} rows in DEFAULT`,
        });
      },
    },
    {
      name: 'downsample-samples',
      describes: 'Collapses device samples past the retention window into hourly averages (§9.7).',
      /*
       * Does not halt the run, and it is the step whose failure matters least
       * on any given night: the raw rows simply stay, and tomorrow's run
       * collapses them instead. The opposite — halting the integrity check
       * because a collapse failed — would trade a bounded storage cost for an
       * unbounded correctness one.
       */
      haltOnFailure: false,
      async run() {
        const outcome = await collapseOldSamples(platform.db);
        if (!outcome.ok) return outcome;

        const { written, dropped, preserved, cutoff } = outcome.value;
        return ok({
          rowsAffected: written,
          /*
           * `preserved` is named rather than counted. A metric appearing here
           * is keeping its raw rows forever because its aggregation has no
           * honest hourly form, and that is a decision someone should see
           * rather than a number that quietly grows.
           */
          note:
            preserved.length === 0
              ? `${String(dropped)} rows into ${String(written)} hourly averages, before ${cutoff.slice(0, 13)}h`
              : `${String(dropped)} rows into ${String(written)} hourly averages; kept at full resolution: ${preserved.join(', ')}`,
        });
      },
    },
    {
      name: 'run-detectors',
      describes: 'Runs the §10.6 battery and records what it surfaced and what it is holding.',
      /*
       * Does not halt the run. A detector failure is a missing insight, and
       * §10.6's own position is that an absent insight costs far less than a
       * wrong one — stopping the integrity check over it would invert that.
       */
      haltOnFailure: false,
      async run() {
        const nowIso = isoFromMillis(systemClock.nowMillis());
        const todayDayKey = dayKeyInZone(nowIso, platform.zone);

        const outcome = await loadInsights(platform.db, { toDayKey: todayDayKey, zone: platform.zone });
        if (!outcome.ok) return outcome;

        const recorded = await recordInsightNight(platform.db, outcome.value, nowIso);
        if (!recorded.ok) return recorded;

        return ok({
          rowsAffected: recorded.value.surfaced + recorded.value.held,
          note: `${String(recorded.value.surfaced)} surfaced, ${String(recorded.value.held)} held for confirmation, ${String(outcome.value.comparisons)} comparisons`,
        });
      },
    },
  ];
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const traceId = traceIdFor(request);

  try {
    // `settings:write`, not a read permission: this mutates. Cron authenticates as
    // the operator through the same session path — there is no bypass token,
    // because a second way in is a second thing to secure (§5.4).
    const guarded = await guard(request, 'settings:write');
    if (isGuardFailure(guarded)) return guarded.response;
    const { platform } = guarded.context;

    const parsed = await parseJson(request, runJobSchema, traceId);
    if ('response' in parsed) return parsed.response;

    const only = parsed.data.only?.filter((name): name is JobStepName =>
      (JOB_STEPS as readonly string[]).includes(name),
    );

    const summary = await platform.observability.metrics.time(
      'job.run.duration',
      { outcome: 'success' },
      () =>
        runNightly(
          stepsFor(platform),
          {
            clock: systemClock,
            recorder: createJobRunRecorder(platform.db),
            newId: () => crypto.randomUUID(),
          },
          // Manual by default. Cron sets `isManual: false` explicitly — §5.16's
          // alert must not be satisfied by a human pressing the button, or
          // debugging the problem is what makes the symptom disappear.
          {
            isManual: request.headers.get('x-vercel-cron') === null,
            ...(only === undefined || only.length === 0 ? {} : { only }),
          },
        ),
    );

    for (const step of summary.steps) {
      platform.observability.metrics.observe('job.step.duration', step.durationMs, {
        stepName: step.name,
        outcome: step.status === 'succeeded' ? 'success' : 'failure',
      });
      if (step.status === 'failed') {
        platform.observability.metrics.increment('job.step.failed', { stepName: step.name });
      }
    }

    return NextResponse.json(summary, {
      // 200 even for a failed run. The *request* succeeded — it ran the job and
      // produced a report. A 500 here would make cron retry a run that already
      // wrote its completion record, which is a second run, not a retry.
      status: 200,
      headers: { 'cache-control': 'private, no-store' },
    });
  } catch {
    return internalErrorResponse(traceId);
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const traceId = traceIdFor(request);

  try {
    const guarded = await guard(request, 'settings:read');
    if (isGuardFailure(guarded)) return guarded.response;
    const { platform } = guarded.context;

    const since = isoFromMillis(systemClock.nowMillis() - 24 * 60 * 60 * 1000);
    const [last, ranToday] = await Promise.all([
      lastJobRun(platform.db),
      hasCompletedRunSince(platform.db, since),
    ]);

    return NextResponse.json(
      {
        last,
        // §5.16: "Absence of the record by 05:00 raises an alert." This is the
        // reading that alert takes.
        healthy: ranToday,
      },
      { headers: { 'cache-control': 'private, no-store' } },
    );
  } catch {
    return internalErrorResponse(traceId);
  }
}
