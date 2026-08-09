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
import { medication, medicationEvent, medicationSchedule } from '../schema/medical';

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
