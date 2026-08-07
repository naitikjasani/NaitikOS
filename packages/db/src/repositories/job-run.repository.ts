/**
 * The nightly run's completion record.
 *
 * §5.16 makes this the *only* thing standing between a silently dead background
 * pipeline and a maintainer noticing:
 *
 *   "Absence of the record by 05:00 raises an alert."
 *
 * That framing is what makes this file interesting. The alert is on **absence**,
 * which means a bug here fails in the worst possible direction: a recorder that
 * throws on `finish` produces a run that did all its work and left no record, and
 * the alert then reports a nightly run that never happened. So `finish` writes
 * whatever it has and swallows nothing quietly.
 */

import { and, desc, eq, gte, sql } from 'drizzle-orm';
import type { JobRunRecorder, JobRunSummary } from '@naitikos/core';

import type { Database } from '../client';
import { jobRun } from '../schema/operations';

/** The job name a full nightly run records under. §5.16 alerts on this exact value. */
export const NIGHTLY_JOB_NAME = 'nightly';

/**
 * A recorder writing to `job_run`.
 *
 * @param jobName - defaults to {@link NIGHTLY_JOB_NAME}. A single step run alone
 * from `/settings/developer` records under its own name, so a manual re-run of
 * `refresh-rollups` does not satisfy the alert that watches for a full nightly.
 */
export function createJobRunRecorder(db: Database, jobName = NIGHTLY_JOB_NAME): JobRunRecorder {
  return {
    async start(runId, isManual, startedAt) {
      await db.insert(jobRun).values({
        id: runId,
        jobName,
        status: 'running',
        startedAt,
        isManual,
      });
    },

    async finish(summary: JobRunSummary) {
      const failedSteps = summary.steps.filter((step) => step.status === 'failed');

      await db
        .update(jobRun)
        .set({
          status: summary.status === 'succeeded' ? 'succeeded' : 'failed',
          finishedAt: summary.finishedAt,
          durationMs: summary.durationMs,
          // The per-step detail `/settings/developer` renders. Codes and counts
          // only — §5.11's "event names and numeric measurements only" applies to
          // anything a background job writes about its own execution too.
          steps: summary.steps,
          rowsAffected: summary.steps.reduce((total, step) => total + (step.rowsAffected ?? 0), 0),
          errorMessage:
            failedSteps.length === 0
              ? null
              : // Step names and error codes, never a message from the failure
                // itself: a step that failed on a constraint violation would
                // otherwise write the offending row's values into this column.
                failedSteps
                  .map((step) => `${step.name}:${step.errorCode ?? 'unknown'}`)
                  .join(', '),
        })
        .where(eq(jobRun.id, summary.runId));
    },
  };
}

/**
 * The most recent run of a job.
 *
 * `halted` is mapped to `failed` on write, so a caller distinguishing the two
 * reads `steps` — a halted run has `skipped` entries after a `failed` one.
 */
export async function lastJobRun(
  db: Database,
  jobName = NIGHTLY_JOB_NAME,
): Promise<{
  id: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  isManual: boolean;
  errorMessage: string | null;
} | null> {
  const rows = await db
    .select({
      id: jobRun.id,
      status: jobRun.status,
      startedAt: jobRun.startedAt,
      finishedAt: jobRun.finishedAt,
      durationMs: jobRun.durationMs,
      isManual: jobRun.isManual,
      errorMessage: jobRun.errorMessage,
    })
    .from(jobRun)
    .where(eq(jobRun.jobName, jobName))
    .orderBy(desc(jobRun.startedAt))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * Whether a successful, non-manual run has completed since `since`. §5.16's check.
 *
 * Non-manual specifically. A human pressing the button at 11pm must not satisfy an
 * alert that exists to detect the cron having stopped firing — otherwise debugging
 * the problem is what makes the symptom disappear.
 */
export async function hasCompletedRunSince(
  db: Database,
  since: string,
  jobName = NIGHTLY_JOB_NAME,
): Promise<boolean> {
  const rows = await db
    .select({ id: jobRun.id })
    .from(jobRun)
    .where(
      and(
        eq(jobRun.jobName, jobName),
        eq(jobRun.status, 'succeeded'),
        eq(jobRun.isManual, false),
        gte(jobRun.startedAt, since),
      ),
    )
    .limit(1);

  return rows.length > 0;
}

/**
 * Runs left in `running` from an invocation that was killed.
 *
 * A serverless platform terminates mid-step with no chance to write `finish`, so
 * these rows accumulate. They are not the same as a failure — the work may have
 * completed — and conflating them would make the failure count meaningless.
 */
export async function abandonedJobRuns(
  db: Database,
  olderThan: string,
): Promise<readonly { id: string; jobName: string; startedAt: string }[]> {
  return db
    .select({ id: jobRun.id, jobName: jobRun.jobName, startedAt: jobRun.startedAt })
    .from(jobRun)
    .where(and(eq(jobRun.status, 'running'), sql`${jobRun.startedAt} < ${olderThan}`))
    .orderBy(desc(jobRun.startedAt));
}
