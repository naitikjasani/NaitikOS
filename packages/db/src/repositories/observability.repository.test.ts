/**
 * The Postgres metrics writer — integration.
 *
 * This file exists because of a specific defect. `MetricDimensions` declares
 * five dimensions; `app_event` had columns for two; and `createPostgresMetrics`
 * accepted all five and persisted two, silently. Nothing caught it because
 * nothing tested this writer at all.
 *
 * So the assertions below are about the *dimensions surviving the write*, which
 * is the property that was broken, rather than about the writer being callable.
 *
 * ## Two things make this suite awkward, and both are deliberate elsewhere
 *
 * `write` is fire-and-forget — §1.4 keeps a telemetry insert off the critical
 * path of every capture, so the metric functions return `void` and there is no
 * promise to await. The tests therefore poll for the row rather than awaiting
 * the insert, which is the honest way to test a deliberately unawaited write.
 *
 * `app_event` is not in `RESET_ORDER` — it is operational data rather than
 * domain data, and clearing it between suites is not this harness's job. So
 * every row written here carries a unique name-suffix and is deleted
 * afterwards, rather than the suite assuming an empty table.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { eq, like } from 'drizzle-orm';
import { uuidV7 } from '@naitikos/shared';
import { systemClock } from '@naitikos/core';

import { createDatabase } from '../client';
import { appEvent } from '../schema/operations';
import { createPostgresMetrics } from './observability.repository';

const DATABASE_URL = process.env['DATABASE_URL'];
const db = DATABASE_URL === undefined ? undefined : createDatabase(DATABASE_URL);
const suite = db === undefined ? describe.skip : describe;

/** Marks every row this file writes, so the cleanup cannot catch anyone else's. */
const MARKER = `test-${uuidV7(systemClock.nowMillis())}`;

afterAll(async () => {
  if (db !== undefined) {
    await db.delete(appEvent).where(like(appEvent.route, `${MARKER}%`));
  }
  await db?.$client.end({ timeout: 5 });
});

/**
 * Wait for the fire-and-forget insert to land.
 *
 * Polls rather than sleeps: a fixed sleep is either flaky or slow, and on a
 * local socket this returns on the first or second attempt.
 */
async function settle(route: string): Promise<typeof appEvent.$inferSelect | undefined> {
  if (db === undefined) return undefined;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const rows = await db.select().from(appEvent).where(eq(appEvent.route, route)).limit(1);
    const [row] = rows;
    if (row !== undefined) return row;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return undefined;
}

suite('postgres metrics', () => {
  it('persists all five dimensions, not the two it used to', async () => {
    if (db === undefined) return;
    const route = `${MARKER}/all`;

    createPostgresMetrics(db).increment('job.step.failed', {
      route,
      eventType: 'Workout.SetLogged',
      stepName: 'downsample-samples',
      outcome: 'failure',
      deviceClass: 'phone',
    });

    const row = await settle(route);
    expect(row).toBeDefined();
    if (row === undefined) return;

    /* The three that were dropped. `stepName` is the one that mattered most:
     * without it `job.step.failed` is a single counter for a seventeen-step
     * pipeline. */
    expect(row.eventType).toBe('Workout.SetLogged');
    expect(row.stepName).toBe('downsample-samples');
    expect(row.outcome).toBe('failure');
    expect(row.deviceClass).toBe('phone');
    expect(row.name).toBe('job.step.failed');
  });

  it('leaves an unsupplied dimension NULL rather than writing an empty string', async () => {
    if (db === undefined) return;
    const route = `${MARKER}/sparse`;

    createPostgresMetrics(db).gauge('media.outbox.depth', 3, { route });

    const row = await settle(route);
    expect(row).toBeDefined();
    if (row === undefined) return;

    /* A dimension that was not measured is unknown, not empty. §8.9's rule
     * applied to telemetry: the absence has to stay distinguishable from a
     * measured blank, or a later query cannot tell them apart. */
    expect(row.eventType).toBeNull();
    expect(row.stepName).toBeNull();
    expect(row.outcome).toBeNull();
    expect(row.value).toBe(3);
  });

  it('records the outcome on both paths of `time`, which is why the column exists', async () => {
    if (db === undefined) return;
    const metrics = createPostgresMetrics(db);

    const okRoute = `${MARKER}/time-ok`;
    await metrics.time('api.request.duration', { route: okRoute }, async () => 'done');

    const failRoute = `${MARKER}/time-fail`;
    await expect(
      metrics.time('api.request.duration', { route: failRoute }, async () => {
        throw new Error('deliberate');
      }),
    ).rejects.toThrow('deliberate');

    const succeeded = await settle(okRoute);
    const failed = await settle(failRoute);

    /*
     * The distinction `Metrics.time` documents and could not previously make:
     * "measuring only the happy path hides the case where failures are slow,
     * which is the case worth knowing about."
     */
    expect(succeeded?.outcome).toBe('success');
    expect(failed?.outcome).toBe('failure');
  });

  it('does not reject when the write fails, because telemetry is not on the critical path', async () => {
    if (db === undefined) return;

    const failures: string[] = [];
    const metrics = createPostgresMetrics(db, {
      onWriteFailure: (_error, context) => failures.push(context),
    });

    /* A value no bigint column will take. The point is that the caller is
     * unaffected: §1.4 puts capture latency ahead of telemetry, so a broken
     * metric must never surface as a failed capture. */
    expect(() => {
      metrics.observe('capture.latency', Number.NaN, { route: `${MARKER}/broken` });
    }).not.toThrow();

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(failures).toEqual(['metric:capture.latency']);
  });
});
