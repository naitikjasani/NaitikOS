/**
 * Health core and the document vault — integration, against real Postgres.
 *
 * The core tests cover what these things *mean*. This covers what only a
 * database can answer, and one thing more: **§12's clinical loop, end to end**.
 *
 *   "Vitamin D tracking as the first end-to-end clinical loop, from lab PDF to
 *    trend to consultation question."
 *
 * That loop crosses five layers and four tables, and every one of them looks
 * correct in isolation. The failure this file exists to catch is the recurring
 * one in this codebase: a step that is declared, typed, and never executed
 * reads exactly like a step that works. So the last test walks the whole thing
 * — text in, question out — and asserts the number in the question is the
 * number on the page.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { isOk, uuidV7 } from '@naitikos/shared';
import type { MetricRegistry } from '@naitikos/core';
import {
  analyteBySlug,
  confirmCandidates,
  deriveQuestions,
  describeRange,
  effectiveFlag,
  formatMeasured,
  initialHlcState,
  labMetricKey,
  pairReadings,
  parseLabReport,
  planSymptom,
  planVitalReading,
} from '@naitikos/core';

import { createDatabase } from '../client';
import { resetDomainTables } from '../testing/reset';
import { createHealthRepository } from './health.repository';
import { createLabRepository } from './lab.repository';
import { createMetricRepository } from './metric.repository';

const DATABASE_URL = process.env['DATABASE_URL'];
const db = DATABASE_URL === undefined ? undefined : createDatabase(DATABASE_URL);
const suite = db === undefined ? describe.skip : describe;

afterAll(async () => {
  await db?.$client.end({ timeout: 5 });
});

const ZONE = 'Asia/Kolkata';
const EPOCH = 1_759_000_000_000;
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
    recordedAt: '2026-10-04T09:00:00.000Z',
    physicalMillis: EPOCH,
    newId,
  };
}

/** A plausible Indian panel, as a PDF text layer comes out of a lab portal. */
const REPORT = `
   METROPOLIS HEALTHCARE LTD
   Collected On: 12-Sep-2026 08:14

   TEST                          RESULT      UNIT        REFERENCE
   Vitamin D (25-OH)             14.2        ng/mL       30 - 100
   Serum TSH                     2.14        uIU/mL      0.55 - 4.78
   Ferritin                      64          ng/mL       22 - 322
`;

suite('health core and the document vault', () => {
  beforeEach(async () => {
    if (db === undefined) return;

    await resetDomainTables(db.$client);
  });

  /* ---------------------------------------------------------------------
   * Vitals
   * ------------------------------------------------------------------ */

  describe('vitals', () => {
    it('writes both halves of a blood pressure and reads them back as one reading', async () => {
      if (db === undefined) return;
      const health = createHealthRepository(db);

      const readingId = newId();
      const planned = planVitalReading({
        id: readingId,
        observedAt: '2026-10-04T07:30:00.000Z',
        observedZone: ZONE,
        systolic: 118,
        diastolic: 76,
        restingHeartRate: 58,
      });
      if (!isOk(planned)) throw new Error(planned.error.message);

      const written = await health.recordVitals([...planned.value], writeContext(await registry()));
      expect(isOk(written) && written.value).toBe(3);

      const read = await health.vitalsBetween('2026-10-01T00:00:00.000Z', '2026-10-05T00:00:00.000Z');
      if (!isOk(read)) throw new Error('read failed');

      const readings = pairReadings(read.value);
      expect(readings).toHaveLength(1);
      expect(readings[0]?.id).toBe(readingId);
      /* The pairing survives the round trip through `numeric(20,6)`. */
      expect(Number(readings[0]?.systolic)).toBe(118);
      expect(Number(readings[0]?.diastolic)).toBe(76);
      expect(Number(readings[0]?.restingHeartRate)).toBe(58);
    });
  });

  /* ---------------------------------------------------------------------
   * Conditions — §9.5's two clocks, in the database
   * ------------------------------------------------------------------ */

  describe('the conditions register', () => {
    it('records a March onset learned about in October', async () => {
      if (db === undefined) return;
      const health = createHealthRepository(db);

      const created = await health.addCondition(
        {
          id: newId(),
          name: 'Vitamin D deficiency',
          status: 'active',
          onsetAt: '2026-03-14T12:00:00.000Z',
          zone: ZONE,
        },
        '2026-10-02T09:00:00.000Z',
      );
      if (!isOk(created)) throw new Error('insert failed');

      expect(created.value.validFrom.slice(0, 10)).toBe('2026-03-14');
      expect(created.value.recordedFrom.slice(0, 10)).toBe('2026-10-02');
    });

    /**
     * The heart of it. A status change must leave the old belief on the record
     * with a closed interval, or "what did my file say in March" stops being
     * answerable the moment anything is corrected.
     */
    it('supersedes rather than updates when a status changes', async () => {
      if (db === undefined) return;
      const health = createHealthRepository(db);

      const first = await health.addCondition(
        {
          id: newId(),
          name: 'Iron deficiency',
          status: 'suspected',
          onsetAt: '2026-05-01T12:00:00.000Z',
          zone: ZONE,
        },
        '2026-05-02T09:00:00.000Z',
      );
      if (!isOk(first)) throw new Error('insert failed');

      const revised = await health.reviseCondition(
        first.value.id,
        'refuted',
        'Ferritin came back normal.',
        '2026-10-04T09:00:00.000Z',
        newId(),
      );
      if (!isOk(revised)) throw new Error('revise failed');

      const rows = await db.$client`select id, status, valid_from, recorded_from, recorded_to
                                     from condition order by recorded_from`;
      expect(rows).toHaveLength(2);
      /* The predecessor keeps its status forever and gains a closed belief. */
      expect(rows[0]?.['status']).toBe('suspected');
      expect(rows[0]?.['recorded_to']).not.toBeNull();
      expect(rows[1]?.['status']).toBe('refuted');
      expect(rows[1]?.['recorded_to']).toBeNull();
      /* Belief moved; onset did not. */
      expect(String(rows[0]?.['valid_from'])).toEqual(String(rows[1]?.['valid_from']));

      /* And the default read shows exactly one — the current belief. */
      const current = await health.conditions();
      expect(isOk(current) && current.value).toHaveLength(1);
    });
  });

  /* ---------------------------------------------------------------------
   * Symptoms
   * ------------------------------------------------------------------ */

  describe('symptoms', () => {
    it('writes an intensity observation alongside the entity, once on a replay', async () => {
      if (db === undefined) return;
      const health = createHealthRepository(db);

      const planned = planSymptom({
        id: newId(),
        name: 'Headache',
        intensity: 6,
        startedAt: '2026-10-03T18:00:00.000Z',
        zone: ZONE,
        suspectedTrigger: 'poor sleep',
      });
      if (!isOk(planned)) throw new Error(planned.error.message);

      const reg = await registry();
      const first = await health.logSymptom(planned.value, writeContext(reg));
      expect(isOk(first)).toBe(true);

      /* §5.7: the same UUIDv7 arrives again from the outbox. */
      const replay = await health.logSymptom(planned.value, writeContext(reg));
      expect(isOk(replay)).toBe(true);

      const rows = await db.$client`select count(*)::int as total from symptom`;
      expect(rows[0]?.['total']).toBe(1);

      const observations = await db.$client`select count(*)::int as total from observation
                                             where metric_key = 'body.symptom.intensity'`;
      expect(observations[0]?.['total']).toBe(1);
    });
  });

  /* ---------------------------------------------------------------------
   * §12's clinical loop, end to end
   * ------------------------------------------------------------------ */

  describe('the vitamin D loop', () => {
    it('goes from lab text to a trend to a consultation question', async () => {
      if (db === undefined) return;
      const labs = createLabRepository(db);
      const health = createHealthRepository(db);
      const reg = await registry();

      /* --- 1. the PDF's text becomes candidates ------------------------ */

      const parsed = parseLabReport(REPORT);
      expect(parsed.collectedOn).toBe('2026-09-12');

      const vitaminD = parsed.candidates.find((c) => c.analyteSlug === 'vitamin_d_25oh');
      expect(vitaminD?.printedValue).toBe('14.2');

      /* --- 2. the operator confirms them ------------------------------- */

      const confirmed = confirmCandidates(
        parsed,
        parsed.candidates.map((candidate) => ({ key: candidate.key, accept: true })),
      );
      if (!isOk(confirmed)) throw new Error('confirm failed');

      const documentId = newId();
      await db.$client`insert into document (id, kind, title) values (${documentId}, 'lab_report', 'Panel')`;

      const panelId = newId();
      const recorded = await labs.recordPanel(
        {
          id: panelId,
          panelName: 'Full body panel',
          laboratory: 'Metropolis',
          collectedAt: '2026-09-12T12:00:00.000Z',
          zone: ZONE,
          documentId,
          results: confirmed.value.map((result) => ({
            id: newId(),
            analyteSlug: result.candidate.analyteSlug,
            printedName: result.candidate.printedName,
            value: result.value,
            unit: result.unit,
            referenceLow: result.candidate.rangeLow,
            referenceHigh: result.candidate.rangeHigh,
            flag: result.candidate.printedFlag,
            confidence: result.confidence,
          })),
        },
        writeContext(reg),
      );
      if (!isOk(recorded)) throw new Error(`record failed: ${JSON.stringify(recorded.error)}`);
      expect(recorded.value.withoutTrend).toEqual([]);

      /* --- 3. the results became observations, with provenance ---------- */

      const observations = await db.$client`
        select o.value, o.confidence, s.kind, s.document_id
        from observation o
        join observation_source s on s.id = o.source_id
        where o.metric_key = ${labMetricKey('vitamin_d_25oh')}`;

      expect(observations).toHaveLength(1);
      expect(Number(observations[0]?.['value'])).toBeCloseTo(14.2, 3);
      /* §9.9: the number traces back to the page it came from. */
      expect(observations[0]?.['kind']).toBe('document_extraction');
      expect(observations[0]?.['document_id']).toBe(documentId);
      /* §9.9 again: the extraction's confidence is kept, not consumed. */
      expect(Number(observations[0]?.['confidence'])).toBeLessThan(1);

      /* --- 4. the trend reads back, in the canonical unit --------------- */

      const history = await labs.resultsForAnalyte('vitamin_d_25oh');
      if (!isOk(history)) throw new Error('history failed');
      expect(history.value).toHaveLength(1);

      const latest = history.value[0];
      const printed = {
        low: latest?.referenceLow ?? null,
        high: latest?.referenceHigh ?? null,
        text: latest?.referenceText ?? null,
        unit: latest?.unit ?? null,
      };
      const flag = effectiveFlag(latest?.flag ?? null, latest?.value ?? null, printed);
      /* The report printed no flag for this line, so the range decided it —
       * and the screen is told the flag was derived rather than printed. */
      expect(flag).toEqual({ flag: 'low', source: 'derived' });

      /* --- 5. it becomes a question, with the number in it -------------- */

      const questions = deriveQuestions({
        labs: [
          {
            resultId: latest?.id ?? '',
            analyte: analyteBySlug('vitamin_d_25oh')?.displayName ?? '',
            /* Trimmed, as the platform layer does before this reaches a
               screen: `numeric(20,6)` returns `14.200000`, and this string is
               read aloud in a consulting room. */
            value: formatMeasured(latest?.value ?? '0'),
            unit: latest?.unit ?? null,
            flag: flag.flag,
            flagSource: flag.source,
            rangeText: describeRange(printed),
            collectedAt: latest?.collectedAt ?? null,
            previous: null,
          },
        ],
        adherence: [],
        sideEffects: [],
        symptoms: [],
        conditions: [],
        nowIso: '2026-10-04T09:00:00.000Z',
      });

      expect(questions.questions).toHaveLength(1);
      const text = questions.questions[0]?.question ?? '';
      expect(text).toContain('25-hydroxyvitamin D');
      expect(text).toContain('14.2 ng/mL');
      expect(text).toContain('12 September 2026');
      expect(text).toContain('30 – 100 ng/mL');
      expect(text.endsWith('?')).toBe(true);

      /* --- 6. and it can be carried to an appointment ------------------- */

      const appointmentId = newId();
      const scheduled = await health.scheduleAppointment({
        id: appointmentId,
        title: 'GP review',
        scheduledFor: '2026-10-20T09:00:00.000Z',
        zone: ZONE,
      });
      if (!isOk(scheduled)) throw new Error('schedule failed');

      const saved = await health.saveQuestions(appointmentId, questions.questions);
      expect(isOk(saved)).toBe(true);

      const reread = await health.appointmentById(appointmentId);
      if (!isOk(reread) || reread.value === null) throw new Error('reread failed');
      expect(reread.value.preVisitQuestions).toHaveLength(1);
      expect(reread.value.preVisitQuestions[0]?.source).toBe('lab');
    });

    /**
     * A confirmation retried after a network failure must not double the panel.
     * The result ids are derived from the panel id and the line, which is what
     * makes `ON CONFLICT DO NOTHING` recognise the replay.
     */
    it('is idempotent on a replayed confirmation', async () => {
      if (db === undefined) return;
      const labs = createLabRepository(db);
      const reg = await registry();

      const panelId = newId();
      const resultId = newId();
      const input = {
        id: panelId,
        panelName: 'Full body panel',
        collectedAt: '2026-09-12T12:00:00.000Z',
        zone: ZONE,
        results: [
          {
            id: resultId,
            analyteSlug: 'vitamin_d_25oh',
            printedName: 'Vitamin D (25-OH)',
            value: '14.2',
            unit: 'ng/mL',
            referenceLow: '30',
            referenceHigh: '100',
            confidence: 0.9,
          },
        ],
      } as const;

      await labs.recordPanel({ ...input }, writeContext(reg));
      await labs.recordPanel({ ...input }, writeContext(reg));

      const panels = await db.$client`select count(*)::int as total from lab_panel`;
      const results = await db.$client`select count(*)::int as total from lab_result`;
      expect(panels[0]?.['total']).toBe(1);
      expect(results[0]?.['total']).toBe(1);
    });

    /**
     * A result this system cannot put on an axis still belongs in the record.
     * The row is written; only the observation is skipped, and the caller is
     * told why so the screen can say "on the report, not on a chart".
     */
    it('stores an uncatalogued analyte without a trend, and says so', async () => {
      if (db === undefined) return;
      const labs = createLabRepository(db);

      const recorded = await labs.recordPanel(
        {
          id: newId(),
          panelName: 'Panel',
          collectedAt: '2026-09-12T12:00:00.000Z',
          zone: ZONE,
          results: [
            {
              id: newId(),
              analyteSlug: null,
              printedName: 'Homocysteine',
              value: '9.4',
              unit: 'umol/L',
              confidence: 1,
            },
          ],
        },
        writeContext(await registry()),
      );
      if (!isOk(recorded)) throw new Error('record failed');

      expect(recorded.value.withoutTrend).toEqual([{ analyte: 'Homocysteine', reason: 'not_catalogued' }]);

      const rows = await db.$client`select analyte, observation_id from lab_result`;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.['analyte']).toBe('Homocysteine');
      expect(rows[0]?.['observation_id']).toBeNull();
    });
  });
});
