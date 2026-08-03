/**
 * Integration tests for the invariants the *database* enforces.
 *
 * Week 1's exit criteria include "CI: lint, typecheck, unit, integration
 * against Postgres" (§12), and these are the integration half. Every assertion
 * below covers a rule that TypeScript cannot express and that a future schema
 * change could silently remove — which is precisely the class of regression
 * that would go unnoticed until the record was already wrong.
 *
 * Requires the local container: `pnpm db:up && pnpm db:migrate`.
 */

import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';

const DATABASE_URL = process.env['DATABASE_URL'];

/**
 * Every test runs inside a transaction that is always rolled back, so the suite
 * leaves the development database exactly as it found it — including the seeded
 * metric registry, which a truncate would destroy.
 *
 * This depends on `max: 1`: with a single connection, BEGIN and ROLLBACK apply
 * to the same session every query uses.
 */
const client = DATABASE_URL === undefined ? undefined : postgres(DATABASE_URL, { max: 1, onnotice: () => undefined });

/** A UUIDv7-shaped constant. Ids are client-generated (§5.7), so literals are fine here. */
const id = (suffix: string): string => `01900000-0000-7000-8000-${suffix.padStart(12, '0')}`;

const SOURCE = id('1');
const OBS_A = id('a1');
const OBS_B = id('b1');
const EVENT = id('e1');
const MED = id('d1');

describe.skipIf(client === undefined)('database invariants', () => {
  const sql = client as postgres.Sql;

  beforeAll(async () => {
    // Confirm migrations have been applied; a confusing "relation does not
    // exist" three tests deep is worse than one clear failure here.
    const [row] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'observation'`;
    if (row?.count !== 1) {
      throw new Error('Schema not migrated. Run `pnpm db:up && pnpm db:migrate` first.');
    }
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await sql.unsafe('BEGIN');
    await sql`INSERT INTO observation_source (id, kind, identifier) VALUES (${SOURCE}, 'manual', 'test')`;
    await sql`
      INSERT INTO metric (key, domain, display_name, description, value_type, canonical_unit, aggregation)
      VALUES ('test.metric', 'system', 'Test', 'Fixture metric.', 'numeric', 'kg', 'mean')
      ON CONFLICT (key) DO NOTHING`;
  });

  afterEach(async () => {
    await sql.unsafe('ROLLBACK');
  });

  /** Insert a plain observation and return its id. */
  async function insertObservation(observationId: string, value: string): Promise<void> {
    await sql`
      INSERT INTO observation (id, metric_key, value, unit, observed_at, observed_zone, source_id, hlc)
      VALUES (${observationId}, 'test.metric', ${value}, 'kg', now(), 'Asia/Kolkata', ${SOURCE}, 'hlc-1')`;
  }

  /* =====================================================================
   * §9.1 — observations are append-only
   * ================================================================== */
  describe('observation append-only (§9.1)', () => {
    it('rejects an UPDATE to a recorded value', async () => {
      await insertObservation(OBS_A, '74.2');

      await expect(
        sql`UPDATE observation SET value = 99.9 WHERE id = ${OBS_A}`,
      ).rejects.toThrow(/append-only/);
    });

    it('rejects a DELETE', async () => {
      await insertObservation(OBS_A, '74.2');

      await expect(sql`DELETE FROM observation WHERE id = ${OBS_A}`).rejects.toThrow(
        /may never be deleted/,
      );
    });

    it('permits supersession, and keeps both rows', async () => {
      await insertObservation(OBS_A, '74.2');
      await insertObservation(OBS_B, '74.5');

      await sql`
        UPDATE observation
           SET superseded_by_id = ${OBS_B}, superseded_at = now(), supersede_reason = 'typo'
         WHERE id = ${OBS_A}`;

      const rows = await sql<{ value: string; superseded: boolean }[]>`
        SELECT value, superseded_by_id IS NOT NULL AS superseded
          FROM observation WHERE id IN (${OBS_A}, ${OBS_B}) ORDER BY value`;

      // §9.1: "a new observation marks the old one superseded, both persist".
      expect(rows).toHaveLength(2);
      expect(rows[0]?.superseded).toBe(true);
      expect(rows[1]?.superseded).toBe(false);
    });

    it('rejects re-pointing an existing supersession', async () => {
      await insertObservation(OBS_A, '74.2');
      await insertObservation(OBS_B, '74.5');
      await sql`
        UPDATE observation SET superseded_by_id = ${OBS_B}, superseded_at = now() WHERE id = ${OBS_A}`;

      await expect(
        sql`UPDATE observation SET superseded_by_id = ${SOURCE} WHERE id = ${OBS_A}`,
      ).rejects.toThrow(/write-once/);
    });
  });

  /* =====================================================================
   * §9.3 — every observation names a registered metric and a source
   * ================================================================== */
  describe('substrate referential rules (§9.3)', () => {
    it('rejects an unregistered metric key', async () => {
      // §9.2: "Unregistered metric keys are rejected on write." No free-floating numbers.
      await expect(
        sql`
          INSERT INTO observation (id, metric_key, value, unit, observed_at, observed_zone, source_id, hlc)
          VALUES (${OBS_A}, 'not.registered', 1.5, 'kg', now(), 'Asia/Kolkata', ${SOURCE}, 'h')`,
      ).rejects.toThrow(/foreign key|violates/i);
    });

    it('rejects a half-specified polymorphic subject', async () => {
      await expect(
        sql`
          INSERT INTO observation (id, metric_key, value, unit, observed_at, observed_zone, source_id, hlc, subject_type)
          VALUES (${OBS_A}, 'test.metric', 1.5, 'kg', now(), 'Asia/Kolkata', ${SOURCE}, 'h', 'workout_set')`,
      ).rejects.toThrow(/observation_subject_paired/);
    });
  });

  /* =====================================================================
   * §5.3 — numerics survive the round trip
   * ================================================================== */
  describe('numeric precision (§5.3)', () => {
    it('preserves a value that binary floating point would corrupt', async () => {
      // 0.1 + 0.2 is the canonical float failure. §5.3: "A rounding artifact in
      // a medication dosage is unacceptable."
      await insertObservation(OBS_A, '0.300000');

      const [row] = await sql<{ value: string }[]>`SELECT value FROM observation WHERE id = ${OBS_A}`;

      // A string, not a number — the driver is configured not to parse numerics.
      expect(row?.value).toBe('0.300000');
      expect(typeof row?.value).toBe('string');
    });
  });

  /* =====================================================================
   * §9.6 — no two believed schedules for one medication overlap
   * ================================================================== */
  describe('medication schedule exclusion (§9.6)', () => {
    beforeEach(async () => {
      await sql`
        INSERT INTO medical_event (id, type, title, valid_from)
        VALUES (${EVENT}, 'medication', 'Test medication', '2026-01-01T00:00:00Z')`;
      await sql`
        INSERT INTO medication (id, medical_event_id, substance, form, valid_from)
        VALUES (${MED}, ${EVENT}, 'Testosubstance', 'tablet', '2026-01-01T00:00:00Z')`;
    });

    async function insertSchedule(
      scheduleId: string,
      dose: number,
      from: string,
      to: string | null,
      recordedTo: string | null = null,
    ): Promise<void> {
      await sql`
        INSERT INTO medication_schedule
          (id, medication_id, dose, dose_unit, frequency, valid_from, valid_to, recorded_to)
        VALUES (${scheduleId}, ${MED}, ${dose}, 'mg', 'daily', ${from}, ${to}, ${recordedTo})`;
    }

    it('permits consecutive, non-overlapping schedules', async () => {
      // The dose change §9.2 requires: "a new schedule rather than an edit that
      // erases the old dose". This is the case a unique index would wrongly reject.
      await insertSchedule(id('21'), 75, '2026-01-01T00:00:00Z', '2026-06-01T00:00:00Z');
      await insertSchedule(id('22'), 150, '2026-06-01T00:00:00Z', null);

      const [row] = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM medication_schedule WHERE medication_id = ${MED}`;
      expect(row?.count).toBe(2);
    });

    it('rejects overlapping validity intervals', async () => {
      await insertSchedule(id('21'), 75, '2026-01-01T00:00:00Z', '2026-06-01T00:00:00Z');

      await expect(
        insertSchedule(id('23'), 225, '2026-03-01T00:00:00Z', '2026-09-01T00:00:00Z'),
      ).rejects.toThrow(/medication_schedule_no_overlap/);
    });

    it('permits an overlap once the earlier row is superseded', async () => {
      // §9.5 transaction time: a correction and the row it corrects legitimately
      // cover the same valid time. Only what is currently believed must not overlap.
      await insertSchedule(id('21'), 75, '2026-01-01T00:00:00Z', '2026-06-01T00:00:00Z');
      await insertSchedule(
        id('24'),
        225,
        '2026-03-01T00:00:00Z',
        '2026-09-01T00:00:00Z',
        '2026-08-01T00:00:00Z',
      );

      const [row] = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM medication_schedule
         WHERE medication_id = ${MED} AND recorded_to IS NULL`;
      expect(row?.count).toBe(1);
    });
  });

  /* =====================================================================
   * §4.7 / §10.10 — the Mind module's structural privacy guards
   * ================================================================== */
  describe('Mind privacy guards (§4.7)', () => {
    it('pins the crisis plan outside every AI consent scope', async () => {
      // §4.7: the plan is shown back to the user, never sent anywhere. The
      // constraint makes that structural rather than a promise.
      await expect(
        sql`
          INSERT INTO crisis_plan (id, warning_signs, ai_consent)
          VALUES (${id('31')}, 'test', 'clinical')`,
      ).rejects.toThrow(/crisis_plan_never_shared_with_ai/);
    });

    it('refuses a journal entry in a broad consent scope', async () => {
      // §4.7 classifies journal content as the most sensitive data in the
      // system; only `none` or `journal` are permitted.
      await expect(
        sql`
          INSERT INTO journal_entry (id, written_at, zone, content, ai_consent)
          VALUES (${id('32')}, now(), 'Asia/Kolkata', 'private', 'clinical')`,
      ).rejects.toThrow(/journal_entry_consent_restricted/);
    });

    it('refuses a model-generated therapy session', async () => {
      // §4.7: "Content is user-authored only; nothing here is ever model-generated."
      await expect(
        sql`
          INSERT INTO therapy_session (id, occurred_at, zone, is_model_generated)
          VALUES (${id('33')}, now(), 'Asia/Kolkata', true)`,
      ).rejects.toThrow(/therapy_session_user_authored/);
    });
  });

  /* =====================================================================
   * §5.5 — sensitive media cannot be stored unencrypted
   * ================================================================== */
  describe('media encryption guard (§5.5)', () => {
    it('rejects a sensitive-tier object with no wrapped key', async () => {
      await expect(
        sql`
          INSERT INTO media_object (id, kind, tier, storage_key, mime_type)
          VALUES (${id('41')}, 'image', 'sensitive', 'skin/2026-08-03.enc', 'image/jpeg')`,
      ).rejects.toThrow(/media_object_sensitive_encrypted/);
    });

    it('accepts a sensitive-tier object that carries one', async () => {
      await sql`
        INSERT INTO media_object (id, kind, tier, storage_key, mime_type, wrapped_key)
        VALUES (${id('42')}, 'image', 'sensitive', 'skin/2026-08-03.enc', 'image/jpeg', 'wrapped')`;

      const [row] = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM media_object WHERE id = ${id('42')}`;
      expect(row?.count).toBe(1);
    });
  });

  /* =====================================================================
   * §9.2 — the profile is a singleton (C1)
   * ================================================================== */
  describe('profile singleton (C1)', () => {
    it('refuses a second profile row', async () => {
      await sql`INSERT INTO profile (id, display_name) VALUES (${id('51')}, 'First')`;

      await expect(
        sql`INSERT INTO profile (id, display_name) VALUES (${id('52')}, 'Second')`,
      ).rejects.toThrow(/profile_singleton_unique/);
    });
  });
});
