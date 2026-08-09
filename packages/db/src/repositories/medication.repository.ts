/**
 * The medication register, persisted — the two active psychiatric medications
 * §12 names for week 4, and everything Health will need in V2.
 *
 * ## Schedules are bitemporal, and the read has to say which axis it means
 *
 * `medication_schedule` carries §9.5's two time axes. The distinction is not
 * academic here: "what dose was I on in May" and "what did the record say in
 * May about the dose I was on" are different questions, and the second one is
 * what a psychiatrist asks when the first answer surprises them.
 *
 * {@link MedicationRepository.schedules} returns the **currently believed**
 * history — every schedule whose `recordedTo` is null — which is the right
 * default for adherence and for chart annotations. A record-as-at read is a V2
 * concern and is deliberately absent rather than half-built.
 *
 * ## Events dedupe on the day, not on the id
 *
 * Same reasoning as `routine.repository.ts`: the operator taps "taken", the tap
 * queues offline, and they tap again. Two ids, one dose. There is no unique
 * index to conflict on — `medication_event` legitimately allows several rows a
 * day for a twice-daily schedule — so {@link MedicationRepository.logEvent}
 * checks for an existing event at the same scheduled time first.
 */

import { and, asc, desc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { Result } from '@naitikos/shared';
import { err, ok } from '@naitikos/shared';
import { conflictError } from '@naitikos/core';
import type {
  DomainError,
  Medication,
  MedicationEvent,
  MedicationEventKind,
  MedicationSchedule,
} from '@naitikos/core';

import type { Database } from '../client';
import { medicalEvent, medication, medicationEvent, medicationSchedule } from '../schema/medical';

function toMedication(row: typeof medication.$inferSelect): Medication {
  return {
    id: row.id,
    substance: row.substance,
    brandName: row.brandName,
    strength: row.strength,
    strengthUnit: row.strengthUnit,
    startedAt: row.startedAt,
    stoppedAt: row.stoppedAt,
    stopReason: row.stopReason,
    isPsychiatric: row.isPsychiatric,
  };
}

function toSchedule(row: typeof medicationSchedule.$inferSelect): MedicationSchedule {
  return {
    id: row.id,
    medicationId: row.medicationId,
    dose: row.dose,
    doseUnit: row.doseUnit,
    frequency: row.frequency,
    times: Array.isArray(row.times) ? row.times.filter((item): item is string => typeof item === 'string') : [],
    validFrom: row.validFrom,
    validTo: row.validTo,
  };
}

function toEvent(row: typeof medicationEvent.$inferSelect): MedicationEvent {
  return {
    id: row.id,
    medicationId: row.medicationId,
    scheduleId: row.scheduleId,
    kind: row.kind as MedicationEventKind,
    scheduledFor: row.scheduledFor,
    takenAt: row.takenAt,
    zone: row.zone,
  };
}

export type LogDoseInput = {
  readonly id: string;
  readonly medicationId: string;
  readonly scheduleId: string | null;
  readonly kind: MedicationEventKind;
  readonly scheduledFor: string;
  readonly takenAt: string | null;
  readonly zone: string;
  readonly note?: string | null;
};

export type MedicationRepository = {
  /** Medications not yet stopped, psychiatric first — §4.7's lens. */
  active(): Promise<Result<readonly Medication[], DomainError>>;
  all(): Promise<Result<readonly Medication[], DomainError>>;
  byId(id: string): Promise<Result<Medication | null, DomainError>>;
  /** The currently believed schedule history. See the file header. */
  schedules(medicationIds?: readonly string[]): Promise<Result<readonly MedicationSchedule[], DomainError>>;
  eventsBetween(from: string, until: string): Promise<Result<readonly MedicationEvent[], DomainError>>;
  logEvent(input: LogDoseInput): Promise<Result<{ readonly event: MedicationEvent; readonly written: boolean }, DomainError>>;
};

export function createMedicationRepository(db: Database): MedicationRepository {
  return {
    async active() {
      const rows = await db
        .select()
        .from(medication)
        .where(and(isNull(medication.stoppedAt), isNull(medication.deletedAt), isNull(medication.recordedTo)))
        .orderBy(desc(medication.isPsychiatric), asc(medication.substance));
      return ok(rows.map(toMedication));
    },

    async all() {
      const rows = await db
        .select()
        .from(medication)
        .where(and(isNull(medication.deletedAt), isNull(medication.recordedTo)))
        .orderBy(desc(medication.isPsychiatric), asc(medication.substance));
      return ok(rows.map(toMedication));
    },

    async byId(id) {
      const rows = await db
        .select()
        .from(medication)
        .where(and(eq(medication.id, id), isNull(medication.deletedAt), isNull(medication.recordedTo)))
        .limit(1);
      return ok(rows[0] === undefined ? null : toMedication(rows[0]));
    },

    async schedules(medicationIds) {
      const rows = await db
        .select()
        .from(medicationSchedule)
        .where(
          and(
            isNull(medicationSchedule.deletedAt),
            /* Currently believed only (§9.5). A superseded belief is history. */
            isNull(medicationSchedule.recordedTo),
            ...(medicationIds === undefined || medicationIds.length === 0
              ? []
              : [inArray(medicationSchedule.medicationId, [...medicationIds])]),
          ),
        )
        .orderBy(asc(medicationSchedule.medicationId), asc(medicationSchedule.validFrom));
      return ok(rows.map(toSchedule));
    },

    async eventsBetween(from, until) {
      const rows = await db
        .select()
        .from(medicationEvent)
        .where(
          and(
            gte(sql`coalesce(${medicationEvent.takenAt}, ${medicationEvent.scheduledFor})`, from),
            lt(sql`coalesce(${medicationEvent.takenAt}, ${medicationEvent.scheduledFor})`, until),
          ),
        )
        .orderBy(asc(medicationEvent.scheduledFor));
      return ok(rows.map(toEvent));
    },

    async logEvent(input) {
      /*
       * Deduped on `(medicationId, scheduledFor)` rather than on the row id.
       *
       * A replayed tap carries a different client id for the same dose. There
       * is no unique index to lean on — a twice-daily schedule legitimately has
       * two rows a day — so the check is explicit. `scheduledFor` is the dose's
       * identity: it is the slot, not the moment the operator got round to
       * tapping.
       */
      const existing = await db
        .select()
        .from(medicationEvent)
        .where(
          and(
            eq(medicationEvent.medicationId, input.medicationId),
            eq(medicationEvent.scheduledFor, input.scheduledFor),
          ),
        )
        .limit(1);

      const found = existing[0];
      if (found !== undefined) {
        // A different answer for the same slot is a correction, not a replay.
        if (found.kind === input.kind) return ok({ event: toEvent(found), written: false });

        const updated = await db
          .update(medicationEvent)
          .set({ kind: input.kind, takenAt: input.takenAt, note: input.note ?? null, updatedAt: sql`now()` })
          .where(eq(medicationEvent.id, found.id))
          .returning();
        const row = updated[0];
        return ok({ event: row === undefined ? toEvent(found) : toEvent(row), written: true });
      }

      const inserted = await db
        .insert(medicationEvent)
        .values({
          id: input.id,
          medicationId: input.medicationId,
          scheduleId: input.scheduleId,
          kind: input.kind,
          scheduledFor: input.scheduledFor,
          takenAt: input.takenAt,
          zone: input.zone,
          note: input.note ?? null,
        })
        .onConflictDoNothing({ target: medicationEvent.id })
        .returning();

      const row = inserted[0];
      if (row !== undefined) return ok({ event: toEvent(row), written: true });

      // The insert conflicted on the id: this exact row is already recorded.
      const reread = await db
        .select()
        .from(medicationEvent)
        .where(eq(medicationEvent.id, input.id))
        .limit(1);
      const existingById = reread[0];
      if (existingById === undefined) {
        return err(
          conflictError('medication_event', 'invalid_state', {
            code: 'medication_event_not_written',
            message: 'The dose could not be recorded.',
          }),
        );
      }
      return ok({ event: toEvent(existingById), written: false });
    },
  };
}

/* -------------------------------------------------------------------------
 * Registration — §2.1's "no manual database intervention required"
 * ---------------------------------------------------------------------- */

export type RegisterMedicationInput = {
  readonly id: string;
  readonly medicalEventId: string;
  readonly scheduleId: string;
  readonly substance: string;
  readonly brandName: string | null;
  readonly form: string;
  readonly strength: string | null;
  readonly strengthUnit: string | null;
  readonly indication: string | null;
  readonly prescriber: string | null;
  readonly startedAt: string;
  readonly isPsychiatric: boolean;
  readonly zone: string;
  readonly dose: string;
  readonly doseUnit: string;
  readonly frequency: string;
  readonly times: readonly string[];
};

/**
 * Register a medication, its medical event, and its first schedule.
 *
 * ## Three rows, one transaction, and the order is forced
 *
 * `medication.medical_event_id` is a non-null foreign key, so §9.5's bitemporal
 * event has to exist first. That is not incidental plumbing: §9.5 scopes
 * bitemporality to `medical_event` and its subtypes precisely so "when did I
 * start this, and when did the record learn it" stays answerable — and a
 * medication row without its event would be a clinical fact with no history.
 *
 * ## `validFrom` is the start date, not now
 *
 * The operator registering Venlafaxine in September records a medication they
 * began in February. `valid_from` is February — that is the *validity* axis,
 * what was true in the world. `recorded_from` defaults to `now()`, which is the
 * *transaction* axis: when the record learned it. Collapsing the two would make
 * every backfilled medication look like it started the day it was typed in, and
 * a mood chart's "started Escitalopram" marker would land in the wrong month.
 */
export async function registerMedication(
  db: Database,
  input: RegisterMedicationInput,
): Promise<Result<Medication, DomainError>> {
  return db.transaction(async (tx) => {
    await tx
      .insert(medicalEvent)
      .values({
        id: input.medicalEventId,
        type: 'medication',
        validFrom: input.startedAt,
        zone: input.zone,
        title: `Started ${input.brandName ?? input.substance}`,
      })
      .onConflictDoNothing({ target: medicalEvent.id });

    await tx
      .insert(medication)
      .values({
        id: input.id,
        medicalEventId: input.medicalEventId,
        substance: input.substance,
        brandName: input.brandName,
        form: input.form as typeof medication.$inferInsert.form,
        strength: input.strength,
        strengthUnit: input.strengthUnit,
        indication: input.indication,
        prescriber: input.prescriber,
        startedAt: input.startedAt,
        isPsychiatric: input.isPsychiatric,
        validFrom: input.startedAt,
      })
      .onConflictDoUpdate({
        target: medication.id,
        set: {
          substance: input.substance,
          brandName: input.brandName,
          strength: input.strength,
          strengthUnit: input.strengthUnit,
          indication: input.indication,
          prescriber: input.prescriber,
          isPsychiatric: input.isPsychiatric,
          updatedAt: sql`now()`,
          version: sql`${medication.version} + 1`,
        },
      });

    /*
     * `DO NOTHING` on the schedule, unlike the medication.
     *
     * §9.2: "a dose change is a new schedule rather than an edit that erases the
     * old dose." Updating this row would destroy the answer to "was I on 75mg or
     * 150mg when the side effects started?" — which the schema comment names as
     * precisely the question a psychiatrist asks. A dose change writes a second
     * row with its own validity interval; the GiST exclusion constraint from
     * migration 0002 is what keeps the two from overlapping.
     */
    await tx
      .insert(medicationSchedule)
      .values({
        id: input.scheduleId,
        medicationId: input.id,
        dose: input.dose,
        doseUnit: input.doseUnit,
        frequency: input.frequency,
        times: [...input.times],
        validFrom: input.startedAt,
      })
      .onConflictDoNothing({ target: medicationSchedule.id });

    const rows = await tx.select().from(medication).where(eq(medication.id, input.id)).limit(1);
    const row = rows[0];
    if (row === undefined) throw new Error('medication_not_written');
    return ok(toMedication(row));
  });
}
