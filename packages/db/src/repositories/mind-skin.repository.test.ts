/**
 * Mind, Skin, the routine engine and the medication register — integration,
 * against real Postgres.
 *
 * The core tests cover what these things *mean*. This covers what only a
 * database can answer:
 *
 *   - A skin log re-entered on the same day **edits** that day rather than
 *     creating a second one, and its observations supersede rather than
 *     accumulate — otherwise `mean` aggregation reports the average of the
 *     mistake and the correction.
 *   - A journal list never returns prose, and the count SQL agrees with the
 *     TypeScript one.
 *   - A routine step tapped twice from the outbox is one completion, not two.
 *   - A dose tapped twice for the same slot is one dose.
 *   - An episode replay writes no second anxiety observation.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { isOk, uuidV7 } from '@naitikos/shared';
import type { MetricRegistry } from '@naitikos/core';
import {
  initialHlcState,
  journalListItem,
  planEpisode,
  planJournalEntry,
  planPractice,
  planSkinState,
  windowAdherence,
  windowDayKeys,
  routineWindowAdherence,
} from '@naitikos/core';

import { createDatabase } from '../client';
import { resetDomainTables } from '../testing/reset';
import { createMedicationRepository } from './medication.repository';
import { createMetricRepository } from './metric.repository';
import { createMindRepository } from './mind.repository';
import { createRoutineRepository } from './routine.repository';
import { createSkinRepository } from './skin.repository';

const DATABASE_URL = process.env['DATABASE_URL'];
const db = DATABASE_URL === undefined ? undefined : createDatabase(DATABASE_URL);
const suite = db === undefined ? describe.skip : describe;

afterAll(async () => {
  await db?.$client.end({ timeout: 5 });
});

const ZONE = 'Asia/Kolkata';
const EPOCH = 1_756_000_000_000;
let counter = 0;
const newId = (): string => uuidV7(EPOCH + (counter += 1));

async function registry(): Promise<MetricRegistry> {
  if (db === undefined) throw new Error('no database');
  const result = await createMetricRepository(db).registry();
  if (!isOk(result)) throw new Error('registry unavailable');
  return result.value;
}

function writeContext(reg: MetricRegistry) {
  return {
    registry: reg,
    hlcState: initialHlcState(newId(), EPOCH),
    recordedAt: '2026-08-24T13:00:00.000Z',
    physicalMillis: EPOCH,
    newId,
  };
}

function unwrap<T>(result: { ok: boolean } & Record<string, unknown>, what: string): T {
  if (!result.ok) throw new Error(`${what} failed: ${JSON.stringify(result['error'])}`);
  return result['value'] as T;
}

suite('mind, skin, routine and medication repositories', () => {
  beforeEach(async () => {
    if (db === undefined) return;

    await resetDomainTables(db.$client);
  });

  /* ---------------------------------------------------------------------
   * Skin
   * ------------------------------------------------------------------ */

  describe('the skin log', () => {
    async function writeDay(overrides: Parameters<typeof planSkinState>[0]) {
      if (db === undefined) throw new Error('no database');
      const skin = createSkinRepository(db);
      const existing = await skin.observationsForDay(overrides.observedOn);
      if (!isOk(existing)) throw new Error('read failed');

      const planned = planSkinState({ ...overrides, existing: existing.value });
      if (!isOk(planned)) throw new Error(`plan failed: ${planned.error.message}`);

      return skin.writeState(planned.value, writeContext(await registry()));
    }

    it('keeps one row per day and edits it on a re-log', async () => {
      if (db === undefined) return;
      const skin = createSkinRepository(db);
      const dayId = newId();
      const faceId = newId();

      const first = await writeDay({
        id: dayId,
        observedOn: '2026-08-24',
        zone: ZONE,
        observedAt: '2026-08-24T02:30:00.000Z',
        overallState: 2,
        regions: [{ id: faceId, region: 'face', state: 2, activeLesionCount: 9 }],
      });
      expect(isOk(first)).toBe(true);

      const stored = await skin.stateForDay('2026-08-24');
      const storedState = unwrap<{ id: string; regions: readonly { id: string }[] }>(
        stored as never,
        'stateForDay',
      );

      // Re-log the same day, with the ids the day already has.
      const second = await writeDay({
        id: storedState.id,
        observedOn: '2026-08-24',
        zone: ZONE,
        observedAt: '2026-08-24T14:30:00.000Z',
        overallState: 4,
        regions: [{ id: storedState.regions[0]?.id ?? faceId, region: 'face', state: 4, activeLesionCount: 5 }],
      });
      expect(isOk(second)).toBe(true);

      const days = await db.$client`select count(*)::int as n from skin_state`;
      expect(days[0]?.['n']).toBe(1);

      const regions = await db.$client`select count(*)::int as n from skin_region_state`;
      expect(regions[0]?.['n']).toBe(1);
    });

    it('supersedes the day’s observations rather than accumulating them', async () => {
      if (db === undefined) return;
      const skin = createSkinRepository(db);
      const dayId = newId();

      await writeDay({
        id: dayId,
        observedOn: '2026-08-24',
        zone: ZONE,
        observedAt: '2026-08-24T02:30:00.000Z',
        overallState: 2,
      });
      await writeDay({
        id: dayId,
        observedOn: '2026-08-24',
        zone: ZONE,
        observedAt: '2026-08-24T14:30:00.000Z',
        overallState: 4,
      });

      const current = await db.$client`
        select value from observation
        where metric_key = 'body.skin.state' and superseded_by_id is null
      `;
      expect(current).toHaveLength(1);
      expect(Number(current[0]?.['value'])).toBe(4);

      // The mistake is still on record — §9.1 keeps it, superseded.
      const all = await db.$client`select count(*)::int as n from observation where metric_key = 'body.skin.state'`;
      expect(all[0]?.['n']).toBe(2);

      const forDay = await skin.observationsForDay('2026-08-24');
      expect(unwrap<readonly unknown[]>(forDay as never, 'observationsForDay')).toHaveLength(1);
    });

    it('replays the product register rather than trusting the cached flag', async () => {
      if (db === undefined) return;
      const skin = createSkinRepository(db);
      const productId = newId();

      await db.$client`
        insert into skincare_product (id, name, brand, is_active)
        values (${productId}::uuid, 'Moisturising Lotion', 'CeraVe', false)
      `;
      await db.$client`
        insert into product_event (id, product_id, kind, occurred_at, zone)
        values (${newId()}::uuid, ${productId}::uuid, 'introduced', '2026-08-01T06:00:00Z', ${ZONE})
      `;

      const changed = await skin.refreshActiveProducts('2026-08-24', ZONE);
      expect(unwrap<number>(changed as never, 'refresh')).toBe(1);

      const products = await skin.products();
      expect(unwrap<readonly { isActive: boolean }[]>(products as never, 'products')[0]?.isActive).toBe(true);

      // Running it again changes nothing.
      const again = await skin.refreshActiveProducts('2026-08-24', ZONE);
      expect(unwrap<number>(again as never, 'refresh')).toBe(0);
    });
  });

  /* ---------------------------------------------------------------------
   * Mind
   * ------------------------------------------------------------------ */

  describe('the journal', () => {
    it('never returns prose in a list, and counts words the same way core does', async () => {
      if (db === undefined) return;
      const mind = createMindRepository(db);
      const content = 'The thing   I have not told\n\nanyone about this week.';

      const planned = planJournalEntry({
        id: newId(),
        writtenAt: '2026-08-24T21:30:00.000Z',
        zone: ZONE,
        content,
      });
      if (!isOk(planned)) throw new Error('plan failed');
      const written = await mind.writeJournalEntry(planned.value);
      expect(isOk(written)).toBe(true);

      const list = await mind.journalList();
      const items = unwrap<readonly { heading: string; wordCount: number }[]>(list as never, 'journalList');

      expect(items).toHaveLength(1);
      expect(JSON.stringify(items)).not.toContain('told');
      /* The SQL count and the TypeScript count must agree, or the same entry
       * reads "10 words" in a list and "9 words" on its own page. */
      expect(items[0]?.wordCount).toBe(journalListItem(planned.value).wordCount);
    });

    it('updates an edited entry rather than discarding the edit', async () => {
      if (db === undefined) return;
      const mind = createMindRepository(db);
      const id = newId();

      const first = planJournalEntry({ id, writtenAt: '2026-08-24T21:30:00.000Z', zone: ZONE, content: 'Short.' });
      const second = planJournalEntry({
        id,
        writtenAt: '2026-08-24T21:30:00.000Z',
        zone: ZONE,
        content: 'Short. And then a paragraph more.',
      });
      if (!isOk(first) || !isOk(second)) throw new Error('plan failed');

      await mind.writeJournalEntry(first.value);
      await mind.writeJournalEntry(second.value);

      const stored = await mind.journalEntryById(id);
      expect(unwrap<{ content: string }>(stored as never, 'byId').content).toBe(
        'Short. And then a paragraph more.',
      );

      const rows = await db.$client`select count(*)::int as n from journal_entry`;
      expect(rows[0]?.['n']).toBe(1);
    });
  });

  describe('anxiety episodes', () => {
    it('writes the row and the observation together, and a replay writes neither again', async () => {
      if (db === undefined) return;
      const mind = createMindRepository(db);
      const planned = planEpisode({
        id: newId(),
        startedAt: '2026-08-24T09:00:00.000Z',
        zone: ZONE,
        intensity: 4,
        trigger: 'deadline',
      });
      if (!isOk(planned)) throw new Error('plan failed');

      const reg = await registry();
      const first = await mind.logEpisode(planned.value, writeContext(reg));
      expect(unwrap<{ written: boolean }>(first as never, 'logEpisode').written).toBe(true);

      const replay = await mind.logEpisode(planned.value, writeContext(reg));
      expect(unwrap<{ written: boolean }>(replay as never, 'replay').written).toBe(false);

      const observations = await db.$client`select count(*)::int as n from observation where metric_key = 'mind.anxiety'`;
      expect(observations[0]?.['n']).toBe(1);
    });

    it('closes idempotently — a replayed close keeps the original end time', async () => {
      if (db === undefined) return;
      const mind = createMindRepository(db);
      const id = newId();
      const planned = planEpisode({ id, startedAt: '2026-08-24T09:00:00.000Z', zone: ZONE });
      if (!isOk(planned)) throw new Error('plan failed');
      await mind.logEpisode(planned.value, writeContext(await registry()));

      await mind.closeEpisode(id, '2026-08-24T09:40:00.000Z');
      const second = await mind.closeEpisode(id, '2026-08-24T11:00:00.000Z');
      const episode = unwrap<{ endedAt: string | null }>(second as never, 'close');

      expect(episode.endedAt).not.toBeNull();
      expect(new Date(episode.endedAt ?? '').toISOString()).toBe('2026-08-24T09:40:00.000Z');
    });

    it('returns null when closing an episode that does not exist', async () => {
      if (db === undefined) return;
      const closed = await createMindRepository(db).closeEpisode(newId(), '2026-08-24T09:40:00.000Z');
      expect(unwrap<unknown>(closed as never, 'close')).toBeNull();
    });
  });

  describe('practices', () => {
    it('writes a duration observation, once', async () => {
      if (db === undefined) return;
      const mind = createMindRepository(db);
      const planned = planPractice({
        id: newId(),
        kind: 'breathwork',
        startedAt: '2026-08-24T05:30:00.000Z',
        zone: ZONE,
        // eslint-disable-next-line @naitikos/no-bare-quantity -- minutes, and the field name and the metric registry both say so (canonicalUnit: 'minutes').
        durationMinutes: 12,
        stateBefore: 2,
        stateAfter: 4,
      });
      if (!isOk(planned)) throw new Error('plan failed');

      const reg = await registry();
      await mind.logPractice(planned.value, writeContext(reg));
      await mind.logPractice(planned.value, writeContext(reg));

      const rows = await db.$client`select count(*)::int as n from observation where metric_key = 'mind.practice.duration'`;
      expect(rows[0]?.['n']).toBe(1);

      const recent = await mind.recentPractices();
      const practices = unwrap<readonly { durationMinutes: number | null }[]>(recent as never, 'recent');
      expect(practices[0]?.durationMinutes).toBe(12);
    });
  });

  /* ---------------------------------------------------------------------
   * The routine engine
   * ------------------------------------------------------------------ */

  describe('the routine engine', () => {
    async function seedRoutine(): Promise<{ routineId: string; stepIds: readonly string[] }> {
      if (db === undefined) throw new Error('no database');
      const routineId = newId();
      const stepIds = [newId(), newId(), newId()];

      await db.$client`
        insert into routine (id, kind, period, name, is_active, expected_at)
        values (${routineId}::uuid, 'skincare', 'pm', 'Evening routine', true, '22:00')
      `;
      for (const [index, id] of stepIds.entries()) {
        await db.$client`
          insert into routine_step (id, routine_id, order_index, label, is_optional)
          values (${id}::uuid, ${routineId}::uuid, ${index}, ${`Step ${String(index + 1)}`}, ${index === 2})
        `;
      }
      return { routineId, stepIds };
    }

    it('records one completion however many times the outbox replays the tap', async () => {
      if (db === undefined) return;
      const routines = createRoutineRepository(db);
      const { routineId, stepIds } = await seedRoutine();
      const stepId = stepIds[0] ?? '';

      for (let attempt = 0; attempt < 3; attempt += 1) {
        // A fresh client id each time — which is exactly what a re-tap sends.
        await routines.logStep({
          id: newId(),
          routineId,
          stepId,
          occurredOn: '2026-08-24',
          completedAt: '2026-08-24T16:30:00.000Z',
          zone: ZONE,
          status: 'done',
        });
      }

      const rows = await db.$client`select count(*)::int as n from routine_log`;
      expect(rows[0]?.['n']).toBe(1);
    });

    it('treats a different status for the same step as a correction', async () => {
      if (db === undefined) return;
      const routines = createRoutineRepository(db);
      const { routineId, stepIds } = await seedRoutine();
      const stepId = stepIds[0] ?? '';

      await routines.logStep({
        id: newId(),
        routineId,
        stepId,
        occurredOn: '2026-08-24',
        completedAt: '2026-08-24T16:30:00.000Z',
        zone: ZONE,
        status: 'done',
      });
      const corrected = await routines.logStep({
        id: newId(),
        routineId,
        stepId,
        occurredOn: '2026-08-24',
        completedAt: null,
        zone: ZONE,
        status: 'skipped',
      });

      expect(unwrap<{ status: string }>(corrected as never, 'logStep').status).toBe('skipped');
      const rows = await db.$client`select count(*)::int as n from routine_log`;
      expect(rows[0]?.['n']).toBe(1);
    });

    it('lets a cleared step be re-tapped', async () => {
      if (db === undefined) return;
      const routines = createRoutineRepository(db);
      const { routineId, stepIds } = await seedRoutine();
      const stepId = stepIds[0] ?? '';

      await routines.logStep({
        id: newId(),
        routineId,
        stepId,
        occurredOn: '2026-08-24',
        completedAt: '2026-08-24T16:30:00.000Z',
        zone: ZONE,
        status: 'done',
      });
      const cleared = await routines.clearStep(routineId, stepId, '2026-08-24');
      expect(unwrap<boolean>(cleared as never, 'clear')).toBe(true);

      const again = await routines.logStep({
        id: newId(),
        routineId,
        stepId,
        occurredOn: '2026-08-24',
        completedAt: '2026-08-24T16:30:00.000Z',
        zone: ZONE,
        status: 'done',
      });
      expect(isOk(again)).toBe(true);
    });

    it('computes adherence over required steps only', async () => {
      if (db === undefined) return;
      const routines = createRoutineRepository(db);
      const { routineId, stepIds } = await seedRoutine();

      for (const stepId of stepIds) {
        await routines.logStep({
          id: newId(),
          routineId,
          stepId,
          occurredOn: '2026-08-24',
          completedAt: '2026-08-24T16:30:00.000Z',
          zone: ZONE,
          status: 'done',
        });
      }

      const routine = unwrap<{ id: string; name: string } | null>(
        (await routines.routineById(routineId)) as never,
        'routineById',
      );
      const steps = unwrap<readonly unknown[]>((await routines.stepsFor([routineId])) as never, 'steps');
      const dayKeys = windowDayKeys('2026-08-24', 7);
      const logs = unwrap<readonly unknown[]>(
        (await routines.logsBetween([routineId], dayKeys[0] ?? '', '2026-08-24')) as never,
        'logs',
      );

      const adherence = routineWindowAdherence(
        routine as never,
        steps as never,
        logs as never,
        dayKeys,
      );

      // Two required steps of three, both done; the optional one is excluded.
      expect(adherence.stepsRequired).toBe(2);
      expect(adherence.stepsCompleted).toBe(2);
      expect(adherence.unrecordedDays).toBe(6);
      expect(adherence.currentStreak).toBe(1);
    });
  });

  /* ---------------------------------------------------------------------
   * Medication
   * ------------------------------------------------------------------ */

  describe('the medication register', () => {
    async function seedMedication(): Promise<{ medicationId: string; scheduleId: string }> {
      if (db === undefined) throw new Error('no database');
      const eventId = newId();
      const medicationId = newId();
      const scheduleId = newId();

      await db.$client`
        insert into medical_event (id, type, valid_from, zone, title)
        values (${eventId}::uuid, 'medication', '2026-02-01T04:00:00Z', ${ZONE}, 'Started Venlafaxine')
      `;
      await db.$client`
        insert into medication (id, medical_event_id, substance, brand_name, form, strength, strength_unit, started_at, is_psychiatric, valid_from)
        values (${medicationId}::uuid, ${eventId}::uuid, 'Venlafaxine', 'Venlafaxine XR', 'capsule', 150, 'mg', '2026-02-01T04:00:00Z', true, '2026-02-01T04:00:00Z')
      `;
      await db.$client`
        insert into medication_schedule (id, medication_id, dose, dose_unit, frequency, times, valid_from)
        values (${scheduleId}::uuid, ${medicationId}::uuid, 150, 'mg', 'daily', '["08:00"]'::jsonb, '2026-02-01T04:00:00Z')
      `;
      return { medicationId, scheduleId };
    }

    it('records one dose however many times the tap is replayed', async () => {
      if (db === undefined) return;
      const medications = createMedicationRepository(db);
      const { medicationId, scheduleId } = await seedMedication();

      const first = await medications.logEvent({
        id: newId(),
        medicationId,
        scheduleId,
        kind: 'taken',
        scheduledFor: '2026-08-24T02:30:00.000Z',
        takenAt: '2026-08-24T02:35:00.000Z',
        zone: ZONE,
      });
      expect(unwrap<{ written: boolean }>(first as never, 'log').written).toBe(true);

      const replay = await medications.logEvent({
        id: newId(),
        medicationId,
        scheduleId,
        kind: 'taken',
        scheduledFor: '2026-08-24T02:30:00.000Z',
        takenAt: '2026-08-24T02:40:00.000Z',
        zone: ZONE,
      });
      expect(unwrap<{ written: boolean }>(replay as never, 'replay').written).toBe(false);

      const rows = await db.$client`select count(*)::int as n from medication_event`;
      expect(rows[0]?.['n']).toBe(1);
    });

    it('treats a changed answer for the same slot as a correction', async () => {
      if (db === undefined) return;
      const medications = createMedicationRepository(db);
      const { medicationId, scheduleId } = await seedMedication();

      await medications.logEvent({
        id: newId(),
        medicationId,
        scheduleId,
        kind: 'taken',
        scheduledFor: '2026-08-24T02:30:00.000Z',
        takenAt: '2026-08-24T02:35:00.000Z',
        zone: ZONE,
      });
      const corrected = await medications.logEvent({
        id: newId(),
        medicationId,
        scheduleId,
        kind: 'skipped',
        scheduledFor: '2026-08-24T02:30:00.000Z',
        takenAt: null,
        zone: ZONE,
      });

      expect(unwrap<{ event: { kind: string } }>(corrected as never, 'correct').event.kind).toBe('skipped');
      const rows = await db.$client`select count(*)::int as n from medication_event`;
      expect(rows[0]?.['n']).toBe(1);
    });

    it('never counts an unrecorded day as a missed dose', async () => {
      if (db === undefined) return;
      const medications = createMedicationRepository(db);
      const { medicationId, scheduleId } = await seedMedication();

      await medications.logEvent({
        id: newId(),
        medicationId,
        scheduleId,
        kind: 'taken',
        scheduledFor: '2026-08-24T02:30:00.000Z',
        takenAt: '2026-08-24T02:35:00.000Z',
        zone: ZONE,
      });

      const dayKeys = windowDayKeys('2026-08-24', 30);
      const medication = unwrap<{ id: string } | null>((await medications.byId(medicationId)) as never, 'byId');
      const schedules = unwrap<readonly unknown[]>((await medications.schedules([medicationId])) as never, 'schedules');
      const events = unwrap<readonly unknown[]>(
        (await medications.eventsBetween('2026-07-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')) as never,
        'events',
      );

      const adherence = windowAdherence(medication as never, schedules as never, events as never, dayKeys, ZONE);

      expect(adherence.recordedDays).toBe(1);
      expect(adherence.unrecordedDays).toBe(29);
      // One dose expected, one taken. The other 29 days are not misses.
      expect(adherence.ratio).toBe(1);
      expect(adherence.sentence).toContain('29 days have no record either way');
    });
  });
});
