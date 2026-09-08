/**
 * Reading the completion record back — integration.
 *
 * The write side of `job_run` has been exercised since Week 2 by anything that
 * runs the nightly. The *read* side had no caller until `/settings/developer`
 * grew one, which is how `abandonedJobRuns` came to be shipped, exported, and
 * never once executed against a real table.
 *
 * So these tests are pointed at the two things a dashboard read can get wrong
 * and a type cannot catch: the ordering, and the `steps` jsonb — a column whose
 * contents TypeScript believes on trust and Postgres does not check.
 */

import { eq } from 'drizzle-orm';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { isOk, uuidV7 } from '@naitikos/shared';

import { createDatabase } from '../client';
import { jobRun } from '../schema/operations';
import {
  ABANDONED_JOB_RUN_MARKER,
  abandonedJobRuns,
  createJobRunRecorder,
  markAbandonedJobRuns,
  recentJobRuns,
} from './job-run.repository';

const DATABASE_URL = process.env['DATABASE_URL'];
const db = DATABASE_URL === undefined ? undefined : createDatabase(DATABASE_URL);
const suite = db === undefined ? describe.skip : describe;

afterAll(async () => {
  await db?.$client.end({ timeout: 5 });
});

/*
 * `job_run` is an operational table and `resetDomainTables` deliberately leaves
 * it alone — see the note in `testing/reset.ts`. This suite therefore cleans up
 * after itself by id rather than truncating, because the local database is the
 * development database and a maintainer's real run history is not this suite's
 * to delete.
 *
 * For the same reason every row below is filed under a synthetic job name. The
 * recorder's `finish` adjudicates older unfinished runs *of the same job*, and a
 * test writing under `nightly` would reach out of its own rows and mark a
 * maintainer's genuinely stranded run — a suite that mutates the history it was
 * told not to delete.
 */
const scopedJobName = (id: string): string => `test-job-run-${id.slice(0, 8)}`;
const written: string[] = [];
const EPOCH = 1_767_000_000_000;
let counter = 0;
const newId = (): string => {
  const id = uuidV7(EPOCH + (counter += 1));
  written.push(id);
  return id;
};

afterEach(async () => {
  if (db === undefined || written.length === 0) return;
  for (const id of written.splice(0)) {
    await db.delete(jobRun).where(eq(jobRun.id, id));
  }
});

suite('recentJobRuns', () => {
  it('returns runs newest first, across job names', async () => {
    if (db === undefined) return;

    const older = newId();
    const newer = newId();

    await db.insert(jobRun).values([
      {
        id: older,
        jobName: 'nightly',
        status: 'succeeded',
        startedAt: '2026-09-05T21:30:00.000Z',
        finishedAt: '2026-09-05T21:30:12.000Z',
        durationMs: 12_000,
        isManual: false,
        steps: [],
      },
      {
        id: newer,
        /* A single step re-run files under its own name (see the recorder).
         * A dashboard filtered to `nightly` would not show it, which is the
         * default this read deliberately does not take. */
        jobName: 'prune-telemetry',
        status: 'succeeded',
        startedAt: '2026-09-06T21:30:00.000Z',
        finishedAt: '2026-09-06T21:30:01.000Z',
        durationMs: 1_000,
        isManual: true,
        steps: [],
      },
    ]);

    const result = await recentJobRuns(db, { limit: 5 });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    const ours = result.value.filter((run) => run.id === older || run.id === newer);
    expect(ours.map((run) => run.id)).toEqual([newer, older]);
    expect(ours[0]?.isManual).toBe(true);
    expect(ours[0]?.jobName).toBe('prune-telemetry');
  });

  it('parses the steps blob and drops an entry it cannot read', async () => {
    if (db === undefined) return;

    const id = newId();

    await db.insert(jobRun).values({
      id,
      jobName: 'nightly',
      status: 'failed',
      startedAt: '2026-09-07T21:30:00.000Z',
      finishedAt: '2026-09-07T21:30:04.000Z',
      durationMs: 4_000,
      isManual: true,
      errorMessage: 'run-detectors:query_failed',
      /*
       * The third entry is what a row written by an older build looks like from
       * here: a shape that no longer parses. It must be dropped rather than
       * rendered as an undefined name, and the two good entries must survive it.
       */
      steps: [
        { name: 'prune-telemetry', status: 'succeeded', durationMs: 40, rowsAffected: 12 },
        { name: 'run-detectors', status: 'failed', durationMs: 900, errorCode: 'query_failed' },
        { step: 'derive-observations', outcome: 'ok' },
      ],
    });

    const result = await recentJobRuns(db, { limit: 5, jobName: 'nightly' });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    const run = result.value.find((candidate) => candidate.id === id);
    expect(run?.steps).toEqual([
      {
        name: 'prune-telemetry',
        status: 'succeeded',
        durationMs: 40,
        rowsAffected: 12,
        errorCode: null,
        /* Both entries above were written before the note was persisted, which
         * is the older-build case in miniature: the key is simply absent from
         * the blob and reads back as null rather than as anything invented. */
        note: null,
      },
      {
        name: 'run-detectors',
        status: 'failed',
        durationMs: 900,
        /* Absent rather than zero. A step that reported no row count did not
         * report zero rows, and the dashboard renders the difference. */
        rowsAffected: null,
        errorCode: 'query_failed',
        note: null,
      },
    ]);
  });
});

suite('abandonedJobRuns', () => {
  /*
   * Shipped, exported, and never executed until `/settings/developer` called
   * it — so this is the first thing that has ever run its `startedAt <` filter
   * against a real `timestamptz` column. §5.16 cares about this row shape more
   * than about a failure: a run that started and recorded no ending is the
   * shape a killed serverless invocation leaves behind.
   */
  it('returns a run still marked running from before the cut-off, and not one after it', async () => {
    if (db === undefined) return;

    const stale = newId();
    const live = newId();

    await db.insert(jobRun).values([
      { id: stale, jobName: 'nightly', status: 'running', startedAt: '2026-09-06T21:30:00.000Z' },
      { id: live, jobName: 'nightly', status: 'running', startedAt: '2026-09-07T02:55:00.000Z' },
    ]);

    const abandoned = await abandonedJobRuns(db, '2026-09-07T00:00:00.000Z');
    const ours = abandoned.filter((run) => run.id === stale || run.id === live);

    expect(ours.map((run) => run.id)).toEqual([stale]);
    expect(ours[0]?.startedAt).toBe('2026-09-06T21:30:00.000Z');
  });
});

suite('the note a step returns', () => {
  /*
   * The round trip is the whole point of this test, because the note's absence
   * was invisible from either end for a milestone: every registered step
   * returned one, `docs/background-jobs.md` §10 said `/settings/developer`
   * showed it, and it was dropped in the runner two packages away from the page
   * making the promise. Here the note goes in through the recorder that writes
   * `job_run` and comes back out through the read the dashboard uses.
   *
   * And it needed no migration, which is the second thing being asserted:
   * `steps` is `jsonb`, so the note is one more key in an object it already
   * stored.
   */
  it('survives a write and read of job_run.steps', async () => {
    if (db === undefined) return;

    const runId = newId();
    const jobName = scopedJobName(runId);
    const recorder = createJobRunRecorder(db, jobName);

    await recorder.start(runId, true, '2026-09-07T21:30:00.000Z');
    await recorder.finish({
      runId,
      startedAt: '2026-09-07T21:30:00.000Z',
      finishedAt: '2026-09-07T21:30:04.000Z',
      durationMs: 4_000,
      status: 'failed',
      steps: [
        {
          name: 'prune-idempotency',
          status: 'succeeded',
          durationMs: 12,
          rowsAffected: 0,
          /* Zero rows and a healthy sweep. Without the note this row and a sweep
           * that found nothing to look at are the same reading. */
          note: 'expired before 2026-09-07',
        },
        {
          name: 'drain-task-queue',
          status: 'succeeded',
          durationMs: 40,
          rowsAffected: 3,
          note: '3 recovered, 12 pending',
        },
        { name: 'run-detectors', status: 'failed', durationMs: 5, errorCode: 'query_failed' },
      ],
    });

    const result = await recentJobRuns(db, { limit: 5, jobName });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    const run = result.value.find((candidate) => candidate.id === runId);
    expect(run?.steps).toEqual([
      {
        name: 'prune-idempotency',
        status: 'succeeded',
        durationMs: 12,
        rowsAffected: 0,
        errorCode: null,
        note: 'expired before 2026-09-07',
      },
      {
        name: 'drain-task-queue',
        status: 'succeeded',
        durationMs: 40,
        rowsAffected: 3,
        errorCode: null,
        note: '3 recovered, 12 pending',
      },
      {
        name: 'run-detectors',
        status: 'failed',
        durationMs: 5,
        rowsAffected: null,
        errorCode: 'query_failed',
        /* A failed step has a code rather than an outcome, so it has no note —
         * and that is the same null as a row written before notes were stored.
         * The page shows counts alone rather than inventing a distinction. */
        note: null,
      },
    ]);

    // The error message is unchanged by any of this: step names and codes only,
    // never a message from the failure itself (§5.11).
    expect(run?.errorMessage).toBe('run-detectors:query_failed');
  });
});

suite('markAbandonedJobRuns', () => {
  /*
   * The one thing this must never do. A run judged dead while it is still
   * working would put a false label on the row §5.16's alert reads, and the
   * failure would be invisible — the run finishes fine and the label is the only
   * trace. So the cut-off is `ABANDONED_RUN_AFTER_MS` before the *start* of the
   * run supplying the proof, which is twice a budget the runner enforces on
   * itself.
   */
  it('cannot touch a run that is still legitimately in flight', async () => {
    if (db === undefined) return;

    const stranded = newId();
    const inFlight = newId();
    const jobName = scopedJobName(stranded);

    await db.insert(jobRun).values([
      /* Killed last night: started, no ending, and a day older than the run
       * doing the judging. */
      { id: stranded, jobName, status: 'running', startedAt: '2026-09-06T21:30:00.000Z' },
      /* The overlap case, and the reason the age condition exists: a human
       * pressing the button while cron is mid-run produces two live
       * invocations. Five minutes old, so nowhere near a cut-off set at thirty. */
      { id: inFlight, jobName, status: 'running', startedAt: '2026-09-07T21:25:00.000Z' },
    ]);

    const marked = await markAbandonedJobRuns(db, {
      jobName,
      asOf: '2026-09-07T21:30:00.000Z',
    });

    expect(isOk(marked)).toBe(true);
    if (!isOk(marked)) return;
    expect(marked.value).toBe(1);

    const rows = await abandonedJobRuns(db, '2026-09-08T00:00:00.000Z');
    const ours = new Map(
      rows.filter((row) => row.jobName === jobName).map((row) => [row.id, row.adjudicated]),
    );

    // Both are still listed. The mark records that a row has been *judged*, not
    // that it has been dealt with — hiding judged rows would turn the sweep into
    // the deletion it deliberately is not.
    expect(ours.get(stranded)).toBe(true);
    expect(ours.get(inFlight)).toBe(false);

    const stored = await db
      .select({
        id: jobRun.id,
        status: jobRun.status,
        finishedAt: jobRun.finishedAt,
        durationMs: jobRun.durationMs,
        errorMessage: jobRun.errorMessage,
      })
      .from(jobRun)
      .where(eq(jobRun.id, stranded));

    /*
     * `running` still, and no ending invented. Nothing here knows when the
     * invocation died, and `failed` would fold a run whose work may have
     * completed into the failure count.
     */
    expect(stored[0]?.status).toBe('running');
    expect(stored[0]?.finishedAt).toBeNull();
    expect(stored[0]?.durationMs).toBeNull();
    expect(stored[0]?.errorMessage).toBe(ABANDONED_JOB_RUN_MARKER);

    // Idempotent: a second pass finds nothing left to judge. §5.2's "safe to
    // re-run" covers the bookkeeping as well as the work.
    const again = await markAbandonedJobRuns(db, { jobName, asOf: '2026-09-07T21:30:00.000Z' });
    expect(isOk(again) && again.value).toBe(0);
  });

  it('is what a completing run does on its way out', async () => {
    if (db === undefined) return;

    const stranded = newId();
    const completing = newId();
    const jobName = scopedJobName(stranded);

    await db
      .insert(jobRun)
      .values({ id: stranded, jobName, status: 'running', startedAt: '2026-09-06T21:30:00.000Z' });

    /*
     * No separate sweep, no new step. The proof that an older run is not in
     * flight is a later run reaching its end, so the recorder adjudicates as it
     * writes the completion record — a step could not, because a step runs
     * *during* a run, when tonight's proof does not exist yet.
     */
    const recorder = createJobRunRecorder(db, jobName);
    await recorder.start(completing, false, '2026-09-07T21:30:00.000Z');
    await recorder.finish({
      runId: completing,
      startedAt: '2026-09-07T21:30:00.000Z',
      finishedAt: '2026-09-07T21:30:02.000Z',
      durationMs: 2_000,
      status: 'succeeded',
      steps: [{ name: 'prune-telemetry', status: 'succeeded', durationMs: 20, rowsAffected: 0 }],
    });

    const rows = await abandonedJobRuns(db, '2026-09-08T00:00:00.000Z');
    const ours = rows.filter((row) => row.jobName === jobName);

    // The completing run is not in the list at all — it recorded an ending — and
    // the one that never did is marked.
    expect(ours.map((row) => row.id)).toEqual([stranded]);
    expect(ours[0]?.adjudicated).toBe(true);
  });
});
