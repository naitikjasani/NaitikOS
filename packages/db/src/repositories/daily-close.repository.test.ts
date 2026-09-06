/**
 * The Daily Close and idempotency — integration, against real Postgres.
 *
 * `core/close/plan.test.ts` covers what a submission *means*. This covers what
 * only a database can answer:
 *
 *   - The whole Close commits or none of it does (§5.7 depends on that).
 *   - A re-close reads back its own writes and supersedes rather than duplicates.
 *   - Compounding Days counts distinct local days, in the zone each close was
 *     captured in (§1.5, §5.3).
 *   - A replayed request returns the *original response* rather than a conflict,
 *     which is what lets the outbox drain (§5.7).
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { isErr, isOk, uuidV7 } from '@naitikos/shared';
import type { ClosePlan, MetricRegistry } from '@naitikos/core';
import { initialHlcState, planDailyClose } from '@naitikos/core';

import { createDatabase } from '../client';
import { createDailyCloseRepository } from './daily-close.repository';
import { createIdempotencyRepository, fingerprintRequest } from './idempotency.repository';
import { createMetricRepository } from './metric.repository';

const DATABASE_URL = process.env['DATABASE_URL'];
const db = DATABASE_URL === undefined ? undefined : createDatabase(DATABASE_URL);
const suite = db === undefined ? describe.skip : describe;

afterAll(async () => {
  await db?.$client.end({ timeout: 5 });
});

const ZONE = 'Asia/Kolkata';
/** 2026-08-03 21:00 IST — the evening of the day being closed. */
const NOW = '2026-08-03T15:30:00.000Z';
const EPOCH = 1_754_000_000_000;
const newId = (): string => uuidV7(EPOCH);

async function registry(): Promise<MetricRegistry> {
  if (db === undefined) throw new Error('no database');
  const result = await createMetricRepository(db).registry();
  if (!isOk(result)) throw new Error('registry unavailable');
  return result.value;
}

function commitContext(reg: MetricRegistry) {
  return {
    registry: reg,
    hlcState: initialHlcState(newId(), EPOCH),
    recordedAt: NOW,
    physicalMillis: EPOCH,
    newId,
  };
}

suite('daily close repository', () => {
  beforeEach(async () => {
    if (db === undefined) return;
    await db.$client`alter table observation disable trigger observation_append_only`;
    await db.$client`delete from note`;
    await db.$client`delete from observation`;
    await db.$client`alter table observation enable trigger observation_append_only`;
  });

  /** Plan and commit in one step, the way the route handler does. */
  async function close(
    answers: Parameters<typeof planDailyClose>[0]['answers'],
    dayKey = '2026-08-03',
    now = NOW,
  ): Promise<ClosePlan> {
    if (db === undefined) throw new Error('no database');
    const reg = await registry();
    const repository = createDailyCloseRepository(db, reg);

    const state = await repository.stateFor(dayKey, ZONE);
    if (!isOk(state)) throw new Error(`stateFor failed: ${state.error.message}`);

    const plan = planDailyClose({ dayKey, zone: ZONE, answers }, state.value, {
      registry: reg,
      now,
      newId,
    });
    if (!isOk(plan)) throw new Error(`plan failed: ${plan.error.message}`);

    const committed = await repository.commit(plan.value, commitContext(reg));
    if (!isOk(committed)) throw new Error(`commit failed: ${committed.error.message}`);
    return plan.value;
  }

  it('writes a whole close and reads its own state back', async () => {
    if (db === undefined) return;

    await close([
      { kind: 'metric', metricKey: 'mind.mood', value: { kind: 'integer', value: 4 } },
      { kind: 'metric', metricKey: 'body.sleep.duration', value: { kind: 'number', value: '7.5' } },
      { kind: 'note', text: 'woke at 3am' },
    ]);

    const reg = await registry();
    const state = await createDailyCloseRepository(db, reg).stateFor('2026-08-03', ZONE);
    expect(isOk(state)).toBe(true);
    if (!isOk(state)) return;

    const byMetric = new Map(state.value.observations.map((o) => [o.metricKey, o]));
    expect(byMetric.get('mind.mood')?.value).toBe('4.000000');
    expect(byMetric.get('body.sleep.duration')?.value).toBe('7.500000');
    expect(byMetric.has('system.daily_close.completed')).toBe(true);
    expect(state.value.note?.content).toBe('woke at 3am');
  });

  /**
   * §4.0: "A partial close counts as a close." The marker is written even when
   * nothing else is, because §1.5 counts days rather than answers.
   */
  it('records a close with no answers at all', async () => {
    if (db === undefined) return;
    await close([]);

    const rows = await db.$client`
      select count(*)::int as n from observation where metric_key = 'system.daily_close.completed'
    `;
    expect(rows[0]?.['n']).toBe(1);
  });

  /**
   * The 21:00-then-23:30 case, end to end: the second submission supersedes the
   * first rather than duplicating it, and both rows survive (§9.1).
   */
  it('supersedes on re-close and keeps both rows', async () => {
    if (db === undefined) return;

    await close([{ kind: 'metric', metricKey: 'mind.mood', value: { kind: 'integer', value: 4 } }]);
    await close([{ kind: 'metric', metricKey: 'mind.mood', value: { kind: 'integer', value: 2 } }]);

    const all = await db.$client`
      select value, superseded_by_id from observation where metric_key = 'mind.mood' order by value
    `;
    expect(all).toHaveLength(2);
    // The 2 is current; the 4 points at it.
    const current = all.filter((row) => row['superseded_by_id'] === null);
    expect(current).toHaveLength(1);
    expect(current[0]?.['value']).toBe('2.000000');

    // And still exactly one completion marker, so the day is counted once.
    const markers = await db.$client`
      select count(*)::int as n from observation where metric_key = 'system.daily_close.completed'
    `;
    expect(markers[0]?.['n']).toBe(1);
  });

  it('writes nothing at all when the answers have not changed', async () => {
    if (db === undefined) return;

    await close([{ kind: 'metric', metricKey: 'mind.mood', value: { kind: 'integer', value: 4 } }]);
    const before = await db.$client`select count(*)::int as n from observation`;

    const plan = await close([{ kind: 'metric', metricKey: 'mind.mood', value: { kind: 'integer', value: 4 } }]);
    const after = await db.$client`select count(*)::int as n from observation`;

    expect(plan.unchanged).toEqual(['mind.mood']);
    expect(after[0]?.['n']).toBe(before[0]?.['n']);
  });

  it('edits the note in place and tombstones it when cleared', async () => {
    if (db === undefined) return;

    await close([{ kind: 'note', text: 'first line' }]);
    await close([{ kind: 'note', text: 'second line' }]);

    const edited = await db.$client`select content, version from note where deleted_at is null`;
    expect(edited).toHaveLength(1);
    expect(edited[0]?.['content']).toBe('second line');
    // §9.4's optimistic-concurrency counter, incremented in SQL.
    expect(edited[0]?.['version']).toBe(2);

    await close([{ kind: 'note', text: '   ' }]);
    const cleared = await db.$client`select deleted_at, delete_reason from note`;
    expect(cleared[0]?.['deleted_at']).not.toBeNull();
    // Tombstoned, not erased (§9.4).
    expect(cleared[0]?.['delete_reason']).toContain('Cleared');
  });

  /**
   * §1.5's North Star input. Counted as distinct local days in the zone each
   * close was *captured* in — re-bucketing into the reader's zone can move a
   * close onto a day that already had one, quietly deleting a Compounding Day.
   */
  it('counts Compounding Days as distinct local days', async () => {
    if (db === undefined) return;

    await close([], '2026-08-01', '2026-08-01T15:30:00.000Z');
    await close([], '2026-08-02', '2026-08-02T15:30:00.000Z');
    await close([], '2026-08-03', NOW);
    // A second close of the 3rd must not count twice.
    await close([{ kind: 'metric', metricKey: 'mind.mood', value: { kind: 'integer', value: 3 } }], '2026-08-03', NOW);

    const reg = await registry();
    const count = await createDailyCloseRepository(db, reg).compoundingDays('2026-08-03', ZONE, 90);
    expect(isOk(count) && count.value).toBe(3);
  });

  it('excludes days outside the trailing window', async () => {
    if (db === undefined) return;

    await close([], '2026-08-01', '2026-08-01T15:30:00.000Z');
    await close([], '2026-08-03', NOW);

    const reg = await registry();
    const repository = createDailyCloseRepository(db, reg);

    // A two-day window ending on the 3rd covers the 2nd and the 3rd.
    const narrow = await repository.compoundingDays('2026-08-03', ZONE, 2);
    expect(isOk(narrow) && narrow.value).toBe(1);

    const wide = await repository.compoundingDays('2026-08-03', ZONE, 30);
    expect(isOk(wide) && wide.value).toBe(2);
  });

  it('reports an unresolvable day rather than guessing', async () => {
    if (db === undefined) return;
    const reg = await registry();
    const repository = createDailyCloseRepository(db, reg);

    expect(isErr(await repository.stateFor('2026-08-03', 'IST'))).toBe(true);
    expect(isErr(await repository.compoundingDays('2026-08-03', 'IST', 90))).toBe(true);
  });

  /**
   * The atomicity §5.7 depends on. A commit that fails partway must leave the
   * day exactly as it was, or a replay writes the survivors again as
   * corrections of themselves.
   */
  it('rolls the whole close back when any part of it fails', async () => {
    if (db === undefined) return;
    const reg = await registry();
    const repository = createDailyCloseRepository(db, reg);

    await close([{ kind: 'metric', metricKey: 'mind.mood', value: { kind: 'integer', value: 4 } }]);
    const before = await db.$client`select count(*)::int as n from observation`;

    /*
     * A plan whose supersession names a row that is already superseded. The
     * observations insert succeeds and the supersession then fails, so the
     * insert must be rolled back with it.
     */
    const state = await repository.stateFor('2026-08-03', ZONE);
    if (!isOk(state)) throw new Error('stateFor failed');
    const mood = state.value.observations.find((o) => o.metricKey === 'mind.mood');

    const doomed: ClosePlan = {
      dayKey: '2026-08-03',
      zone: ZONE,
      observedAt: NOW,
      observations: [
        {
          id: newId(),
          metricKey: 'mind.energy',
          value: { kind: 'integer', value: 3 },
          observedAt: NOW,
          observedZone: ZONE,
        },
        {
          id: newId(),
          metricKey: 'mind.mood',
          value: { kind: 'integer', value: 1 },
          observedAt: NOW,
          observedZone: ZONE,
          supersedes: { id: newId(), reason: 'points at a row that does not exist' },
        },
      ],
      medicationEvents: [],
      note: null,
      noteRemovalId: null,
      unchanged: [],
      isFirstCloseOfDay: false,
      completionObservationId: mood?.id ?? newId(),
    };

    const result = await repository.commit(doomed, commitContext(reg));
    expect(isErr(result)).toBe(true);

    const after = await db.$client`select count(*)::int as n from observation`;
    expect(after[0]?.['n']).toBe(before[0]?.['n']);
  });
});

suite('idempotency repository', () => {
  beforeEach(async () => {
    if (db === undefined) return;
    await db.$client`delete from idempotency_record`;
  });

  const ENDPOINT = 'POST /api/close';
  const BODY = '{"dayKey":"2026-08-03"}';

  it('claims a fresh key, then replays the stored response', async () => {
    if (db === undefined) return;
    const repository = createIdempotencyRepository(db);
    const key = newId();
    const fingerprint = fingerprintRequest(ENDPOINT, BODY);

    const first = await repository.claim(key, ENDPOINT, fingerprint);
    expect(isOk(first) && first.value.state).toBe('fresh');

    await repository.complete(key, 201, { written: 3 });

    const replay = await repository.claim(key, ENDPOINT, fingerprint);
    expect(isOk(replay)).toBe(true);
    if (!isOk(replay) || replay.value.state !== 'replayed') throw new Error('expected a replay');
    // The *original response*, not a conflict — this is what lets the outbox
    // reconcile and drop the entry rather than retrying forever (§5.7).
    expect(replay.value.status).toBe(201);
    expect(replay.value.body).toEqual({ written: 3 });
  });

  /**
   * Two drains racing the same entry — a tab and a service worker arriving
   * within milliseconds. Exactly one may proceed.
   */
  it('gives the key to exactly one of two concurrent claims', async () => {
    if (db === undefined) return;
    const repository = createIdempotencyRepository(db);
    const key = newId();
    const fingerprint = fingerprintRequest(ENDPOINT, BODY);

    const [a, b] = await Promise.all([
      repository.claim(key, ENDPOINT, fingerprint),
      repository.claim(key, ENDPOINT, fingerprint),
    ]);

    const states = [a, b].map((result) => (isOk(result) ? result.value.state : 'error'));
    expect(states.filter((state) => state === 'fresh')).toHaveLength(1);
    expect(states.filter((state) => state === 'in_flight')).toHaveLength(1);
  });

  /**
   * A client bug that reuses one key for two different submissions would
   * otherwise get the first one's response for the second — and the record
   * would simply lack a day, with no error anywhere.
   */
  it('refuses a key reused for a different request', async () => {
    if (db === undefined) return;
    const repository = createIdempotencyRepository(db);
    const key = newId();

    await repository.claim(key, ENDPOINT, fingerprintRequest(ENDPOINT, BODY));
    const clash = await repository.claim(key, ENDPOINT, fingerprintRequest(ENDPOINT, '{"dayKey":"2026-08-04"}'));

    expect(isErr(clash) && clash.error.code).toBe('idempotency_key_reused');
  });

  /**
   * Without `release`, a request that failed on a transient error would hold
   * its key for the full TTL and every retry for a week would be told
   * `in_flight` — a self-inflicted outage with a seven-day recovery.
   */
  it('releases an incomplete key so a retry can execute', async () => {
    if (db === undefined) return;
    const repository = createIdempotencyRepository(db);
    const key = newId();
    const fingerprint = fingerprintRequest(ENDPOINT, BODY);

    await repository.claim(key, ENDPOINT, fingerprint);
    await repository.release(key);

    const retry = await repository.claim(key, ENDPOINT, fingerprint);
    expect(isOk(retry) && retry.value.state).toBe('fresh');
  });

  it('does not release a completed key', async () => {
    if (db === undefined) return;
    const repository = createIdempotencyRepository(db);
    const key = newId();
    const fingerprint = fingerprintRequest(ENDPOINT, BODY);

    await repository.claim(key, ENDPOINT, fingerprint);
    await repository.complete(key, 200, { ok: true });
    await repository.release(key);

    const replay = await repository.claim(key, ENDPOINT, fingerprint);
    expect(isOk(replay) && replay.value.state).toBe('replayed');
  });

  it('prunes expired keys and leaves live ones', async () => {
    if (db === undefined) return;
    const repository = createIdempotencyRepository(db);
    await repository.claim(newId(), ENDPOINT, fingerprintRequest(ENDPOINT, BODY));

    const nothingYet = await repository.prune('2020-01-01T00:00:00.000Z');
    expect(isOk(nothingYet) && nothingYet.value).toBe(0);

    const everything = await repository.prune('2099-01-01T00:00:00.000Z');
    expect(isOk(everything) && everything.value).toBe(1);
  });

  it('reclaims a stranded in-flight key once its TTL has passed', async () => {
    if (db === undefined) return;
    const repository = createIdempotencyRepository(db);
    const key = newId();
    const fingerprint = fingerprintRequest(ENDPOINT, BODY);

    /*
     * The scenario: a process claims a key and dies before `complete()` or
     * `release()`. The row stays incomplete for ever.
     *
     * `claim` returned `in_flight` for any incomplete record without looking at
     * `expires_at`, so every retry of that outbox entry was refused
     * permanently — the capture could never be unblocked. The seven-day
     * recovery `release()`'s comment promises was carried entirely by the
     * `prune-idempotency` job, which is named in `JOB_STEPS` and never
     * registered in the nightly route, so nothing pruned and the recovery did
     * not exist.
     */
    await repository.claim(key, ENDPOINT, fingerprint);

    const stillLive = await repository.claim(key, ENDPOINT, fingerprint);
    expect(isOk(stillLive) && stillLive.value.state).toBe('in_flight');

    // Age the record past its TTL. Nothing else can move the clock — the expiry
    // is computed by Postgres, so the test has to reach the row directly.
    await db.execute(sql`update idempotency_record set expires_at = now() - interval '1 second' where key = ${key}`);

    const retry = await repository.claim(key, ENDPOINT, fingerprint);
    expect(isOk(retry) && retry.value.state).toBe('fresh');
  });

  it('re-executes rather than replaying a completed key past its TTL', async () => {
    if (db === undefined) return;
    const repository = createIdempotencyRepository(db);
    const key = newId();
    const fingerprint = fingerprintRequest(ENDPOINT, BODY);

    await repository.claim(key, ENDPOINT, fingerprint);
    await repository.complete(key, 200, { ok: true });

    const withinTtl = await repository.claim(key, ENDPOINT, fingerprint);
    expect(isOk(withinTtl) && withinTtl.value.state).toBe('replayed');

    await db.execute(sql`update idempotency_record set expires_at = now() - interval '1 second' where key = ${key}`);

    /* This is what a TTL means: after seven days the stored response is no
     * longer remembered, so a replay arriving later re-executes rather than
     * returning a week-old body. */
    const afterTtl = await repository.claim(key, ENDPOINT, fingerprint);
    expect(isOk(afterTtl) && afterTtl.value.state).toBe('fresh');
  });

  it('fingerprints differently for different endpoints and bodies', () => {
    expect(fingerprintRequest(ENDPOINT, BODY)).toBe(fingerprintRequest(ENDPOINT, BODY));
    expect(fingerprintRequest(ENDPOINT, BODY)).not.toBe(fingerprintRequest('POST /api/observations', BODY));
    expect(fingerprintRequest(ENDPOINT, BODY)).not.toBe(fingerprintRequest(ENDPOINT, '{}'));
    expect(fingerprintRequest(ENDPOINT, BODY)).toHaveLength(16);
  });
});
