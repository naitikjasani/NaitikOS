/**
 * The event type registry.
 *
 * Every event type in the system is declared here with its payload type, its
 * current version, and how it renders on the timeline. A feature emits into this
 * registry; it does not define its own event types locally, because the timeline
 * and the job router both dispatch on the registry and a type they have never
 * heard of cannot be routed.
 *
 * ## The payload rule (ADR 0005)
 *
 * **References, never authoritative values.** A payload holds what a timeline
 * row needs to render and what a job needs to route — a label, a metric key, a
 * count, a reference id. It never holds the value itself, because the value
 * lives in `observation` or an entity row and two copies drift.
 *
 * The distinction in practice:
 *
 *   ✗ `{ weightKg: 74.2 }`              — an authoritative value. Two truths.
 *   ✓ `{ metricKey: 'body.weight' }`     — a reference. One truth, joinable.
 *
 * `registry.test.ts` asserts this structurally for every registered type, so a
 * payload that carries a measured number fails CI.
 *
 * ## Naming
 *
 * `Domain.ThingHappened`, past tense. Past tense because an event is a record of
 * something that already happened and cannot be refused — a handler that treats
 * `WeightLogged` as a request to log a weight has misunderstood the direction.
 */

/* =========================================================================
 * Payload shapes
 *
 * Grouped by domain. Each is deliberately small.
 * ====================================================================== */

/** Nothing beyond the envelope's subject is needed. */
type SubjectOnly = Record<string, never>;

/**
 * An observation was written.
 *
 * The generic event behind most numeric capture. Carries the *metric key*, never
 * the value — `observation` is the system of record and joining to it is one
 * indexed lookup.
 */
export type ObservationRecordedPayload = {
  /** Registry key: `body.weight`, `mind.mood` (§9.2). */
  readonly metricKey: string;
  /** Present only when this observation supersedes another (§9.1). */
  readonly supersedesObservationId?: string;
};

/** A medication dose was taken, skipped, or delayed. */
export type MedicationEventPayload = {
  readonly medicationId: string;
  readonly scheduleId?: string;
  /**
   * Display label only, denormalised for the timeline.
   *
   * A permitted exception to the reference rule and the reason is worth stating:
   * the alternative is a join to `medication` on every timeline row, and a
   * substance name is not a *measured value* — it cannot drift into
   * disagreement about a number. If the medication is renamed, historical
   * timeline rows show the name as it was, which is arguably more correct.
   */
  readonly substanceLabel: string;
};

export type WorkoutStartedPayload = {
  readonly programId?: string;
  readonly programBlockLabel?: string;
};

export type WorkoutCompletedPayload = {
  /** Counts, not loads. A count is a fact about the session, not a measurement. */
  readonly setCount: number;
  readonly exerciseCount: number;
  readonly durationMinutes?: number;
};

export type SetLoggedPayload = {
  readonly sessionId: string;
  readonly exerciseId: string;
  readonly exerciseLabel: string;
  readonly orderIndex: number;
  readonly isPersonalRecord: boolean;
};

export type BodyMeasurementPayload = {
  /** `waist`, `chest`. The value is an observation. */
  readonly site: string;
};

export type SkinRoutinePayload = {
  readonly routineId: string;
  readonly period: string;
  /** Completed / required. A ratio of counts, not a health metric. */
  readonly stepsCompleted: number;
  readonly stepsRequired: number;
};

export type JournalPayload = {
  /**
   * Deliberately carries no content, not even a length.
   *
   * §4.7 classifies journal text as the most sensitive data in the system, and
   * the event log is scanned by the timeline, replayed, and read by job
   * handlers. A character count is a weak signal and still a signal.
   */
  readonly hasPrompt: boolean;
};

export type MediaPayload = {
  readonly mediaObjectId: string;
  readonly kind: string;
  /** §9.8's protocol-compliance score, for filtering comparison views. */
  readonly complianceScore?: number;
  readonly region?: string;
};

export type DocumentPayload = {
  readonly documentId: string;
  readonly documentKind: string;
  /** Whether extraction is pending — a job router reads this. */
  readonly awaitingExtraction: boolean;
};

export type ReportImportedPayload = {
  readonly documentId: string;
  /** How many structured rows the import produced. A count, not a result. */
  readonly extractedRowCount: number;
  readonly method: string;
};

export type AppointmentPayload = {
  readonly medicalEventId: string;
  readonly specialty?: string;
};

export type GoalPayload = {
  readonly goalId: string;
  readonly goalTitle: string;
};

export type TaskPayload = {
  readonly taskId: string;
  readonly taskTitle: string;
};

export type SleepPayload = SubjectOnly;

export type DailyCloseCompletedPayload = {
  /** Which day, in the profile's zone. */
  readonly closedOn: string;
  /** How many of the Close's fields were filled. §4.0 permits a partial close. */
  readonly fieldsCompleted: number;
  readonly fieldsAvailable: number;
};

/* =========================================================================
 * The registry
 * ====================================================================== */

/**
 * How an event renders on the timeline, and how jobs route it.
 *
 * `category` groups the timeline (§3.2's `?domain=` filter). `significance`
 * decides what a collapsed view shows — a Daily Close is a headline; each
 * individual set inside a workout is detail.
 */
export type EventDescriptor = {
  /** Current payload version for newly emitted events. */
  readonly version: number;
  readonly category: 'body' | 'mind' | 'clinical' | 'media' | 'life' | 'system';
  /** `primary` shows in a collapsed timeline; `detail` only when expanded. */
  readonly significance: 'primary' | 'detail';
  /**
   * Whether this event carries clinical meaning.
   *
   * Read by the Consultation Pack (§2.2) and by the consent layer (§10.10) —
   * clinical events are the ones that must not cross an inference boundary
   * without an explicit grant.
   */
  readonly clinical: boolean;
  /** One line, for `docs/events.md` and for a maintainer in year six. */
  readonly describes: string;
};

/**
 * Payload type per event type.
 *
 * The single source of truth for the mapping. `EventType` is derived from its
 * keys, so a type that is not here cannot be emitted.
 */
export type EventPayloadMap = {
  /* --- Substrate ------------------------------------------------------ */
  'Observation.Recorded': ObservationRecordedPayload;

  /* --- Clinical ------------------------------------------------------- */
  'Medication.Taken': MedicationEventPayload;
  'Medication.Skipped': MedicationEventPayload;
  'Medication.Delayed': MedicationEventPayload;
  'Supplement.Taken': MedicationEventPayload;
  'Appointment.Created': AppointmentPayload;
  'Appointment.Attended': AppointmentPayload;
  'Report.Imported': ReportImportedPayload;

  /* --- Body ----------------------------------------------------------- */
  'Workout.Started': WorkoutStartedPayload;
  'Workout.Completed': WorkoutCompletedPayload;
  'Workout.SetLogged': SetLoggedPayload;
  'Weight.Logged': ObservationRecordedPayload;
  'BodyMeasurement.Recorded': BodyMeasurementPayload;
  'Sleep.Recorded': SleepPayload;
  'SkinRoutine.Completed': SkinRoutinePayload;
  'SkinState.Logged': ObservationRecordedPayload;
  'Meal.Logged': SubjectOnly;

  /* --- Mind ----------------------------------------------------------- */
  'Mood.Logged': ObservationRecordedPayload;
  'Journal.Created': JournalPayload;
  'Journal.Updated': JournalPayload;
  'AnxietyEpisode.Logged': SubjectOnly;
  'Practice.Completed': SubjectOnly;

  /* --- Media and documents -------------------------------------------- */
  'ProgressPhoto.Uploaded': MediaPayload;
  'Media.Uploaded': MediaPayload;
  'Document.Uploaded': DocumentPayload;

  /* --- Life ----------------------------------------------------------- */
  'Goal.Completed': GoalPayload;
  'Task.Completed': TaskPayload;

  /* --- System --------------------------------------------------------- */
  'DailyClose.Completed': DailyCloseCompletedPayload;
};

export type EventType = keyof EventPayloadMap;

/**
 * The descriptor table.
 *
 * `satisfies` rather than a type annotation, so the object literal stays exact
 * and a missing entry is a compile error rather than a runtime `undefined`.
 */
export const EVENT_REGISTRY = {
  'Observation.Recorded': {
    version: 1,
    category: 'system',
    significance: 'detail',
    clinical: false,
    describes: 'A value was written to the observation substrate.',
  },

  'Medication.Taken': {
    version: 1,
    category: 'clinical',
    significance: 'primary',
    clinical: true,
    describes: 'A scheduled dose was taken.',
  },
  'Medication.Skipped': {
    version: 1,
    category: 'clinical',
    significance: 'primary',
    clinical: true,
    describes: 'A scheduled dose was deliberately not taken.',
  },
  'Medication.Delayed': {
    version: 1,
    category: 'clinical',
    significance: 'primary',
    clinical: true,
    describes: 'A dose was taken outside its scheduled window.',
  },
  'Supplement.Taken': {
    version: 1,
    category: 'clinical',
    significance: 'detail',
    clinical: true,
    describes: 'A supplement dose was taken.',
  },
  'Appointment.Created': {
    version: 1,
    category: 'clinical',
    significance: 'primary',
    clinical: true,
    describes: 'A clinical appointment was scheduled.',
  },
  'Appointment.Attended': {
    version: 1,
    category: 'clinical',
    significance: 'primary',
    clinical: true,
    describes: 'A clinical appointment took place.',
  },
  'Report.Imported': {
    version: 1,
    category: 'clinical',
    significance: 'primary',
    clinical: true,
    describes: 'A document was parsed into structured clinical rows.',
  },

  'Workout.Started': {
    version: 1,
    category: 'body',
    significance: 'primary',
    clinical: false,
    describes: 'A training session began.',
  },
  'Workout.Completed': {
    version: 1,
    category: 'body',
    significance: 'primary',
    clinical: false,
    describes: 'A training session ended.',
  },
  'Workout.SetLogged': {
    version: 1,
    category: 'body',
    // Detail: a session of forty sets would otherwise bury everything else on
    // the timeline for that day.
    significance: 'detail',
    clinical: false,
    describes: 'One set was recorded within a session.',
  },
  'Weight.Logged': {
    version: 1,
    category: 'body',
    significance: 'primary',
    clinical: false,
    describes: 'A bodyweight reading was recorded.',
  },
  'BodyMeasurement.Recorded': {
    version: 1,
    category: 'body',
    significance: 'detail',
    clinical: false,
    describes: 'A circumference measurement was recorded.',
  },
  'Sleep.Recorded': {
    version: 1,
    category: 'body',
    significance: 'primary',
    clinical: false,
    describes: 'A night of sleep was recorded.',
  },
  'SkinRoutine.Completed': {
    version: 1,
    category: 'body',
    significance: 'primary',
    clinical: false,
    describes: 'A skincare routine occurrence was completed.',
  },
  'SkinState.Logged': {
    version: 1,
    category: 'body',
    significance: 'primary',
    clinical: true,
    describes: 'A daily skin state was recorded.',
  },
  /**
   * One meal, one entry — the reason this event exists at all.
   *
   * A meal writes around ten observations, and `capture-events.ts` maps each
   * one to a timeline entry unless told otherwise. Without this event and the
   * filter beside it, one breakfast is ten rows on the timeline. `SubjectOnly`
   * for the same reason `Sleep.Recorded` is: the meal row is the system of
   * record and joining to it is one query.
   *
   * Not clinical. A meal is a fact about a day, not about a diagnosis, and
   * §10.7's medical timeline would be unreadable with four entries per day.
   */
  'Meal.Logged': {
    version: 1,
    category: 'body',
    significance: 'primary',
    clinical: false,
    describes: 'A meal was logged.',
  },

  'Mood.Logged': {
    version: 1,
    category: 'mind',
    significance: 'primary',
    // Clinical: §4.7 gives Mind the highest duty of care, and mood belongs in a
    // psychiatric record.
    clinical: true,
    describes: 'A mood, energy, or anxiety level was recorded.',
  },
  'Journal.Created': {
    version: 1,
    category: 'mind',
    significance: 'primary',
    clinical: true,
    describes: 'A journal entry was written.',
  },
  'Journal.Updated': {
    version: 1,
    category: 'mind',
    significance: 'detail',
    clinical: true,
    describes: 'A journal entry was edited.',
  },
  'AnxietyEpisode.Logged': {
    version: 1,
    category: 'mind',
    significance: 'primary',
    clinical: true,
    describes: 'An anxiety episode was recorded.',
  },
  'Practice.Completed': {
    version: 1,
    category: 'mind',
    significance: 'primary',
    clinical: false,
    describes: 'A meditation, breathwork, or grounding session was completed.',
  },

  'ProgressPhoto.Uploaded': {
    version: 1,
    category: 'media',
    significance: 'primary',
    clinical: true,
    describes: 'A protocol-governed progress photograph was captured.',
  },
  'Media.Uploaded': {
    version: 1,
    category: 'media',
    significance: 'detail',
    clinical: false,
    describes: 'A media object was stored.',
  },
  'Document.Uploaded': {
    version: 1,
    category: 'media',
    significance: 'primary',
    clinical: true,
    describes: 'A document was added to the vault.',
  },

  'Goal.Completed': {
    version: 1,
    category: 'life',
    significance: 'primary',
    clinical: false,
    describes: 'A goal reached its target.',
  },
  'Task.Completed': {
    version: 1,
    category: 'life',
    significance: 'detail',
    clinical: false,
    describes: 'A task was completed.',
  },

  'DailyClose.Completed': {
    version: 1,
    category: 'system',
    significance: 'primary',
    clinical: false,
    describes: 'The daily ritual was completed. Feeds the North Star (§1.5).',
  },
} as const satisfies Record<EventType, EventDescriptor>;

export const EVENT_TYPES = Object.keys(EVENT_REGISTRY) as EventType[];

export type EventCategory = EventDescriptor['category'];

export const EVENT_CATEGORIES: readonly EventCategory[] = Object.freeze([
  'body',
  'mind',
  'clinical',
  'media',
  'life',
  'system',
]);

/* -------------------------------------------------------------------------
 * Lookups
 * ---------------------------------------------------------------------- */

export function isEventType(value: unknown): value is EventType {
  return typeof value === 'string' && Object.hasOwn(EVENT_REGISTRY, value);
}

export function describeEvent(type: EventType): EventDescriptor {
  return EVENT_REGISTRY[type];
}

/** The version newly emitted events of this type should carry. */
export function currentVersion(type: EventType): number {
  return EVENT_REGISTRY[type].version;
}

export function eventsInCategory(category: EventCategory): readonly EventType[] {
  return EVENT_TYPES.filter((type) => EVENT_REGISTRY[type].category === category);
}

/**
 * Event types carrying clinical meaning.
 *
 * Consumed by the Consultation Pack (§2.2) and the consent layer (§10.10). A
 * clinical event must not cross an inference boundary without an explicit grant.
 */
export function clinicalEventTypes(): readonly EventType[] {
  return EVENT_TYPES.filter((type) => EVENT_REGISTRY[type].clinical);
}
