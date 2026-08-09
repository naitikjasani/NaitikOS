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
 * ## Two of the twelve steps are registered
 *
 * `JOB_STEPS` names twelve. The ones that do domain work — derivation, rollups,
 * detectors, embeddings — belong to milestones that have not happened, and they
 * arrive with their domains. The two below are operational: they stop the task
 * queue and the upload outbox silently stranding rows, which is what §5.2's
 * "idempotent, safe to re-run" depends on in practice.
 *
 * Running with only two is deliberate rather than incomplete. §5.16's alert
 * watches for the *absence* of a completion record, so a record has to be written
 * from the first night the cron is enabled — otherwise the alert's first firing is
 * a false positive, and an alert that cries wolf once gets muted.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { runJobSchema } from '@naitikos/api';
import type { JobStep, JobStepName } from '@naitikos/core';
import { JOB_STEPS, isoFromMillis, runNightly, systemClock } from '@naitikos/core';
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

/**
 * The registered steps.
 *
 * Three today, all operational rather than domain work: they keep the queues
 * from silently stranding rows and the telemetry table from growing without
 * bound, which is the failure §5.2's "safe to re-run" depends on. Domain steps
 * arrive with their domains.
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
