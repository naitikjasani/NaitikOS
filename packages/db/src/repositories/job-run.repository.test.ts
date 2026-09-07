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
import { abandonedJobRuns, recentJobRuns } from './job-run.repository';

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
 */
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
      { name: 'prune-telemetry', status: 'succeeded', durationMs: 40, rowsAffected: 12, errorCode: null },
      {
        name: 'run-detectors',
        status: 'failed',
        durationMs: 900,
        /* Absent rather than zero. A step that reported no row count did not
         * report zero rows, and the dashboard renders the difference. */
        rowsAffected: null,
        errorCode: 'query_failed',
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
