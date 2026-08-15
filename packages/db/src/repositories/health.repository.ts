/**
 * Health core, persisted — conditions, symptoms, side effects, appointments,
 * and the observations that carry vitals.
 *
 * ## Every write here goes through `medical_event` first
 *
 * §9.3 makes it the supertype of everything clinically significant, and §9.2
 * says why: the medical timeline and the Consultation Pack are "a query over
 * one table rather than a ten-way union that has to be edited every time a
 * clinical domain is added". So a condition is two inserts, always, in one
 * transaction — and a subtype row without its event would be a fact that never
 * appears on the timeline it exists to populate.
 *
 * ## A status change is a new record, not an UPDATE
 *
 * `condition` is bitemporal (§9.5), and {@link HealthRepository.reviseCondition}
 * is what that costs: close the old row's `recordedTo`, insert a successor with
 * the same `validFrom`. Two rows for one diagnosis is the point. It is what
 * makes "what did my file say in March" answerable after the diagnosis was
 * corrected in October, and §4.4 is explicit that any other design "produces a
 * record that quietly lies to a clinician".
 *
 * The `validFrom` is carried across unchanged unless the caller supplies a new
 * one. A status change is a change of *belief*; it is not a claim that the
 * condition began on a different day, and silently moving the onset would
 * rewrite the history the successor row exists to preserve.
 *
 * ## Vitals have no table
 *
 * §9.2 only makes something an entity when it has internal structure, and a
 * vital sign is a number at a moment. They are read straight out of
 * `observation`, grouped back into readings by their shared subject — see
 * `core/domain/health/vitals.ts` for why the pairing lives on the subject.
 */

import { and, asc, desc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { Result } from '@naitikos/shared';
import { ok } from '@naitikos/shared';
import type {
  Appointment,
  AppointmentQuestion,
  Condition,
  ConditionInput,
  ConditionStatus,
  DomainError,
  PlannedSymptom,
  Severity,
  SideEffect,
  SideEffectInput,
  Observation,
  Symptom,
  VitalObservation,
} from '@naitikos/core';
import {
  SYMPTOM_METRIC,
  SYMPTOM_SUBJECT_TYPE,
  VITAL_METRICS,
  notFoundError,
  prepareObservations,
} from '@naitikos/core';

import type { Database } from '../client';
import { appointment, condition, medicalEvent, sideEffect, symptom } from '../schema/medical';
import { observation } from '../schema/substrate';
import { createObservationRepository } from './observation.repository';
import type { WriteContext } from './workout.repository';

/* -------------------------------------------------------------------------
 * Row mapping
 * ---------------------------------------------------------------------- */

function toCondition(row: typeof condition.$inferSelect): Condition {
  return {
    id: row.id,
    medicalEventId: row.medicalEventId,
    name: row.name,
    code: row.code,
    codeSystem: row.codeSystem,
    status: row.status as ConditionStatus,
    severity: row.severity as Severity | null,
    diagnosedBy: row.diagnosedBy,
    resolutionNote: row.resolutionNote,
    validFrom: row.validFrom,
    validTo: row.validTo,
    recordedFrom: row.recordedFrom,
    recordedTo: row.recordedTo,
  };
}

function toSymptom(row: typeof symptom.$inferSelect): Symptom {
  return {
    id: row.id,
    medicalEventId: row.medicalEventId,
    name: row.name,
    bodySite: row.bodySite,
    severity: row.severity as Severity | null,
    intensity: row.intensity,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    zone: row.zone,
    suspectedTrigger: row.suspectedTrigger,
    note: row.note,
  };
}

function toSideEffect(row: typeof sideEffect.$inferSelect): SideEffect {
  return {
    id: row.id,
    medicalEventId: row.medicalEventId,
    suspectedMedicationId: row.suspectedMedicationId,
    effect: row.effect,
    severity: row.severity as Severity | null,
    onsetAt: row.onsetAt,
    resolvedAt: row.resolvedAt,
    reportedToPrescriber: row.reportedToPrescriber,
    note: row.note,
  };
}

/**
 * Parse the `preVisitQuestions` jsonb defensively.
 *
 * The column has a default of `'[]'` and every writer here produces the right
 * shape, but this is a twenty-year record and a hand-edited row in year nine is
 * not a hypothetical. A malformed entry is dropped rather than thrown on — a
 * question list that fails to render is a consultation the operator walks into
 * unprepared.
 */
function toQuestions(value: unknown): readonly AppointmentQuestion[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): AppointmentQuestion[] => {
    if (typeof entry !== 'object' || entry === null) return [];
    const record = entry as Record<string, unknown>;
    const id = record['id'];
    const question = record['question'];
    if (typeof id !== 'string' || typeof question !== 'string') return [];
    return [
      {
        id,
        question,
        evidence: typeof record['evidence'] === 'string' ? record['evidence'] : '',
        source: (typeof record['source'] === 'string' ? record['source'] : 'manual') as AppointmentQuestion['source'],
        sourceId: typeof record['sourceId'] === 'string' ? record['sourceId'] : null,
      },
    ];
  });
}

function toAppointment(row: typeof appointment.$inferSelect, title: string): Appointment {
  return {
    id: row.id,
    medicalEventId: row.medicalEventId,
    title,
    provider: row.provider,
    specialty: row.specialty,
    location: row.location,
    scheduledFor: row.scheduledFor,
    zone: row.zone,
    attendedAt: row.attendedAt,
    preVisitQuestions: toQuestions(row.preVisitQuestions),
    postVisitNotes: row.postVisitNotes,
    outcome: row.outcome,
    followUpDue: row.followUpDue,
  };
}

/* -------------------------------------------------------------------------
 * Inputs
 * ---------------------------------------------------------------------- */

export type AppointmentInput = {
  readonly id: string;
  readonly title: string;
  readonly provider?: string | null;
  readonly specialty?: string | null;
  readonly location?: string | null;
  readonly scheduledFor: string;
  readonly zone: string;
};

export type VisitNotesInput = {
  readonly id: string;
  readonly attendedAt: string | null;
  readonly postVisitNotes: string | null;
  readonly outcome: string | null;
  readonly followUpDue: string | null;
};

export type HealthRepository = {
  /* --- vitals ------------------------------------------------------- */
  vitalsBetween(from: string, until: string): Promise<Result<readonly VitalObservation[], DomainError>>;
  recordVitals(
    observations: readonly Parameters<typeof prepareObservations>[0][number][],
    context: WriteContext,
  ): Promise<Result<number, DomainError>>;

  /* --- conditions --------------------------------------------------- */
  conditions(): Promise<Result<readonly Condition[], DomainError>>;
  addCondition(input: ConditionInput, nowIso: string): Promise<Result<Condition, DomainError>>;
  reviseCondition(
    id: string,
    status: ConditionStatus,
    note: string | null,
    nowIso: string,
    newId: string,
  ): Promise<Result<Condition, DomainError>>;

  /* --- symptoms ----------------------------------------------------- */
  symptomsBetween(from: string, until: string): Promise<Result<readonly Symptom[], DomainError>>;
  logSymptom(planned: PlannedSymptom, context: WriteContext): Promise<Result<Symptom, DomainError>>;
  endSymptom(id: string, endedAt: string): Promise<Result<void, DomainError>>;

  /* --- side effects ------------------------------------------------- */
  sideEffects(): Promise<Result<readonly SideEffect[], DomainError>>;
  recordSideEffect(input: SideEffectInput, nowIso: string): Promise<Result<SideEffect, DomainError>>;
  markReported(id: string): Promise<Result<void, DomainError>>;

  /* --- appointments ------------------------------------------------- */
  appointments(): Promise<Result<readonly Appointment[], DomainError>>;
  appointmentById(id: string): Promise<Result<Appointment | null, DomainError>>;
  scheduleAppointment(input: AppointmentInput): Promise<Result<Appointment, DomainError>>;
  saveQuestions(id: string, questions: readonly AppointmentQuestion[]): Promise<Result<void, DomainError>>;
  recordVisit(input: VisitNotesInput): Promise<Result<void, DomainError>>;
};

export function createHealthRepository(db: Database): HealthRepository {
  const observations = createObservationRepository(db);

  return {
    async vitalsBetween(from, until) {
      const rows = await db
        .select({
          metricKey: observation.metricKey,
          value: observation.value,
          observedAt: observation.observedAt,
          subjectId: observation.subjectId,
        })
        .from(observation)
        .where(
          and(
            inArray(observation.metricKey, Object.values(VITAL_METRICS)),
            gte(observation.observedAt, from),
            lt(observation.observedAt, until),
            /* §9.1: a superseded reading is history, not current state. The
             * pairing would otherwise show a corrected blood pressure twice. */
            isNull(observation.supersededById),
          ),
        )
        .orderBy(desc(observation.observedAt));

      return ok(rows);
    },

    async recordVitals(inputs, context) {
      const prepared = prepareObservations(inputs, context.hlcState, {
        registry: context.registry,
        sourceId: (await sourceIdFor(observations)) as Observation['sourceId'],
        recordedAt: context.recordedAt,
        physicalMillis: context.physicalMillis,
        newId: context.newId,
      });
      if (!prepared.ok) return prepared;
      return observations.append(prepared.value.observations, prepared.value.supersessions);
    },

    async conditions() {
      const rows = await db
        .select()
        .from(condition)
        .where(and(isNull(condition.deletedAt), isNull(condition.recordedTo)))
        .orderBy(desc(condition.validFrom));
      return ok(rows.map(toCondition));
    },

    async addCondition(input, nowIso) {
      const eventId = crypto.randomUUID();
      const written = await db.transaction(async (tx) => {
        await tx.insert(medicalEvent).values({
          id: eventId,
          type: 'condition',
          title: input.name,
          ...(input.note === undefined || input.note === null ? {} : { narrative: input.note }),
          validFrom: input.onsetAt,
          recordedFrom: nowIso,
          zone: input.zone,
        });

        const rows = await tx
          .insert(condition)
          .values({
            id: input.id,
            medicalEventId: eventId,
            name: input.name,
            code: input.code ?? null,
            codeSystem: input.codeSystem ?? null,
            status: input.status as ConditionStatus,
            severity: input.severity ?? null,
            diagnosedBy: input.diagnosedBy ?? null,
            validFrom: input.onsetAt,
            recordedFrom: nowIso,
          })
          .returning();
        return rows[0];
      });

      return written === undefined
        ? ok({} as Condition)
        : ok(toCondition(written));
    },

    async reviseCondition(id, status, note, nowIso, newId) {
      const existing = await db.select().from(condition).where(eq(condition.id, id)).limit(1);
      const current = existing[0];
      if (current === undefined) return { ok: false, error: notFoundError('condition', id) };

      const written = await db.transaction(async (tx) => {
        /*
         * Close the belief, do not overwrite it. §9.5: "A correction is a new
         * row plus a closed interval on its predecessor, never an UPDATE." The
         * old row keeps its status forever, which is what makes the register
         * reconstructable as at any past date.
         */
        await tx.update(condition).set({ recordedTo: nowIso }).where(eq(condition.id, id));

        const rows = await tx
          .insert(condition)
          .values({
            id: newId,
            medicalEventId: current.medicalEventId,
            name: current.name,
            code: current.code,
            codeSystem: current.codeSystem,
            status,
            severity: current.severity,
            diagnosedBy: current.diagnosedBy,
            resolutionNote: note,
            // Carried across unchanged: belief moved, onset did not.
            validFrom: current.validFrom,
            validTo: status === 'resolved' || status === 'refuted' ? nowIso : current.validTo,
            recordedFrom: nowIso,
          })
          .returning();
        return rows[0];
      });

      return written === undefined ? ok({} as Condition) : ok(toCondition(written));
    },

    async symptomsBetween(from, until) {
      const rows = await db
        .select()
        .from(symptom)
        .where(
          and(
            isNull(symptom.deletedAt),
            isNull(symptom.recordedTo),
            gte(symptom.startedAt, from),
            lt(symptom.startedAt, until),
          ),
        )
        .orderBy(desc(symptom.startedAt));
      return ok(rows.map(toSymptom));
    },

    async logSymptom(planned, context) {
      const input = planned.input;
      const eventId = crypto.randomUUID();

      const written = await db.transaction(async (tx) => {
        await tx.insert(medicalEvent).values({
          id: eventId,
          type: 'symptom',
          title: input.name,
          severity: input.severity ?? null,
          validFrom: input.startedAt,
          recordedFrom: context.recordedAt,
          zone: input.zone,
        });

        const rows = await tx
          .insert(symptom)
          .values({
            id: input.id,
            medicalEventId: eventId,
            name: input.name,
            bodySite: input.bodySite ?? null,
            severity: input.severity ?? null,
            intensity: input.intensity ?? null,
            startedAt: input.startedAt,
            endedAt: input.endedAt ?? null,
            zone: input.zone,
            suspectedTrigger: input.suspectedTrigger ?? null,
            note: input.note ?? null,
            validFrom: input.startedAt,
            recordedFrom: context.recordedAt,
          })
          /* §5.7: a replayed outbox entry arrives with the same UUIDv7. */
          .onConflictDoNothing()
          .returning();
        return rows[0];
      });

      /*
       * The observation write is guarded by the *entity's* existence, not by
       * the observation's own id.
       *
       * `planSymptom` mints no observation id — `prepareObservations` generates
       * one per call — so a replayed outbox entry would append a second
       * intensity observation for the same symptom while the symptom row itself
       * was correctly deduped. That is the shape of bug that survives review:
       * the count is right in one table and silently doubled in the other.
       *
       * Checking the subject first is the same guard `medication.repository`'s
       * `logEvent` uses, for the same reason.
       */
      const alreadyWritten =
        written === undefined &&
        (
          await db
            .select({ id: observation.id })
            .from(observation)
            .where(
              and(
                eq(observation.metricKey, SYMPTOM_METRIC),
                eq(observation.subjectType, SYMPTOM_SUBJECT_TYPE),
                eq(observation.subjectId, input.id),
              ),
            )
            .limit(1)
        ).length > 0;

      if (planned.observations.length > 0 && !alreadyWritten) {
        const prepared = prepareObservations(planned.observations, context.hlcState, {
          registry: context.registry,
          sourceId: (await sourceIdFor(observations)) as Observation['sourceId'],
          recordedAt: context.recordedAt,
          physicalMillis: context.physicalMillis,
          newId: context.newId,
        });
        if (!prepared.ok) return prepared;
        const appended = await observations.append(prepared.value.observations, prepared.value.supersessions);
        if (!appended.ok) return appended;
      }

      if (written !== undefined) return ok(toSymptom(written));

      const replayed = await db.select().from(symptom).where(eq(symptom.id, input.id)).limit(1);
      const row = replayed[0];
      return row === undefined ? { ok: false, error: notFoundError('symptom', input.id) } : ok(toSymptom(row));
    },

    async endSymptom(id, endedAt) {
      await db.update(symptom).set({ endedAt, updatedAt: sql`now()` }).where(eq(symptom.id, id));
      return ok(undefined);
    },

    async sideEffects() {
      const rows = await db
        .select()
        .from(sideEffect)
        .where(and(isNull(sideEffect.deletedAt), isNull(sideEffect.recordedTo)))
        .orderBy(desc(sideEffect.onsetAt));
      return ok(rows.map(toSideEffect));
    },

    async recordSideEffect(input, nowIso) {
      const eventId = crypto.randomUUID();
      const written = await db.transaction(async (tx) => {
        await tx.insert(medicalEvent).values({
          id: eventId,
          type: 'side_effect',
          title: input.effect,
          severity: input.severity ?? null,
          validFrom: input.onsetAt,
          recordedFrom: nowIso,
          zone: input.zone,
        });

        const rows = await tx
          .insert(sideEffect)
          .values({
            id: input.id,
            medicalEventId: eventId,
            suspectedMedicationId: input.suspectedMedicationId ?? null,
            effect: input.effect,
            severity: input.severity ?? null,
            onsetAt: input.onsetAt,
            note: input.note ?? null,
            validFrom: input.onsetAt,
            recordedFrom: nowIso,
          })
          .onConflictDoNothing()
          .returning();
        return rows[0];
      });

      if (written !== undefined) return ok(toSideEffect(written));
      const replayed = await db.select().from(sideEffect).where(eq(sideEffect.id, input.id)).limit(1);
      const row = replayed[0];
      return row === undefined ? { ok: false, error: notFoundError('side_effect', input.id) } : ok(toSideEffect(row));
    },

    async markReported(id) {
      await db
        .update(sideEffect)
        .set({ reportedToPrescriber: true, updatedAt: sql`now()` })
        .where(eq(sideEffect.id, id));
      return ok(undefined);
    },

    async appointments() {
      const rows = await db
        .select({ appointment, title: medicalEvent.title })
        .from(appointment)
        .innerJoin(medicalEvent, eq(appointment.medicalEventId, medicalEvent.id))
        .where(and(isNull(appointment.deletedAt), isNull(appointment.recordedTo)))
        .orderBy(desc(appointment.scheduledFor));
      return ok(rows.map((row) => toAppointment(row.appointment, row.title)));
    },

    async appointmentById(id) {
      const rows = await db
        .select({ appointment, title: medicalEvent.title })
        .from(appointment)
        .innerJoin(medicalEvent, eq(appointment.medicalEventId, medicalEvent.id))
        .where(eq(appointment.id, id))
        .limit(1);
      const row = rows[0];
      return ok(row === undefined ? null : toAppointment(row.appointment, row.title));
    },

    async scheduleAppointment(input) {
      const eventId = crypto.randomUUID();
      const written = await db.transaction(async (tx) => {
        await tx.insert(medicalEvent).values({
          id: eventId,
          type: 'appointment',
          title: input.title,
          validFrom: input.scheduledFor,
          zone: input.zone,
        });

        const rows = await tx
          .insert(appointment)
          .values({
            id: input.id,
            medicalEventId: eventId,
            provider: input.provider ?? null,
            specialty: input.specialty ?? null,
            location: input.location ?? null,
            scheduledFor: input.scheduledFor,
            zone: input.zone,
            validFrom: input.scheduledFor,
          })
          .onConflictDoNothing()
          .returning();
        return rows[0];
      });

      if (written !== undefined) return ok(toAppointment(written, input.title));
      const replayed = await db.select().from(appointment).where(eq(appointment.id, input.id)).limit(1);
      const row = replayed[0];
      return row === undefined
        ? { ok: false, error: notFoundError('appointment', input.id) }
        : ok(toAppointment(row, input.title));
    },

    async saveQuestions(id, questions) {
      await db
        .update(appointment)
        .set({ preVisitQuestions: questions, updatedAt: sql`now()` })
        .where(eq(appointment.id, id));
      return ok(undefined);
    },

    async recordVisit(input) {
      await db
        .update(appointment)
        .set({
          attendedAt: input.attendedAt,
          postVisitNotes: input.postVisitNotes,
          outcome: input.outcome,
          followUpDue: input.followUpDue,
          updatedAt: sql`now()`,
        })
        .where(eq(appointment.id, input.id));
      return ok(undefined);
    },
  };
}

/** Vitals and symptom intensities are typed by a person, so: `manual` (§9.2). */
async function sourceIdFor(observations: ReturnType<typeof createObservationRepository>): Promise<string> {
  const source = await observations.manualSourceId();
  if (!source.ok) throw new Error(source.error.message);
  return source.value;
}

/** Kept so the day-window queries have one spelling of "ordered oldest first". */
export const ASC_BY_ONSET = asc(sideEffect.onsetAt);
