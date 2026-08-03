/**
 * Body — Gym, Composition, Skin, and the shared routine engine (§4.1–4.6, §9.2).
 *
 * Two structural decisions in this file are worth reading before changing
 * anything.
 *
 * **Sets are entities, set values are observations.** A `workout_set` row holds
 * the structure — which exercise, which order, what kind of set. The load and
 * the reps are also written as observations against `gym.set.load` and
 * `gym.set.reps` with the set as their subject. That looks like duplication and
 * is not: P3 requires that Skin can query training volume "without knowing Gym
 * exists", and it can only do that through the metric vocabulary.
 *
 * **One routine engine, three consumers.** §9.2: skincare, dental hygiene and
 * supplements all run on `routine` / `routine_step` / `routine_log`, because
 * "the alternative is three near-identical adherence systems."
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import {
  bodyRegion,
  equipmentKind,
  exerciseMechanic,
  muscleGroup,
  productEventKind,
  routineKind,
  routinePeriod,
  routineStepStatus,
  severity,
  workoutSetKind,
} from './enums';
import {
  entityColumns,
  ianaZone,
  instant,
  primaryKey,
  quantity,
  reference,
  rowTimestamps,
} from './columns';

/* =========================================================================
 * Gym (§4.1)
 * ====================================================================== */

/**
 * The exercise library — canonical definitions, seeded (§3.2 `/library/exercises`).
 *
 * Trigram-indexed on name because §9.6 calls for "fuzzy food/exercise lookup"
 * with typo tolerance. Under fatigue, mid-session, an exact-match search box is
 * a P1 violation.
 */
export const exercise = pgTable(
  'exercise',
  {
    ...entityColumns,

    name: text().notNull(),
    slug: text().notNull(),
    /** `Bench Press` also answers to `BP`, `Barbell Bench`. Aids fuzzy lookup. */
    aliases: jsonb().notNull().default(sql`'[]'::jsonb`),

    primaryMuscle: muscleGroup().notNull(),
    secondaryMuscles: jsonb().notNull().default(sql`'[]'::jsonb`),
    mechanic: exerciseMechanic(),
    equipment: equipmentKind(),

    /** Whether load includes bodyweight — changes relative-strength maths. */
    isBodyweight: boolean().notNull().default(false),
    /** Unilateral movements log per-side; volume must not double-count. */
    isUnilateral: boolean().notNull().default(false),

    instructions: text(),
    /** User-authored cues that actually work for them. */
    formNotes: text(),
  },
  (t) => [
    uniqueIndex('exercise_slug_unique').on(t.slug),
    index('exercise_muscle_idx').on(t.primaryMuscle).where(sql`${t.deletedAt} IS NULL`),
    index('exercise_name_trgm_idx').using('gin', sql`${t.name} gin_trgm_ops`),
  ],
);

/** A training program — the plan a session is measured against (§4.1). */
export const program = pgTable(
  'program',
  {
    ...entityColumns,
    name: text().notNull(),
    description: text(),
    startedAt: instant(),
    endedAt: instant(),
    isActive: boolean().notNull().default(false),
    /** Sessions per week the program intends. Adherence is measured against this. */
    targetFrequency: integer(),
  },
  (t) => [
    uniqueIndex('program_one_active')
      .on(t.isActive)
      .where(sql`${t.isActive} IS TRUE AND ${t.deletedAt} IS NULL`),
  ],
);

/** A block within a program — `Push A`, `Week 3 Deload`. */
export const programBlock = pgTable(
  'program_block',
  {
    ...entityColumns,
    programId: reference()
      .notNull()
      .references(() => program.id),
    name: text().notNull(),
    orderIndex: integer().notNull(),
    /** `[{ exerciseId, sets, repRange, targetRpe }]` — the prescription. */
    prescription: jsonb().notNull().default(sql`'[]'::jsonb`),
    notes: text(),
  },
  (t) => [
    index('program_block_program_idx').on(t.programId, t.orderIndex),
    uniqueIndex('program_block_order_unique').on(t.programId, t.orderIndex),
  ],
);

/** A training session. */
export const workoutSession = pgTable(
  'workout_session',
  {
    ...entityColumns,

    programId: reference().references(() => program.id),
    programBlockId: reference().references(() => programBlock.id),

    startedAt: instant().notNull(),
    endedAt: instant(),
    zone: ianaZone().notNull(),

    title: text(),
    location: text(),
    /** How it felt, 1–5. Also written as an observation for cross-domain work. */
    perceivedEffort: integer(),
    notes: text(),

    /** Bodyweight at session time, for relative-strength calculation (§4.1). */
    bodyweightAtSession: quantity(),
  },
  (t) => [
    index('workout_session_started_idx').on(t.startedAt.desc()),
    index('workout_session_program_idx').on(t.programId, t.startedAt.desc()),
    check('workout_session_ordered', sql`${t.endedAt} IS NULL OR ${t.startedAt} <= ${t.endedAt}`),
  ],
);

/**
 * A single set.
 *
 * §4.1's design note governs how this is read, not just written: "the logger
 * must default to *last session's numbers* for the same exercise, so the
 * primary interaction is confirming or nudging rather than typing." The
 * `(exerciseId, performedAt DESC)` index below is what makes that prefill a
 * single fast lookup on the P1 hot path.
 */
export const workoutSet = pgTable(
  'workout_set',
  {
    ...entityColumns,

    sessionId: reference()
      .notNull()
      .references(() => workoutSession.id),
    exerciseId: reference()
      .notNull()
      .references(() => exercise.id),

    /** Position within the session. */
    orderIndex: integer().notNull(),
    kind: workoutSetKind().notNull().default('working'),

    load: quantity(),
    loadUnit: text().notNull().default('kg'),
    reps: integer(),
    /** Rate of perceived exertion, 1–10, half-points allowed. */
    rpe: quantity(),
    /** Seconds. */
    restSeconds: integer(),

    /** Groups sets performed together. Same value = same superset. */
    supersetGroup: integer(),
    /** Which side, for unilateral movements. `left` / `right` / null. */
    side: text(),

    performedAt: instant().notNull(),
    isPersonalRecord: boolean().notNull().default(false),
    notes: text(),
  },
  (t) => [
    index('workout_set_session_idx').on(t.sessionId, t.orderIndex),
    /* Last-session prefill (§4.1) and per-exercise progression. */
    index('workout_set_exercise_idx').on(t.exerciseId, t.performedAt.desc()),
    index('workout_set_pr_idx')
      .on(t.exerciseId, t.performedAt.desc())
      .where(sql`${t.isPersonalRecord} IS TRUE`),
    uniqueIndex('workout_set_order_unique').on(t.sessionId, t.orderIndex),
  ],
);

/* =========================================================================
 * Composition (§4.6)
 * ====================================================================== */

/**
 * Circumference measurements — "distinct from bodyweight which is a plain
 * observation" (§9.2).
 *
 * Bodyweight is a single scalar with one meaning, so it is an observation. A
 * measurement session produces several values at once and needs the sitting to
 * be grouped, which is internal structure.
 */
export const bodyMeasurement = pgTable(
  'body_measurement',
  {
    ...entityColumns,

    measuredAt: instant().notNull(),
    zone: ianaZone().notNull(),

    site: text().notNull(),
    value: quantity().notNull(),
    unit: text().notNull().default('cm'),
    side: text(),
    notes: text(),
  },
  (t) => [index('body_measurement_site_idx').on(t.site, t.measuredAt.desc())],
);

/* =========================================================================
 * Skin (§4.2)
 * ====================================================================== */

/**
 * The daily skin log — one row per day, with per-region detail alongside.
 *
 * Overall state is here; `skin_region_state` carries face, chest and back
 * separately, because §4.2 tracks "the operator's three affected regions" and
 * an aggregate score hides a chest flare during a good face week.
 */
export const skinState = pgTable(
  'skin_state',
  {
    ...entityColumns,

    observedOn: text().notNull(),
    zone: ianaZone().notNull(),

    /** 1–5 overall. Also written as an observation against `body.skin.state`. */
    overallState: integer(),
    /** Free-text note — what the user noticed. */
    note: text(),

    /** Flare annotation with a suspected trigger (§4.2). Suspected, not asserted. */
    isFlare: boolean().notNull().default(false),
    suspectedTrigger: text(),
  },
  (t) => [uniqueIndex('skin_state_day_unique').on(t.observedOn)],
);

/**
 * Per-region state.
 *
 * Active lesions are counted separately from scarring because §4.2 requires
 * "scar tracking as distinct from active lesions" — they respond to different
 * things on different timescales, and summing them produces a number that
 * improves and worsens for unrelated reasons.
 */
export const skinRegionState = pgTable(
  'skin_region_state',
  {
    ...entityColumns,

    skinStateId: reference()
      .notNull()
      .references(() => skinState.id),
    region: bodyRegion().notNull(),

    /** 1–5. */
    state: integer(),
    severity: severity(),
    activeLesionCount: integer(),
    scarringLevel: integer(),

    inflammation: integer(),
    dryness: integer(),
    oiliness: integer(),
    note: text(),
  },
  (t) => [uniqueIndex('skin_region_state_unique').on(t.skinStateId, t.region)],
);

/**
 * The product register (§4.2).
 *
 * Introduction and discontinuation dates live on {@link productEvent} rather
 * than here, because §4.2's payoff question — "my chest acne worsened three
 * weeks after starting that moisturiser" — needs the *events*, not a current
 * state. A product introduced, dropped, and reintroduced has three events and
 * one row.
 */
export const skincareProduct = pgTable(
  'skincare_product',
  {
    ...entityColumns,

    name: text().notNull(),
    brand: text(),
    category: text(),
    /** Key actives — retinoid, niacinamide. Enables the V3 conflict check (§4.2). */
    keyIngredients: jsonb().notNull().default(sql`'[]'::jsonb`),
    fullIngredients: text(),

    /** Whether it is in the current routine. Derived, cached for the hot path. */
    isActive: boolean().notNull().default(false),
    notes: text(),
  },
  (t) => [index('skincare_product_name_trgm_idx').using('gin', sql`${t.name} gin_trgm_ops`)],
);

/** Lifecycle and reaction events for a product. */
export const productEvent = pgTable(
  'product_event',
  {
    ...entityColumns,

    productId: reference()
      .notNull()
      .references(() => skincareProduct.id),
    kind: productEventKind().notNull(),

    occurredAt: instant().notNull(),
    zone: ianaZone(),

    /** For `reaction` events. Never asserted as causal (P5). */
    reactionDescription: text(),
    reactionSeverity: severity(),
    note: text(),
  },
  (t) => [
    index('product_event_product_idx').on(t.productId, t.occurredAt.desc()),
    index('product_event_kind_idx').on(t.kind, t.occurredAt.desc()),
  ],
);

/* =========================================================================
 * The routine engine (§9.2) — skincare, dental, supplements
 * ====================================================================== */

/**
 * A routine definition. One implementation, three consumers.
 *
 * §9.2: "A generic routine engine reused by skincare, dental hygiene, and
 * supplements. One implementation, three consumers — the alternative is three
 * near-identical adherence systems."
 */
export const routine = pgTable(
  'routine',
  {
    ...entityColumns,

    kind: routineKind().notNull(),
    period: routinePeriod().notNull(),
    name: text().notNull(),
    isActive: boolean().notNull().default(true),
    /** Local time the routine is expected, for the reminder (§5.9). */
    expectedAt: text(),
  },
  (t) => [
    index('routine_active_idx')
      .on(t.kind, t.period)
      .where(sql`${t.isActive} IS TRUE AND ${t.deletedAt} IS NULL`),
  ],
);

/** An ordered step within a routine. */
export const routineStep = pgTable(
  'routine_step',
  {
    ...entityColumns,

    routineId: reference()
      .notNull()
      .references(() => routine.id),
    orderIndex: integer().notNull(),

    label: text().notNull(),
    /** Set when the step is applying a registered product. */
    productId: reference().references(() => skincareProduct.id),
    /** Set when the step is taking a registered medication or supplement. */
    medicationId: reference(),

    /** Steps that are nice-to-have do not count against adherence. */
    isOptional: boolean().notNull().default(false),
    instructions: text(),
  },
  (t) => [uniqueIndex('routine_step_order_unique').on(t.routineId, t.orderIndex)],
);

/**
 * A routine completion record. The adherence substrate.
 *
 * One row per step per occurrence. `partial` exists because §4.0's reasoning
 * about the Daily Close applies here too: a system that only accepts complete
 * records trains the user to log nothing on a bad day, and bad days are the
 * clinically interesting ones.
 */
export const routineLog = pgTable(
  'routine_log',
  {
    id: primaryKey(),
    ...rowTimestamps,

    routineId: reference()
      .notNull()
      .references(() => routine.id),
    stepId: reference().references(() => routineStep.id),

    /** The day this occurrence belongs to, in the profile's zone. */
    occurredOn: text().notNull(),
    completedAt: instant(),
    zone: ianaZone(),

    status: routineStepStatus().notNull(),
    note: text(),
  },
  (t) => [
    index('routine_log_routine_idx').on(t.routineId, t.occurredOn),
    uniqueIndex('routine_log_unique').on(t.routineId, t.stepId, t.occurredOn),
  ],
);
