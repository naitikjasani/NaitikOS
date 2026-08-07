/**
 * Medical — §9.2 and §9.5. The only bitemporal region of the schema.
 *
 * §9.5 draws the boundary and defends it:
 *
 *   "Bitemporality applies to `medical_event` and its subtypes only. This is a
 *    deliberate boundary. Full bitemporality everywhere would double the
 *    conceptual complexity of every query in the system for benefit that exists
 *    almost exclusively in the clinical domain."
 *
 * Why it is non-negotiable here, from §4.4:
 *
 *   "*When something happened* and *when you recorded it* are different facts,
 *    and in a medical record they must both be preserved. Learning in October
 *    that a condition began in March must not rewrite history... Any other
 *    design produces a record that quietly lies to a clinician."
 *
 * The capability bought is reconstructing the record *as it was understood on
 * any past date* — so when a clinician asks "what did you know when you made
 * that decision?", the system can answer truthfully.
 */

import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';

import {
  conditionStatus,
  labFlag,
  medicalEventType,
  medicationEventKind,
  medicationForm,
  medicationStopReason,
  severity,
  treatmentOutcome,
} from './enums';
import {
  confidence,
  entityColumns,
  ianaZone,
  instant,
  primaryKey,
  quantity,
  reference,
  rowTimestamps,
} from './columns';

/**
 * The two time axes, applied to every clinical table (§9.5).
 *
 * **Valid time** (`validFrom` / `validTo`) — when the fact was true in the
 * world. A condition's onset. A medication's start and stop.
 *
 * **Transaction time** (`recordedFrom` / `recordedTo`) — when the system
 * believed it. A row is superseded by closing `recordedTo` and inserting a
 * successor, never by an UPDATE. That is what makes "as known on date X"
 * queryable: filter `recordedFrom <= X < recordedTo`.
 *
 * §9.5's worked example: "A lab drawn on 12 March, reported on 19 March,
 * entered on 24 March is three different dates, all of them true, all of them
 * sometimes the one that matters."
 *
 * An open interval is `NULL` on the upper bound, not a sentinel far-future
 * date. Sentinels get compared, formatted, and eventually displayed to someone.
 */
const bitemporal = {
  validFrom: instant().notNull(),
  /** Null while still true. */
  validTo: instant(),
  recordedFrom: instant().notNull().default(sql`now()`),
  /** Null while still believed. Closing this is how a correction is recorded. */
  recordedTo: instant(),
};

/**
 * The supertype of everything clinically significant (§9.2, §9.3).
 *
 * Every subtype below carries a `medicalEventId` pointing here. That single
 * join is what makes the medical timeline (§4.4) and the Consultation Pack
 * (§2.2) a query over one table rather than a ten-way union that has to be
 * edited every time a clinical domain is added.
 */
export const medicalEvent = pgTable(
  'medical_event',
  {
    ...entityColumns,
    ...bitemporal,

    type: medicalEventType().notNull(),
    /** One-line summary for the timeline, in the user's own words where possible. */
    title: text().notNull(),
    narrative: text(),
    severity: severity(),
    confidence: confidence(),

    /** Where this came from: a clinician, a lab report, self-observation. */
    sourceDescription: text(),
    /** Set when a document evidences this event (§9.9). */
    documentId: reference(),

    zone: ianaZone(),
  },
  (t) => [
    index('medical_event_valid_idx').on(t.validFrom.desc()),
    index('medical_event_type_idx').on(t.type, t.validFrom.desc()),
    /* "As known on date X" — the §9.5 reconstruction query. */
    index('medical_event_current_idx')
      .on(t.type, t.validFrom.desc())
      .where(sql`${t.recordedTo} IS NULL AND ${t.deletedAt} IS NULL`),
    check('medical_event_valid_ordered', sql`${t.validTo} IS NULL OR ${t.validFrom} <= ${t.validTo}`),
    check('medical_event_recorded_ordered', sql`${t.recordedTo} IS NULL OR ${t.recordedFrom} <= ${t.recordedTo}`),
  ],
);

/**
 * A diagnosis. *Anxiety disorder, Vitamin D deficiency, acne vulgaris.*
 *
 * `refuted` is a status rather than a deletion (§9.4): a diagnosis that turned
 * out to be wrong is itself clinically relevant history, and erasing it loses
 * the fact that it was once believed and acted upon.
 */
export const condition = pgTable(
  'condition',
  {
    ...entityColumns,
    ...bitemporal,

    medicalEventId: reference()
      .notNull()
      .references(() => medicalEvent.id),

    name: text().notNull(),
    /** ICD-10 or SNOMED where known. Optional — self-observed conditions have none. */
    code: text(),
    codeSystem: text(),

    status: conditionStatus().notNull().default('active'),
    severity: severity(),
    /** Who diagnosed it. Null for self-identified. */
    diagnosedBy: text(),
    resolutionNote: text(),
  },
  (t) => [
    index('condition_status_idx').on(t.status).where(sql`${t.deletedAt} IS NULL`),
    index('condition_event_idx').on(t.medicalEventId),
  ],
);

/**
 * The medication register — §4.4 calls this the authoritative source consumed
 * by Mind, Skin, and adherence detection across the system.
 *
 * `stopReason` is singled out in §9.2 ("and, importantly, the *reason* for
 * stopping") because it is what makes the register useful in year ten rather
 * than merely complete. "Stopped Escitalopram, side effects" and "stopped
 * Escitalopram, course completed" are different clinical histories.
 */
export const medication = pgTable(
  'medication',
  {
    ...entityColumns,
    ...bitemporal,

    medicalEventId: reference()
      .notNull()
      .references(() => medicalEvent.id),

    /** Generic name — `Venlafaxine`, `Escitalopram`. */
    substance: text().notNull(),
    brandName: text(),
    form: medicationForm().notNull(),

    /** Strength per unit, with its unit: 75 + `mg`. */
    strength: quantity(),
    strengthUnit: text(),

    /** Why it was prescribed. Links the medication to the condition it treats. */
    indication: text(),
    conditionId: reference().references(() => condition.id),
    prescriber: text(),

    startedAt: instant(),
    stoppedAt: instant(),
    stopReason: medicationStopReason(),
    stopNote: text(),

    /**
     * Psychiatric medications are flagged so Mind can present them as a lens
     * (§3.3(3): "One row, three lenses") without duplicating the register.
     */
    isPsychiatric: boolean().notNull().default(false),
  },
  (t) => [
    index('medication_active_idx')
      .on(t.substance)
      .where(sql`${t.stoppedAt} IS NULL AND ${t.deletedAt} IS NULL`),
    index('medication_event_idx').on(t.medicalEventId),
    /* Typo-tolerant lookup over a register that will hold decades of names (§9.6). */
    index('medication_substance_trgm_idx').using('gin', sql`${t.substance} gin_trgm_ops`),
    check('medication_stop_paired', sql`${t.stoppedAt} IS NOT NULL OR ${t.stopReason} IS NULL`),
  ],
);

/**
 * Dosing schedule, with its own validity interval.
 *
 * §9.2: "so a dose change is a new schedule rather than an edit that erases the
 * old dose." Without this, "was I on 75mg or 150mg when the side effects
 * started?" is unanswerable — and that is precisely the question a psychiatrist
 * asks.
 *
 * §9.6 requires a GiST exclusion constraint here, "preventing two active
 * schedules for the same medication". Drizzle cannot express one, so migration
 * `0002_medication_schedule_exclusion` adds it. That constraint is the *whole*
 * guard — there is deliberately no unique index alongside it.
 *
 * **Why not also a partial unique index on `medicationId`.** It was tried and it
 * is wrong, in a way worth recording so it is not reintroduced. Uniqueness on
 * the medication permits exactly one believed schedule per medication *ever*,
 * which forbids the history this table exists to keep: raising a dose from 75mg
 * to 150mg means two rows with adjacent, non-overlapping intervals, and a
 * unique index rejects the second one. The rule needed is "no two believed
 * schedules whose validity intervals intersect", and only a range operator can
 * express that.
 *
 * There is correspondingly no `isActive` column. Whether a schedule is in force
 * is `validFrom <= now < validTo` — deriving it is exact, whereas a maintained
 * boolean is a second source of truth that drifts (§9.3(4)).
 */
export const medicationSchedule = pgTable(
  'medication_schedule',
  {
    ...entityColumns,
    ...bitemporal,

    medicationId: reference()
      .notNull()
      .references(() => medication.id),

    dose: quantity().notNull(),
    doseUnit: text().notNull(),
    /** `daily`, `twice_daily`, `weekly`, `as_needed` — free text, rendered by the UI. */
    frequency: text().notNull(),
    /** `['08:00', '20:00']` in the profile's local time. Drives reminders (§5.9). */
    times: jsonb().notNull().default(sql`'[]'::jsonb`),
    withFood: boolean(),
    instructions: text(),
  },
  (t) => [
    index('medication_schedule_medication_idx').on(t.medicationId, t.validFrom.desc()),
    /* Current schedule lookup — the reminder path (§5.9) reads this every day. */
    index('medication_schedule_believed_idx')
      .on(t.medicationId, t.validFrom.desc())
      .where(sql`${t.recordedTo} IS NULL AND ${t.deletedAt} IS NULL`),
  ],
);

/**
 * Adherence events. Feeds the MVP's only insight family (§2.1).
 *
 * Not an observation, despite looking like one: §9.2's rule is that "only
 * things with internal structure become entities", and a dose event carries a
 * schedule reference, a scheduled-versus-actual pair, and a skip reason.
 */
export const medicationEvent = pgTable(
  'medication_event',
  {
    id: primaryKey(),
    ...rowTimestamps,

    medicationId: reference()
      .notNull()
      .references(() => medication.id),
    scheduleId: reference().references(() => medicationSchedule.id),

    kind: medicationEventKind().notNull(),
    /** When the dose was due. */
    scheduledFor: instant(),
    /** When it was actually taken. Null for `skipped`. */
    takenAt: instant(),
    zone: ianaZone(),

    doseTaken: quantity(),
    note: text(),
  },
  (t) => [
    index('medication_event_medication_idx').on(t.medicationId, t.scheduledFor.desc()),
    index('medication_event_kind_idx').on(t.kind, t.scheduledFor.desc()),
    check('medication_event_taken_paired', sql`${t.kind} <> 'taken' OR ${t.takenAt} IS NOT NULL`),
  ],
);

/**
 * A reported side effect.
 *
 * `suspectedMedicationId` is named "suspected" deliberately. §9.2: "Linked but
 * never asserted as causal by the system." P5 forbids the system from making
 * the causal claim; recording the user's suspicion is not the same thing, and
 * the column name is where that distinction is kept honest.
 */
export const sideEffect = pgTable(
  'side_effect',
  {
    ...entityColumns,
    ...bitemporal,

    medicalEventId: reference()
      .notNull()
      .references(() => medicalEvent.id),
    suspectedMedicationId: reference().references(() => medication.id),

    effect: text().notNull(),
    severity: severity(),
    onsetAt: instant(),
    resolvedAt: instant(),
    /** Whether it was reported to a clinician — relevant to the Consultation Pack. */
    reportedToPrescriber: boolean().notNull().default(false),
    note: text(),
  },
  (t) => [index('side_effect_medication_idx').on(t.suspectedMedicationId)],
);

/** A lab panel — the collection event and the laboratory's identity. */
export const labPanel = pgTable(
  'lab_panel',
  {
    ...entityColumns,
    ...bitemporal,

    medicalEventId: reference()
      .notNull()
      .references(() => medicalEvent.id),

    panelName: text().notNull(),
    laboratory: text(),
    orderedBy: text(),

    /** The three dates §9.5 insists are distinct. */
    collectedAt: instant(),
    reportedAt: instant(),

    documentId: reference(),
  },
  (t) => [index('lab_panel_collected_idx').on(t.collectedAt.desc())],
);

/**
 * A single analyte result.
 *
 * The reference range is stored **per result**, exactly as printed. §9.2 is
 * explicit that looking it up would be a clinical error: "ranges vary by
 * laboratory and change over time, and a 2027 result compared against a 2035
 * range is a clinical error."
 *
 * This is also the table that makes §4.11's provenance goal real — a lab PDF
 * becomes rows here whose `observation` counterparts cite the extraction, so
 * every number traces back to the page it came from.
 */
export const labResult = pgTable(
  'lab_result',
  {
    ...entityColumns,

    labPanelId: reference()
      .notNull()
      .references(() => labPanel.id),

    analyte: text().notNull(),
    /** LOINC where known. */
    code: text(),

    value: quantity(),
    /** Results like "not detected" that have no numeric form. */
    valueText: text(),
    unit: text(),

    /** As printed on this report, for this laboratory, on this date. */
    referenceLow: quantity(),
    referenceHigh: quantity(),
    referenceText: text(),
    flag: labFlag(),

    /** Links the structured result to its observation, so trends work (P3). */
    observationId: reference(),
  },
  (t) => [
    index('lab_result_panel_idx').on(t.labPanelId),
    index('lab_result_analyte_idx').on(t.analyte),
  ],
);

/**
 * An appointment, with the pre-visit question list that is the deliverable of
 * P5.
 *
 * P5: "The deliverable of a medical insight is *a better question for your next
 * appointment*, printed and ready." `preVisitQuestions` is where the system's
 * findings land — it is the concrete output of the whole insight pipeline, and
 * the reason the Consultation Pack (§2.2) exists.
 */
export const appointment = pgTable(
  'appointment',
  {
    ...entityColumns,
    ...bitemporal,

    medicalEventId: reference()
      .notNull()
      .references(() => medicalEvent.id),

    provider: text(),
    specialty: text(),
    location: text(),

    scheduledFor: instant(),
    zone: ianaZone(),
    attendedAt: instant(),

    /** `[{ question, sourceInsightId }]` — assembled before the visit. */
    preVisitQuestions: jsonb().notNull().default(sql`'[]'::jsonb`),
    postVisitNotes: text(),
    outcome: text(),
    followUpDue: instant(),
  },
  (t) => [
    index('appointment_scheduled_idx').on(t.scheduledFor.desc()),
    index('appointment_upcoming_idx')
      .on(t.scheduledFor)
      .where(sql`${t.attendedAt} IS NULL AND ${t.deletedAt} IS NULL`),
  ],
);

/**
 * A procedure. *Root canal on tooth 36, 2024-03.*
 *
 * §4.5's case for keeping this: "A person with multiple root canals has a
 * dental history that will matter for decades and that no dental practice will
 * reliably retain across relocations, insurers, or practitioner changes."
 */
export const procedure = pgTable(
  'procedure',
  {
    ...entityColumns,
    ...bitemporal,

    medicalEventId: reference()
      .notNull()
      .references(() => medicalEvent.id),

    name: text().notNull(),
    code: text(),
    performedBy: text(),
    location: text(),

    /** FDI notation for dental work — `36` is the lower-left first molar. */
    toothNotation: text(),
    bodySite: text(),

    performedAt: instant(),
    outcome: text(),
    complications: text(),

    /** Cost, for the V3 link to Money (§4.5). */
    costMinor: integer(),
    currency: text(),
  },
  (t) => [
    index('procedure_performed_idx').on(t.performedAt.desc()),
    index('procedure_tooth_idx').on(t.toothNotation).where(sql`${t.toothNotation} IS NOT NULL`),
  ],
);

/**
 * A bounded therapeutic intervention. *Isotretinoin, dates, cumulative dose,
 * response.*
 *
 * §9.2 singles this out as the entity that earns its keep over a decade:
 *
 *   "This is the entity that makes 'what have I already tried, and did it
 *    work?' answerable a decade later, which is precisely the question no
 *    clinic will be able to answer for you."
 */
export const treatmentCourse = pgTable(
  'treatment_course',
  {
    ...entityColumns,
    ...bitemporal,

    medicalEventId: reference()
      .notNull()
      .references(() => medicalEvent.id),

    name: text().notNull(),
    /** What it was treating. */
    conditionId: reference().references(() => condition.id),
    medicationId: reference().references(() => medication.id),

    startedAt: instant(),
    endedAt: instant(),

    /** Total dose across the course — clinically meaningful for isotretinoin. */
    cumulativeDose: quantity(),
    cumulativeDoseUnit: text(),
    dosingNote: text(),

    outcome: treatmentOutcome(),
    outcomeNote: text(),
    prescriber: text(),
  },
  (t) => [
    index('treatment_course_started_idx').on(t.startedAt.desc()),
    index('treatment_course_condition_idx').on(t.conditionId),
  ],
);

/**
 * Symptom log (§4.4).
 *
 * An entity rather than a plain observation because a symptom carries duration,
 * body site, and a suspected trigger — internal structure, which is §9.2's
 * test. Intensity is also written as an observation so it trends alongside
 * everything else.
 */
export const symptom = pgTable(
  'symptom',
  {
    ...entityColumns,
    ...bitemporal,

    medicalEventId: reference()
      .notNull()
      .references(() => medicalEvent.id),

    name: text().notNull(),
    bodySite: text(),
    severity: severity(),
    intensity: integer(),

    startedAt: instant(),
    endedAt: instant(),
    zone: ianaZone(),

    suspectedTrigger: text(),
    note: text(),
  },
  (t) => [index('symptom_started_idx').on(t.startedAt.desc())],
);
