/**
 * Predictions — integration, against real Postgres.
 *
 * The core tests cover the arithmetic and the calibration report. This covers
 * the constraints, and they are the substance of §10.9 rather than a detail:
 * "every prediction is stored and compared against what actually happened".
 * A schema that let a half-scored row exist would make the calibration rate
 * uninterpretable, and a repository convention is not a guarantee.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { uuidV7 } from '@naitikos/shared';
import type { PredictionInput } from '@naitikos/core';

import { createDatabase } from '../client';
import { resetDomainTables } from '../testing/reset';
import { createPredictionRepository } from './prediction.repository';

const DATABASE_URL = process.env['DATABASE_URL'];
const db = DATABASE_URL === undefined ? undefined : createDatabase(DATABASE_URL);
const suite = db === undefined ? describe.skip : describe;

afterAll(async () => {
  await db?.$client.end({ timeout: 5 });
});

const EPOCH = 1_764_000_000_000;
let counter = 0;
const newId = (): string => uuidV7(EPOCH + (counter += 1));

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

const input = (overrides: Partial<PredictionInput> = {}): PredictionInput => ({
  id: newId(),
  kind: 'bodyweight_projection',
  metricKey: 'body.weight',
  subjectType: null,
  subjectId: null,
  madeAt: '2026-08-30T18:00:00.000Z',
  horizonDayKey: '2026-09-13',
  predictedValue: '77.5',
  intervalLow: '76.2',
  intervalHigh: '78.8',
  unit: 'kg',
  method: 'linear_trend',
  observationCount: 21,
  fitConfidence: '0.8100',
  assumptions: 'Assuming intake and training continue as over the last 21 days.',
  ...overrides,
});

suite('prediction repository (§10.9)', () => {
  /* `describe.skipIf` has established that `db` exists; TypeScript cannot see
   * through it, so it is narrowed once rather than at each call site. */
  if (db === undefined) throw new Error('no database');
  const database = db;
  const repo = createPredictionRepository(database);

  beforeEach(async () => {
    await resetDomainTables(database.$client);
  });

  it('is idempotent on a replayed id, so a re-run does not double the denominator', async () => {
    const id = newId();
    unwrap(await repo.record(input({ id, predictedValue: '77.5' })));
    /* A different point estimate, still inside the same interval — see the note
     * on constraint ordering below for why it cannot be an arbitrary number. */
    const second = unwrap(await repo.record(input({ id, predictedValue: '78.0' })));

    expect(second.predictedValue).toBe('77.500000');
    expect(unwrap(await repo.all())).toHaveLength(1);
  });

  it('checks the interval before it checks for a conflict', async () => {
    /*
     * Worth knowing, because it is the opposite of what `ON CONFLICT DO
     * NOTHING` suggests: Postgres evaluates CHECK constraints on the proposed
     * row *before* it looks for a conflicting one. A replay carrying a
     * malformed row therefore raises rather than quietly no-opping.
     *
     * That is the safer order — a nightly job resending a corrupted prediction
     * should fail loudly rather than be silently absorbed by the row that is
     * already there — but a caller expecting a replay to always be a no-op
     * would be surprised, so it is asserted rather than assumed.
     */
    const id = newId();
    unwrap(await repo.record(input({ id })));

    let raised: unknown = null;
    try {
      await repo.record(input({ id, predictedValue: '99.9' }));
    } catch (error: unknown) {
      raised = error;
    }

    expect(raised).not.toBeNull();
    /* Drizzle wraps the driver error, so the constraint name is on the cause
     * rather than on the message `toThrow` would match. Asserted through the
     * cause so the test names the actual constraint instead of matching
     * Drizzle's "Failed query" prefix, which would pass for any SQL error. */
    const cause = raised instanceof Error ? raised.cause : null;
    expect(String(cause)).toMatch(/prediction_interval_ordered/u);
  });

  describe('resolution', () => {
    it('scores a prediction with a value and a verdict', async () => {
      const id = newId();
      await repo.record(input({ id }));

      const scored = unwrap(
        await repo.resolve({
          id,
          at: '2026-09-13T06:00:00.000Z',
          resolvedValue: '77.1',
          wasWithinInterval: true,
        }),
      );

      expect(scored.resolvedAt).toBe('2026-09-13T06:00:00.000Z');
      expect(scored.wasWithinInterval).toBe(true);
      expect(scored.unresolvableReason).toBeNull();
    });

    it('accepts an unresolvable outcome with no value at all', async () => {
      const id = newId();
      await repo.record(input({ id }));

      /*
       * A horizon that arrives with nothing to compare against is an
       * unanswered question, not a miss. Scoring it either way would corrupt
       * the calibration record in one direction, so the schema permits this
       * third shape explicitly.
       */
      const unscored = unwrap(
        await repo.resolve({
          id,
          at: '2026-09-13T06:00:00.000Z',
          unresolvableReason: 'No reading was recorded on the horizon day.',
        }),
      );

      expect(unscored.resolvedValue).toBeNull();
      expect(unscored.wasWithinInterval).toBeNull();
      expect(unscored.unresolvableReason).not.toBeNull();
    });

    it('refuses to re-score a prediction that already has a verdict', async () => {
      const id = newId();
      await repo.record(input({ id }));
      await repo.resolve({ id, at: '2026-09-13T06:00:00.000Z', resolvedValue: '80.0', wasWithinInterval: false });

      /* A second run must not flip a miss into a hit against a later reading.
       * What was predicted, and how it turned out, is written once. */
      const again = await repo.resolve({
        id,
        at: '2026-09-14T06:00:00.000Z',
        resolvedValue: '77.4',
        wasWithinInterval: true,
      });
      expect(again.ok).toBe(false);

      const stored = unwrap(await repo.byId(id));
      expect(stored?.wasWithinInterval).toBe(false);
    });
  });

  describe('constraints the database enforces', () => {
    it('rejects an interval that does not bracket the point estimate', async () => {
      await expect(
        database.$client`
          INSERT INTO prediction
            (id, kind, metric_key, made_at, horizon_day_key, predicted_value,
             interval_low, interval_high, unit, method, observation_count, assumptions)
          VALUES (${newId()}, 'bodyweight_projection', 'body.weight', now(), '2026-09-13',
                  77.5, 78.0, 79.0, 'kg', 'linear_trend', 21, 'x')`,
      ).rejects.toThrow(/prediction_interval_ordered/u);
    });

    it('rejects a half-written resolution — a value with no verdict', async () => {
      const id = newId();
      await repo.record(input({ id }));

      await expect(
        database.$client`
          UPDATE prediction SET resolved_at = now(), resolved_value = 77.1 WHERE id = ${id}`,
      ).rejects.toThrow(/prediction_resolution_complete/u);
    });

    it('rejects a verdict with no value', async () => {
      const id = newId();
      await repo.record(input({ id }));

      await expect(
        database.$client`
          UPDATE prediction SET resolved_at = now(), was_within_interval = true WHERE id = ${id}`,
      ).rejects.toThrow(/prediction_resolution_complete/u);
    });

    it('rejects a negative observation count', async () => {
      await expect(
        database.$client`
          INSERT INTO prediction
            (id, kind, metric_key, made_at, horizon_day_key, predicted_value,
             interval_low, interval_high, unit, method, observation_count, assumptions)
          VALUES (${newId()}, 'bodyweight_projection', 'body.weight', now(), '2026-09-13',
                  77.5, 76.0, 79.0, 'kg', 'linear_trend', -1, 'x')`,
      ).rejects.toThrow(/prediction_observation_count/u);
    });

    it('has no enum member for a clinical prediction', async () => {
      /*
       * §10.9: "Prohibited: any prediction about a clinical outcome, a symptom
       * course, or a medication response." The enum is the structural half of
       * that — there is no kind such a prediction could be written under, which
       * is §10.10's unrepresentable-harmful-output applied to a column.
       */
      await expect(
        database.$client`
          INSERT INTO prediction
            (id, kind, metric_key, made_at, horizon_day_key, predicted_value,
             interval_low, interval_high, unit, method, observation_count, assumptions)
          VALUES (${newId()}, 'symptom_course', 'body.skin.state', now(), '2026-09-13',
                  3, 2, 4, '', 'linear_trend', 21, 'x')`,
      ).rejects.toThrow(/invalid input value for enum prediction_kind/u);
    });
  });

  describe('pending', () => {
    it('returns only unresolved predictions whose horizon has arrived', async () => {
      const due = newId();
      const future = newId();
      const done = newId();

      await repo.record(input({ id: due, horizonDayKey: '2026-09-13' }));
      await repo.record(input({ id: future, horizonDayKey: '2026-12-25' }));
      await repo.record(input({ id: done, horizonDayKey: '2026-09-01' }));
      await repo.resolve({ id: done, at: '2026-09-01T06:00:00.000Z', resolvedValue: '77.0', wasWithinInterval: true });

      const rows = unwrap(await repo.pending('2026-09-13'));
      expect(rows.map((row) => row.id)).toEqual([due]);
    });

    it('orders a backlog by horizon, so an interrupted run resolves a prefix', async () => {
      const later = newId();
      const earlier = newId();
      await repo.record(input({ id: later, horizonDayKey: '2026-09-10' }));
      await repo.record(input({ id: earlier, horizonDayKey: '2026-09-02' }));

      expect(unwrap(await repo.pending('2026-09-13')).map((row) => row.id)).toEqual([earlier, later]);
    });
  });

  it('reads back only scored rows for the calibration report', async () => {
    const scored = newId();
    const open = newId();
    await repo.record(input({ id: scored }));
    await repo.record(input({ id: open }));
    await repo.resolve({ id: scored, at: '2026-09-13T06:00:00.000Z', resolvedValue: '77.1', wasWithinInterval: true });

    expect(unwrap(await repo.resolved()).map((row) => row.id)).toEqual([scored]);
  });
});
