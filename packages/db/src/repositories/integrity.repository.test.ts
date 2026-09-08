/**
 * §5.16's data-integrity assertions — integration, against real Postgres.
 *
 * Every test here does the same two things, because an assertion is only worth
 * having if both hold: it **constructs a genuine violation** and confirms the
 * reader finds it, then confirms the reader is silent about a row of the same
 * shape that is *correct*. The second half is the one that matters most. An
 * assertion that fires on healthy data is worse than no assertion — §5.16's own
 * framing is that an alert which cries wolf once gets muted, and a muted
 * integrity check is exactly the silence "otherwise discovered years later"
 * describes.
 *
 * ## Constructing the violations requires writing bad rows on purpose
 *
 * There is no application path to an observation dated in 2031 or a medication
 * that stopped before it started — which is the point of the assertions and the
 * reason a test has to reach past the repositories to make one. Every fixture
 * below is a raw insert, and each one is a row the rest of the system would
 * refuse to produce.
 *
 * ## Why this suite does not call `resetDomainTables`
 *
 * It shares one local database with every other integration suite, and this
 * reader is the only one in the repository whose queries are **unfiltered** —
 * it deliberately looks at every row in `observation`, `medication` and the
 * clinical subtypes, including rows another suite is in the middle of writing.
 * Asserting `violations.length === 0` would therefore be asserting something
 * about a neighbour's fixtures, and clearing the tables to make it true would
 * pull the floor out from under a suite running concurrently.
 *
 * So the assertions are made about **this suite's own ids**: the violation it
 * planted is present, and the healthy row it planted is absent. That is a
 * strictly stronger statement than a global count — it survives a neighbour and
 * it names the row — and it is what `afterEach` cleans up.
 *
 * Clearing `observation` needs migration 0001's trigger disabled, which
 * `testing/reset.ts` documents as the only legitimate use: "this is the only
 * code in the repository that does it, and it is test-only". This is the second,
 * for the same reason and over its own rows only.
 */

import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { uuidV7 } from '@naitikos/shared';

import { createDatabase } from '../client';
import type { IntegrityAssertion, IntegrityReport } from './integrity.repository';
import {
  INTEGRITY_ASSERTIONS,
  INTEGRITY_ROW_ID_CAP,
  OBSERVATION_FUTURE_GRACE_SECONDS,
  createIntegrityReader,
  summariseIntegrity,
} from './integrity.repository';

const DATABASE_URL = process.env['DATABASE_URL'];
const db = DATABASE_URL === undefined ? undefined : createDatabase(DATABASE_URL);
const suite = db === undefined ? describe.skip : describe;

/** The seeded provenance row. §9.3(2) makes `source_id` non-null, so every fixture needs one. */
const MANUAL_SOURCE = 'manual';

const ZONE = 'Asia/Kolkata';

/**
 * A fixed epoch, so every id in this file is deterministic — §11.3's rule
 * applied to identity as well as to time.
 */
const EPOCH = 1_757_000_000_000;
let sequence = 0;
const newId = (): string => uuidV7(EPOCH + (sequence += 1));

/**
 * `nowIso` for the reader, and the anchor every fixture is dated relative to.
 *
 * A literal rather than the clock, because `assert` takes the instant as an
 * argument precisely so a test can name it. Nothing here depends on the real
 * time of day, so nothing here can fail at midnight.
 */
const NOW = '2026-09-08T12:00:00.000Z';

function unwrap(result: { ok: true; value: IntegrityReport } | { ok: false; error: { message: string } }): IntegrityReport {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

suite('data-integrity assertions (§5.16)', () => {
  /* `describe.skip` has established that `db` exists; TypeScript cannot see
   * through it, so it is narrowed once rather than at each call site. */
  if (db === undefined) throw new Error('no database');
  const database = db;
  const client = database.$client;
  const integrity = createIntegrityReader(database);

  /** Ids planted by the test that is running, cleared afterwards. */
  const plantedObservations: string[] = [];
  const plantedEvents: string[] = [];
  const plantedMeals: string[] = [];
  const plantedOutbox: string[] = [];

  async function sourceId(): Promise<string> {
    const rows = await client<{ id: string }[]>`
      select id from observation_source where identifier = ${MANUAL_SOURCE} limit 1
    `;
    const row = rows[0];
    if (row === undefined) throw new Error('the seeded manual observation source is missing');
    return row.id;
  }

  /**
   * One raw observation.
   *
   * Raw rather than through `observation.repository.ts`, because half of these
   * are rows that repository exists to prevent. `hlc` is a plain string: §5.7's
   * causal ordering is not what is under test, and a real HLC here would imply
   * it was.
   */
  async function plantObservation(input: {
    readonly id: string;
    readonly metricKey?: string;
    readonly observedAt?: string;
    readonly subjectType?: string | null;
    readonly subjectId?: string | null;
    readonly supersededById?: string | null;
  }): Promise<string> {
    const source = await sourceId();
    plantedObservations.push(input.id);
    await client`
      insert into observation
        (id, metric_key, value, unit, observed_at, observed_zone, source_id, hlc,
         subject_type, subject_id, superseded_by_id, superseded_at)
      values
        (${input.id}, ${input.metricKey ?? 'body.weight'}, 74.2, 'kg',
         ${input.observedAt ?? '2026-09-01T06:00:00.000Z'}, ${ZONE}, ${source},
         ${`hlc-${input.id}`},
         ${input.subjectType ?? null}, ${input.subjectId ?? null},
         ${input.supersededById ?? null},
         ${input.supersededById === undefined || input.supersededById === null ? null : NOW})
    `;
    return input.id;
  }

  /** A clinical supertype row, optionally tombstoned (§9.4). */
  async function plantMedicalEvent(input: {
    readonly id: string;
    readonly deleted?: boolean;
  }): Promise<string> {
    plantedEvents.push(input.id);
    await client`
      insert into medical_event (id, type, title, valid_from, zone, deleted_at)
      values (${input.id}, 'medication', 'integrity fixture', '2026-01-01T00:00:00.000Z', ${ZONE},
              ${input.deleted === true ? NOW : null})
    `;
    return input.id;
  }

  afterEach(async () => {
    if (plantedObservations.length > 0) {
      /* §9.1's trigger forbids DELETE. Disabled for the delete and re-enabled
       * immediately, exactly as `testing/reset.ts` does — and scoped to this
       * suite's ids, so a concurrent suite's log is untouched either way. */
      await client`alter table observation disable trigger observation_append_only`;
      await client`delete from observation where id = any(${client.array(plantedObservations)}::uuid[])`;
      await client`alter table observation enable trigger observation_append_only`;
      plantedObservations.length = 0;
    }
    if (plantedOutbox.length > 0) {
      await client`delete from upload_outbox where id = any(${client.array(plantedOutbox)}::uuid[])`;
      plantedOutbox.length = 0;
    }
    if (plantedEvents.length > 0) {
      /* Subtypes first — `medical_event` is the supertype every one of them
       * carries a foreign key to (§9.3). */
      await client`delete from medication where medical_event_id = any(${client.array(plantedEvents)}::uuid[])`;
      await client`delete from condition where medical_event_id = any(${client.array(plantedEvents)}::uuid[])`;
      await client`delete from medical_event where id = any(${client.array(plantedEvents)}::uuid[])`;
      plantedEvents.length = 0;
    }
    if (plantedMeals.length > 0) {
      await client`delete from meal where id = any(${client.array(plantedMeals)}::uuid[])`;
      plantedMeals.length = 0;
    }
  });

  afterAll(async () => {
    await client.end({ timeout: 5 });
  });

  /** Rows this suite planted, reported under one assertion. */
  function flagged(report: IntegrityReport, assertion: IntegrityAssertion): readonly string[] {
    return report.violations
      .filter((violation) => violation.assertion === assertion)
      .flatMap((violation) => violation.rowIds);
  }

  describe('no observation dated in the future', () => {
    it('flags a reading dated beyond the grace window', async () => {
      const future = await plantObservation({
        id: newId(),
        observedAt: '2031-04-01T06:00:00.000Z',
      });

      const report = unwrap(await integrity.assert(NOW));

      expect(flagged(report, 'observation.future_dated')).toContain(future);
    });

    it('leaves a past reading and a slightly fast clock alone', async () => {
      const past = await plantObservation({ id: newId(), observedAt: '2026-09-01T06:00:00.000Z' });
      /*
       * Inside {@link OBSERVATION_FUTURE_GRACE_SECONDS}. §5.7 timestamps a
       * capture on the handset, so a phone a minute ahead of NTP is ordinary
       * and must not be reported as corruption — this is the row that would
       * make the assertion cry wolf.
       */
      const slightlyAhead = await plantObservation({
        id: newId(),
        observedAt: '2026-09-08T12:01:00.000Z',
      });

      const report = unwrap(await integrity.assert(NOW));
      const found = flagged(report, 'observation.future_dated');

      expect(found).not.toContain(past);
      expect(found).not.toContain(slightlyAhead);
    });
  });

  describe("§9.3(3)'s polymorphic subject, which no foreign key can police", () => {
    it('flags an observation whose subject row does not exist', async () => {
      const orphan = await plantObservation({
        id: newId(),
        subjectType: 'meal',
        subjectId: newId(),
      });

      const report = unwrap(await integrity.assert(NOW));

      expect(flagged(report, 'observation.orphaned_subject')).toContain(orphan);
      /* The table is named, not merely the assertion: "somewhere in nine
       * tables" is not something an operator can act on. */
      expect(
        report.violations.some(
          (violation) => violation.assertion === 'observation.orphaned_subject' && violation.table === 'meal',
        ),
      ).toBe(true);
    });

    it('leaves an observation whose subject exists alone', async () => {
      const meal = newId();
      plantedMeals.push(meal);
      await client`insert into meal (id, eaten_at, zone) values (${meal}, ${NOW}, ${ZONE})`;

      const attached = await plantObservation({
        id: newId(),
        subjectType: 'meal',
        subjectId: meal,
      });

      const report = unwrap(await integrity.assert(NOW));

      expect(flagged(report, 'observation.orphaned_subject')).not.toContain(attached);
    });

    it('flags a subject type this reader has never heard of, and names it', async () => {
      const unknown = await plantObservation({
        id: newId(),
        subjectType: 'protocol_photo_series',
        subjectId: newId(),
      });

      const report = unwrap(await integrity.assert(NOW));
      const violation = report.violations.find(
        (candidate) => candidate.assertion === 'observation.unknown_subject_type',
      );

      expect(flagged(report, 'observation.unknown_subject_type')).toContain(unknown);
      /* The vocabulary token, so the fix — extend the map — is legible from the
       * log line without opening psql. */
      expect(violation?.detail).toContain('protocol_photo_series');
    });

    it('leaves `vital_reading` alone, which names no table on purpose', async () => {
      /*
       * The carve-out that keeps every blood pressure the system has ever taken
       * out of the report. `health/vitals.ts` uses the subject to bind a
       * systolic to its diastolic; there is no `vital_reading` table and there
       * is not meant to be. If this test fails, the reader is reporting the
       * whole of §4.4's vitals history as corruption.
       */
      const systolic = await plantObservation({
        id: newId(),
        metricKey: 'body.vitals.bp_systolic',
        subjectType: 'vital_reading',
        subjectId: newId(),
      });

      const report = unwrap(await integrity.assert(NOW));

      expect(flagged(report, 'observation.orphaned_subject')).not.toContain(systolic);
      expect(flagged(report, 'observation.unknown_subject_type')).not.toContain(systolic);
    });
  });

  describe("§9.1's correction chain", () => {
    it('flags a pointer at an observation that does not exist', async () => {
      const dangling = await plantObservation({ id: newId(), supersededById: newId() });

      const report = unwrap(await integrity.assert(NOW));

      expect(flagged(report, 'observation.supersession_dangling')).toContain(dangling);
    });

    it('flags a correction that changed the metric', async () => {
      const successor = newId();
      const corrected = await plantObservation({
        id: newId(),
        metricKey: 'body.weight',
        supersededById: successor,
      });
      await plantObservation({ id: successor, metricKey: 'mind.mood' });

      const report = unwrap(await integrity.assert(NOW));

      expect(flagged(report, 'observation.supersession_cross_metric')).toContain(corrected);
    });

    it('leaves a well-formed correction alone', async () => {
      const successor = newId();
      const corrected = await plantObservation({
        id: newId(),
        metricKey: 'body.weight',
        supersededById: successor,
      });
      await plantObservation({ id: successor, metricKey: 'body.weight' });

      const report = unwrap(await integrity.assert(NOW));

      expect(flagged(report, 'observation.supersession_dangling')).not.toContain(corrected);
      expect(flagged(report, 'observation.supersession_cross_metric')).not.toContain(corrected);
      expect(flagged(report, 'observation.supersession_cycle')).not.toContain(corrected);
      expect(flagged(report, 'observation.supersession_fan_in')).not.toContain(successor);
    });

    it('flags one successor standing in for two readings', async () => {
      const successor = newId();
      await plantObservation({ id: successor });
      await plantObservation({ id: newId(), supersededById: successor });
      await plantObservation({ id: newId(), supersededById: successor });

      const report = unwrap(await integrity.assert(NOW));

      /* The contested successor is what is reported — the row to look at
       * first, since one of the two readings behind it has been retracted with
       * no replacement. */
      expect(flagged(report, 'observation.supersession_fan_in')).toContain(successor);
    });

    it('flags a two-row cycle, which every constraint on the table permits', async () => {
      /*
       * `observation_no_self_supersede` rules out a one-row cycle and nothing
       * rules out this one: each row is named exactly once, so fan-in is
       * satisfied too. Both readings then vanish from every current-only read
       * — including the one every trend chart goes through — while remaining
       * perfectly present in the table.
       */
      const first = newId();
      const second = newId();
      await plantObservation({ id: first, supersededById: second });
      await plantObservation({ id: second, supersededById: first });

      const report = unwrap(await integrity.assert(NOW));
      const cycle = flagged(report, 'observation.supersession_cycle');

      expect(cycle).toContain(first);
      expect(cycle).toContain(second);
    });
  });

  describe('no medication with an end date before its start', () => {
    it('flags a reversed course', async () => {
      const event = await plantMedicalEvent({ id: newId() });
      const reversed = newId();
      await client`
        insert into medication (id, medical_event_id, substance, form, valid_from, started_at, stopped_at, stop_reason)
        values (${reversed}, ${event}, 'Integrity Fixture', 'tablet', '2026-03-01T00:00:00.000Z',
                '2026-03-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z', 'course_completed')
      `;

      const report = unwrap(await integrity.assert(NOW));

      expect(flagged(report, 'medication.stopped_before_started')).toContain(reversed);
    });

    it('leaves an ordered course, and an open-ended one, alone', async () => {
      const event = await plantMedicalEvent({ id: newId() });
      const ordered = newId();
      const openEnded = newId();
      await client`
        insert into medication (id, medical_event_id, substance, form, valid_from, started_at, stopped_at, stop_reason)
        values (${ordered}, ${event}, 'Integrity Fixture', 'tablet', '2026-02-01T00:00:00.000Z',
                '2026-02-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z', 'course_completed')
      `;
      /* Still being taken. `stopped_at IS NULL` must never be read as "stopped
       * at the beginning of time", which is the failure a naive comparison has. */
      await client`
        insert into medication (id, medical_event_id, substance, form, valid_from, started_at)
        values (${openEnded}, ${event}, 'Integrity Fixture', 'tablet', '2026-02-01T00:00:00.000Z',
                '2026-02-01T00:00:00.000Z')
      `;

      const report = unwrap(await integrity.assert(NOW));
      const found = flagged(report, 'medication.stopped_before_started');

      expect(found).not.toContain(ordered);
      expect(found).not.toContain(openEnded);
    });
  });

  describe("§9.4's tombstones across §9.3's supertype", () => {
    it('flags a live subtype under a deleted clinical event', async () => {
      const event = await plantMedicalEvent({ id: newId(), deleted: true });
      const stranded = newId();
      await client`
        insert into condition (id, medical_event_id, name, valid_from)
        values (${stranded}, ${event}, 'Integrity Fixture', '2026-01-01T00:00:00.000Z')
      `;

      const report = unwrap(await integrity.assert(NOW));
      const violation = report.violations.find(
        (candidate) =>
          candidate.assertion === 'clinical.orphaned_by_tombstone' && candidate.table === 'condition',
      );

      expect(violation?.rowIds).toContain(stranded);
    });

    it('leaves a subtype alone when both halves agree', async () => {
      const live = await plantMedicalEvent({ id: newId() });
      const tombstoned = await plantMedicalEvent({ id: newId(), deleted: true });
      const bothLive = newId();
      const bothDeleted = newId();
      await client`
        insert into condition (id, medical_event_id, name, valid_from)
        values (${bothLive}, ${live}, 'Integrity Fixture', '2026-01-01T00:00:00.000Z')
      `;
      await client`
        insert into condition (id, medical_event_id, name, valid_from, deleted_at)
        values (${bothDeleted}, ${tombstoned}, 'Integrity Fixture', '2026-01-01T00:00:00.000Z', ${NOW})
      `;

      const report = unwrap(await integrity.assert(NOW));
      const found = flagged(report, 'clinical.orphaned_by_tombstone');

      expect(found).not.toContain(bothLive);
      expect(found).not.toContain(bothDeleted);
    });
  });

  describe("§9.5's transaction axis", () => {
    it('flags two believed rows for one fact whose validity intervals intersect', async () => {
      const event = await plantMedicalEvent({ id: newId() });
      const first = newId();
      const second = newId();
      await client`
        insert into medication (id, medical_event_id, substance, form, valid_from, valid_to)
        values (${first}, ${event}, 'Integrity Fixture', 'tablet',
                '2026-02-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z')
      `;
      await client`
        insert into medication (id, medical_event_id, substance, form, valid_from, valid_to)
        values (${second}, ${event}, 'Integrity Fixture', 'tablet',
                '2026-03-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z')
      `;

      const report = unwrap(await integrity.assert(NOW));
      const violation = report.violations.find(
        (candidate) =>
          candidate.assertion === 'clinical.believed_interval_overlap' && candidate.table === 'medication',
      );

      /* One id per pair, not two — `a.id < b.id` in the query. Either end of
       * the pair leads to the other. */
      expect(violation?.rowIds.some((id) => id === first || id === second)).toBe(true);
    });

    it('leaves adjacent believed intervals alone, which are the history the schema keeps', async () => {
      /*
       * 75mg then 150mg. `medication_schedule`'s own schema comment defends
       * this shape at length — a rule that rejected the second row "forbids the
       * history this table exists to keep" — so the assertion tests for
       * intersection and not for multiplicity. Half-open `[)`, so the shared
       * boundary instant belongs to exactly one of them.
       */
      const event = await plantMedicalEvent({ id: newId() });
      const earlier = newId();
      const later = newId();
      await client`
        insert into medication (id, medical_event_id, substance, form, valid_from, valid_to)
        values (${earlier}, ${event}, 'Integrity Fixture', 'tablet',
                '2026-02-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z')
      `;
      await client`
        insert into medication (id, medical_event_id, substance, form, valid_from)
        values (${later}, ${event}, 'Integrity Fixture', 'tablet', '2026-03-01T00:00:00.000Z')
      `;

      const report = unwrap(await integrity.assert(NOW));
      const found = flagged(report, 'clinical.believed_interval_overlap');

      expect(found).not.toContain(earlier);
      expect(found).not.toContain(later);
    });

    it('leaves a superseded belief alone — a closed `recorded_to` is not a second answer', async () => {
      const event = await plantMedicalEvent({ id: newId() });
      const corrected = newId();
      const current = newId();
      /* §9.5: "a row is superseded by closing `recordedTo` and inserting a
       * successor". The intervals overlap; only one of the two is believed, so
       * "as known on date X" still has exactly one answer. */
      await client`
        insert into medication (id, medical_event_id, substance, form, valid_from, recorded_to)
        values (${corrected}, ${event}, 'Integrity Fixture', 'tablet',
                '2026-02-01T00:00:00.000Z', ${NOW})
      `;
      await client`
        insert into medication (id, medical_event_id, substance, form, valid_from)
        values (${current}, ${event}, 'Integrity Fixture', 'tablet', '2026-02-15T00:00:00.000Z')
      `;

      const report = unwrap(await integrity.assert(NOW));
      const found = flagged(report, 'clinical.believed_interval_overlap');

      expect(found).not.toContain(corrected);
      expect(found).not.toContain(current);
    });
  });

  describe("§5.7's outbox reaching `uploaded` with nothing in it", () => {
    it('flags a terminal row with no media object', async () => {
      const stranded = newId();
      plantedOutbox.push(stranded);
      await client`
        insert into upload_outbox (id, idempotency_key, storage_key, tier, content_type, status)
        values (${stranded}, ${`integrity-${stranded}`}, ${`sensitive/${stranded}`},
                'sensitive', 'image/jpeg', 'uploaded')
      `;

      const report = unwrap(await integrity.assert(NOW));

      expect(flagged(report, 'upload_outbox.uploaded_without_object')).toContain(stranded);
    });

    it('leaves a pending row alone, which has no object yet by definition', async () => {
      const pending = newId();
      plantedOutbox.push(pending);
      await client`
        insert into upload_outbox (id, idempotency_key, storage_key, tier, content_type, status)
        values (${pending}, ${`integrity-${pending}`}, ${`sensitive/${pending}`},
                'sensitive', 'image/jpeg', 'pending')
      `;

      const report = unwrap(await integrity.assert(NOW));

      expect(flagged(report, 'upload_outbox.uploaded_without_object')).not.toContain(pending);
    });
  });

  describe('the report itself', () => {
    it('runs every assertion on a clean pass, so a silent one is distinguishable from a passing one', async () => {
      const report = unwrap(await integrity.assert(NOW));

      /*
       * Nine subject types and eight clinical subtypes each get their own
       * query, so the count is larger than the assertion vocabulary. It is
       * asserted at all because `assertionsRun: 0` and "no violations" would
       * otherwise be the same report — which is the failure §5.16 exists to
       * prevent, one level up.
       */
      expect(report.assertionsRun).toBeGreaterThanOrEqual(INTEGRITY_ASSERTIONS.length);
      expect(report.rowsFlagged).toBe(
        report.violations.reduce((total, violation) => total + violation.rowIds.length, 0),
      );
    });

    it('caps the ids it carries back', async () => {
      /*
       * §5.11 holds "event names and numeric measurements only", and the note
       * lands in `job_run.steps`, which is never pruned. The cap is what keeps
       * an unbounded list of ids out of a permanent record — so it is asserted
       * over a violation with more rows than the cap.
       */
      const successor = newId();
      await plantObservation({ id: successor });
      for (let i = 0; i < INTEGRITY_ROW_ID_CAP + 2; i += 1) {
        await plantObservation({ id: newId(), observedAt: '2031-04-01T06:00:00.000Z' });
      }

      const report = unwrap(await integrity.assert(NOW));
      const violation = report.violations.find(
        (candidate) => candidate.assertion === 'observation.future_dated',
      );

      expect(violation?.rowIds.length).toBe(INTEGRITY_ROW_ID_CAP);
      expect(violation?.truncated).toBe(true);
    });
  });
});

/**
 * The note formatter, tested without Postgres because it needs none.
 *
 * It is here rather than in a separate file because it is this reader's output
 * shape, and the bound it enforces is the reason it exists: `clampNote` would
 * otherwise truncate mid-identifier, and half an assertion name is a name
 * nobody can grep for.
 */
describe('summariseIntegrity', () => {
  it('says how many assertions ran when nothing is wrong', () => {
    expect(summariseIntegrity({ violations: [], assertionsRun: 28, rowsFlagged: 0 })).toBe(
      '28 assertions, no violations',
    );
  });

  it('leads with the assertion carrying the most rows, and counts the rest', () => {
    const violations = INTEGRITY_ASSERTIONS.map((assertion, index) => ({
      assertion,
      table: 'observation',
      rowIds: Array.from({ length: index + 1 }, (_unused, row) => `row-${String(index)}-${String(row)}`),
      truncated: false,
    }));
    const rowsFlagged = violations.reduce((total, violation) => total + violation.rowIds.length, 0);

    const note = summariseIntegrity({ violations, assertionsRun: 28, rowsFlagged });

    expect(note).toContain('upload_outbox.uploaded_without_object ×11');
    expect(note).toContain('+8 more');
    /* The bound the function exists for. `JOB_STEP_NOTE_MAX_CHARS` is 200, and
     * the worst case is every assertion firing at once — which is this. */
    expect(note.length).toBeLessThanOrEqual(200);
  });

  it('is silent about the grace window it does not own', () => {
    /* A guard on the constant rather than on the note: the tolerance is a
     * documented five minutes, and a future edit widening it to a day would
     * quietly stop catching the timezone-applied-twice bug. */
    expect(OBSERVATION_FUTURE_GRACE_SECONDS).toBeLessThanOrEqual(600);
  });
});
