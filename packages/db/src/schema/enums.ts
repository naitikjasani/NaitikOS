/**
 * Enumerated vocabularies.
 *
 * ## Why Postgres enums rather than text plus a check constraint
 *
 * The record has to be self-describing in year fifteen (P2). A native enum type
 * is introspectable — `\dT+` tells a future reader every legal value, without
 * the application, without this file. A `text` column with a check constraint
 * hides the same information inside a predicate, and a lookup table turns every
 * read into a join for a set that changes roughly never.
 *
 * The cost is real and worth stating: adding a value is a migration, and
 * removing one is close to impossible. That asymmetry is a feature here.
 * Widening a vocabulary should be a deliberate, reviewed act, because these are
 * the words the twenty-year record is written in.
 *
 * ## erasableSyntaxOnly
 *
 * The tsconfig forbids TypeScript `enum` (base.json). The union types below are
 * derived from the Drizzle definition with `(typeof x.enumValues)[number]`, so
 * there is exactly one declaration of each vocabulary and TypeScript follows the
 * database rather than duplicating it.
 */

import { pgEnum } from 'drizzle-orm/pg-core';

/* =========================================================================
 * Identity and authorization (§5.4)
 * ====================================================================== */

/**
 * Application roles. Mirrors `ROLES` in `@naitikos/core/auth/roles`.
 *
 * The permission matrix deliberately lives in `core`, not here: §5.4 places
 * authorization "in the API layer where it is testable, readable, and
 * version-controlled" and warns that encoding domain rules in the database is
 * "a maintenance trap at C2 horizons". This enum is only the vocabulary — the
 * database stores which role an identity has, never what that role may do.
 *
 * `auth_identity_role_matches_core` in the contract test fails if the two lists
 * drift.
 */
export const appRole = pgEnum('app_role', ['owner', 'clinician', 'delegate', 'service']);

/**
 * How an identity authenticated. Mirrors `AUTH_STRATEGIES` in core.
 *
 * Recorded rather than enforced. §5.4 prefers passkey and magic link; the
 * current build enables password only, and storing the strategy per sign-in is
 * what will make "when did this account last use the weaker factor?" answerable
 * once the others are turned on.
 */
export const authStrategy = pgEnum('auth_strategy', [
  'password',
  'magic_link',
  'passkey',
  'oauth_google',
]);

/* =========================================================================
 * The substrate (§9.2)
 * ====================================================================== */

/**
 * Where a fact came from. §9.2: "Provenance is mandatory, not optional."
 *
 * The ordering is roughly descending trust, and the distinctions carry real
 * weight: "A derived value must be distinguishable from a measured one forever,
 * and a model-inferred value must be distinguishable from both."
 */
export const sourceKind = pgEnum('source_kind', [
  /** The user typed it. */
  'manual',
  /** Batch import from a wearable or health platform (§2.3). */
  'device_import',
  /** Computed by the nightly derivation job from other observations. */
  'derivation',
  /** Extracted from a document — a lab PDF, a prescription (§9.9). */
  'document_extraction',
  /** Produced by a model. Never a number the system relies on (P4). */
  'model_inference',
]);

/** The shape of a metric's value, so the registry can validate on write. */
export const metricValueType = pgEnum('metric_value_type', [
  'numeric',
  'integer',
  'boolean',
  'text',
  /** Seconds. Stored numeric; this type tells the UI to render as duration. */
  'duration',
  /** One of a small fixed set, defined per metric in `metric.allowedValues`. */
  'categorical',
]);

/**
 * How a metric aggregates over a period — §9.2 lists sum, mean, last, max.
 *
 * This is not cosmetic. Summing bodyweight over a week is nonsense and
 * averaging training volume hides a taper; the registry is what stops a chart
 * from doing either.
 */
export const aggregation = pgEnum('aggregation', ['sum', 'mean', 'median', 'last', 'min', 'max', 'count']);

/** Which pillar a metric or entity belongs to (§3.2). */
export const domain = pgEnum('domain', [
  'body',
  'mind',
  'work',
  'money',
  'life',
  /** Cross-cutting: sleep, and anything that refuses to sit in one pillar. */
  'system',
]);

/* =========================================================================
 * Medical (§9.2, §9.5)
 * ====================================================================== */

/** Subtype discriminator for the `medical_event` supertype. */
export const medicalEventType = pgEnum('medical_event_type', [
  'condition',
  'medication',
  'medication_schedule',
  'lab_panel',
  'appointment',
  'procedure',
  'treatment_course',
  'side_effect',
  'symptom',
]);

export const conditionStatus = pgEnum('condition_status', [
  'suspected',
  'active',
  'remission',
  'resolved',
  /** Recorded, then withdrawn — the diagnosis was wrong. Not a deletion (§9.4). */
  'refuted',
]);

export const severity = pgEnum('severity', ['mild', 'moderate', 'severe']);

export const medicationForm = pgEnum('medication_form', [
  'tablet',
  'capsule',
  'liquid',
  'topical',
  'injection',
  'inhaler',
  'drops',
  'patch',
  'other',
]);

/**
 * Adherence event. Feeds the MVP's only insight family (§2.1).
 *
 * `skipped` and `delayed` are distinct from an absent row on purpose: a missing
 * record means "unknown", and conflating that with "did not take it" would make
 * every adherence figure quietly wrong on the days the user forgot to log.
 */
export const medicationEventKind = pgEnum('medication_event_kind', ['taken', 'skipped', 'delayed']);

/**
 * Why a medication was stopped. §9.2 calls this out specifically — "and,
 * importantly, the *reason* for stopping" — because it is the field that makes
 * "what have I already tried, and why did it end?" answerable a decade later.
 */
export const medicationStopReason = pgEnum('medication_stop_reason', [
  'course_completed',
  'ineffective',
  'side_effects',
  'switched',
  'prescriber_advice',
  'self_discontinued',
  'unavailable',
  'other',
]);

/**
 * Lab result flag **as printed on the report**.
 *
 * §9.2: "Reference ranges are stored per result, not looked up — ranges vary by
 * laboratory and change over time, and a 2027 result compared against a 2035
 * range is a clinical error." The same reasoning applies to the flag: record
 * what the lab said, not what a recomputation says today.
 */
export const labFlag = pgEnum('lab_flag', [
  'normal',
  'low',
  'high',
  'critical_low',
  'critical_high',
  'abnormal',
  'indeterminate',
]);

export const treatmentOutcome = pgEnum('treatment_outcome', [
  'resolved',
  'improved',
  'no_change',
  'worsened',
  'discontinued',
  'ongoing',
]);

/* =========================================================================
 * Body (§4.1, §4.2, §9.2)
 * ====================================================================== */

/** The operator's three affected regions (§4.2), plus room to grow. */
export const bodyRegion = pgEnum('body_region', [
  'face',
  'chest',
  'back',
  'shoulders',
  'arms',
  'neck',
  'other',
]);

export const workoutSetKind = pgEnum('workout_set_kind', [
  'working',
  'warmup',
  'drop',
  'failure',
  'backoff',
  'amrap',
]);

/** Broad movement classification, for volume analysis by muscle group (§4.1). */
export const muscleGroup = pgEnum('muscle_group', [
  'chest',
  'back',
  'shoulders',
  'biceps',
  'triceps',
  'forearms',
  'quads',
  'hamstrings',
  'glutes',
  'calves',
  'core',
  'full_body',
]);

export const exerciseMechanic = pgEnum('exercise_mechanic', ['compound', 'isolation']);

export const equipmentKind = pgEnum('equipment_kind', [
  'barbell',
  'dumbbell',
  'machine',
  'cable',
  'bodyweight',
  'kettlebell',
  'band',
  'other',
]);

/**
 * The generic routine engine (§9.2) — "One implementation, three consumers".
 * Skincare AM/PM, dental hygiene, and supplements all use the same tables.
 */
export const routineKind = pgEnum('routine_kind', ['skincare', 'dental', 'supplement', 'other']);

export const routinePeriod = pgEnum('routine_period', ['am', 'pm', 'midday', 'as_needed']);

export const routineStepStatus = pgEnum('routine_step_status', ['done', 'skipped', 'partial']);

/** Product register lifecycle — introduction and discontinuation dates (§4.2). */
export const productEventKind = pgEnum('product_event_kind', [
  'introduced',
  'discontinued',
  'repurchased',
  'reaction',
  'finished',
]);

/* =========================================================================
 * Nutrition (§4.3)
 * ====================================================================== */

/**
 * Where a food's protein comes from.
 *
 * §4.3 asks for "vegetarian-plus-eggs protein-source analysis", and §4.2 has
 * Skin reading "dairy, sugar, whey". Under P3 those are cross-domain questions
 * asked through the metric vocabulary, which means the split has to be
 * *computable* — so each food carries its class, and a meal's protein is
 * apportioned across the `nutrition.protein.from_*` keys on write.
 *
 * It lives on `food` rather than `food_version` because a reformulation does
 * not turn paneer into an egg. The column is nullable on purpose: a food nobody
 * has classified reports as unclassified rather than being silently attributed
 * to whichever bucket happens to be first.
 */
/**
 * How a meal reached the log — §4.3's capture tiers.
 *
 * Stored on the meal rather than emitted as telemetry because §5.11's
 * `app_event` is deliberately anaemic: names and numbers, no dimensions. The
 * tier is also a fact about the meal in its own right — "this was a template
 * tap" is the kind of thing worth knowing in year three, and telemetry is
 * discarded after ninety days.
 *
 * Nullable, because every meal written before this column existed was captured
 * somehow and this system does not invent an answer for them (P5).
 */
export const mealCaptureTier = pgEnum('meal_capture_tier', [
  /** One tap on a saved meal. */
  'template',
  /** Taps on ranked food tiles, quantities already defaulted. */
  'suggestion',
  /** A typed line resolved against the library. */
  'parsed',
  /** Entered or edited by hand. The tier the ten-second rule does not cover. */
  'manual',
]);

export const proteinSource = pgEnum('protein_source', [
  'dairy',
  'egg',
  'legume',
  /** Whey, casein, plant isolates. §4.2 names whey specifically. */
  'supplement',
  /** Grains, nuts, seeds, vegetables — the remainder, named honestly. */
  'grain_other',
]);

/* =========================================================================
 * Predictions and the Life Timeline (§10.8, §10.9)
 * ====================================================================== */

/**
 * What a prediction may be about.
 *
 * §10.9 lists exactly four permitted subjects and one prohibition: "Permitted:
 * goal trajectory, bodyweight projection under current intake, next-session
 * load progression, adherence-risk flagging. **Prohibited: any prediction
 * about a clinical outcome, a symptom course, or a medication response.**"
 *
 * The enum is the structural half of that. There is no `clinical_outcome`
 * member and no `symptom_course` member, so a prohibited prediction has no
 * kind to be written under — §10.10's "unrepresentable harmful output" applied
 * to a column.
 */
export const predictionKind = pgEnum('prediction_kind', [
  'goal_trajectory',
  'bodyweight_projection',
  'load_progression',
  'adherence_risk',
]);

/**
 * How a prediction was arrived at.
 *
 * §10.9: "Classical, interpretable methods only... **No machine learning.**
 * n=1 with a few hundred observations per metric is not a machine-learning
 * problem; it is a statistics problem." Every member here is a method whose
 * output a person can check by hand, which is the property that makes the
 * prohibition enforceable rather than aspirational.
 */
export const predictionMethod = pgEnum('prediction_method', [
  'linear_trend',
  'loess_trend',
  'seasonal_decomposition',
  'adherence_state_model',
]);

/** An era is a life phase; a chapter is a job, a relocation, a relationship. */
export const lifeSpanKind = pgEnum('life_span_kind', ['era', 'chapter']);

/* =========================================================================
 * Money (§4.9)
 * ====================================================================== */

export const accountKind = pgEnum('account_kind', [
  'current',
  'savings',
  'credit_card',
  'investment',
  'loan',
  'cash',
  'wallet',
  'other',
]);

/**
 * Spending categories.
 *
 * A closed, deliberately short list. §4.9 says the cross-domain linkage is
 * "thinner than the others" but that "where it does link, it links well —
 * supplement and skincare spend against outcomes, food spend against nutrition
 * quality". Those three are the reason this vocabulary exists, and they are
 * named separately rather than folded into a `health` bucket precisely so the
 * join is possible.
 *
 * Everything else is coarse on purpose. A forty-category taxonomy is a finance
 * product's feature and §13's finding 12 rules out competing there; a category
 * the operator has to think about before choosing is a category that gets
 * chosen inconsistently, which makes every total built from it a lie.
 */
export const spendCategory = pgEnum('spend_category', [
  'groceries',
  'eating_out',
  /** §4.9's "supplement spend against outcomes". Separate from `health`. */
  'supplements',
  /** §4.9's "skincare spend against outcomes". Separate from `health`. */
  'skincare',
  'health',
  'fitness',
  'rent',
  'utilities',
  'transport',
  'subscriptions',
  'shopping',
  'travel',
  'education',
  'gifts',
  'fees',
  'income',
  'transfer',
  'other',
]);

export const budgetPeriod = pgEnum('budget_period', ['weekly', 'monthly', 'quarterly', 'annual']);

export const subscriptionCadence = pgEnum('subscription_cadence', [
  'weekly',
  'monthly',
  'quarterly',
  'annual',
]);

/**
 * Where a shopping item is in its life.
 *
 * `dropped` is a first-class outcome for the same reason `abandoned` is on a
 * learning item: a list that can only be bought from accumulates things the
 * operator no longer wants, and a list like that stops being opened.
 */
export const shoppingStatus = pgEnum('shopping_status', ['wanted', 'purchased', 'dropped']);

/* =========================================================================
 * Sleep (§4.6)
 * ====================================================================== */

/**
 * What disturbed a night.
 *
 * A closed vocabulary rather than free text, because the point of recording it
 * is to count it — "how many of my bad nights were the neighbours" is a
 * question a text column cannot answer. `disturbance_note` carries the detail;
 * this carries the category.
 *
 * `pain` and `anxiety` are both here and both matter clinically: §4.7 reads
 * sleep against anxiety episodes, and a night broken by anxiety is a different
 * fact from one broken by noise even when the duration is identical.
 */
export const sleepDisturbance = pgEnum('sleep_disturbance', [
  'noise',
  'light',
  'temperature',
  'pain',
  'anxiety',
  'bathroom',
  'illness',
  'device',
  'other',
]);

/* =========================================================================
 * Work (§4.8)
 * ====================================================================== */

/**
 * §4.8 is emphatic that Tasks are "deliberately minimal. Not a competitor to a
 * dedicated task manager." So the status vocabulary is three states plus a
 * tombstone-adjacent one, and there is no `in_progress`, no priority ladder, no
 * sub-status. A richer vocabulary would be an invitation to run one's actual
 * work here, which §4.8 declines.
 */
/*
 * `work_task_status`, not `task_status`. §9's event log already owns a
 * `task_status` for `deferred_task`'s pending/running/succeeded lifecycle, and
 * the collision is not merely cosmetic: drizzle-kit saw the name in its
 * snapshot, emitted no CREATE TYPE, and produced a migration that failed on
 * `invalid input value for enum task_status: "open"`. At the TypeScript level a
 * second `export const taskStatus` would have been an ambiguous re-export from
 * the schema barrel, which ESM resolves by exporting neither — silently.
 */
export const workTaskStatus = pgEnum('work_task_status', ['open', 'done', 'dropped']);

export const projectStatus = pgEnum('project_status', [
  'active',
  'shipped',
  'paused',
  'abandoned',
]);

/**
 * What kind of thing a career-log line records.
 *
 * §4.8: "reconstructing a year of work at review time from memory. Every
 * shipped thing gets one line on the day it ships." The kinds are the ones a
 * performance review actually asks for, which is why `feedback` — the hardest
 * to reconstruct and the easiest to lose — is its own kind rather than a note.
 */
export const careerEntryKind = pgEnum('career_entry_kind', [
  'shipped',
  'artifact',
  'feedback',
  'recognition',
  'review',
  'role_change',
  'incident',
]);

export const learningKind = pgEnum('learning_kind', [
  'book',
  'paper',
  'course',
  'talk',
  'article',
  'other',
]);

/**
 * `abandoned` is a first-class outcome, not a failure state. A queue that can
 * only be finished is a queue that quietly accumulates guilt, and §4.8 wants
 * the *linkage* — what was learned, and for what — not a completion rate.
 */
export const learningStatus = pgEnum('learning_status', [
  'queued',
  'in_progress',
  'finished',
  'abandoned',
]);

/**
 * Where a calendar event came from. §4.8 puts calendar at "read-only import in
 * V3", so `manual` exists for the one case the import cannot cover: an event
 * the operator knows about that never reached a calendar.
 */
export const calendarSource = pgEnum('calendar_source', ['ics', 'google', 'manual']);

/* =========================================================================
 * Media and the photography protocol (§9.8)
 * ====================================================================== */

export const mediaKind = pgEnum('media_kind', ['image', 'video', 'audio', 'pdf', 'other']);

/**
 * Storage sensitivity tier (§5.5). Determines whether an object is
 * client-side encrypted before upload.
 *
 * `sensitive` means the provider holds ciphertext it cannot read — skin photos,
 * physique photos, medical imaging, journal attachments.
 */
export const storageTier = pgEnum('storage_tier', ['public', 'private', 'sensitive']);

/**
 * Capture-protocol vocabularies (§9.8).
 *
 * §4.2 is blunt about why these exist: photographs taken under inconsistent
 * conditions "are not merely lower quality — they are *actively misleading*,
 * because apparent change is dominated by capture variance rather than skin
 * change."
 */
export const captureDistance = pgEnum('capture_distance', ['close', 'medium', 'full']);

export const captureLighting = pgEnum('capture_lighting', [
  'daylight_indirect',
  'daylight_direct',
  'artificial_warm',
  'artificial_cool',
  'mixed',
  'unknown',
]);

export const captureTimeBucket = pgEnum('capture_time_bucket', [
  'early_morning',
  'morning',
  'midday',
  'afternoon',
  'evening',
  'night',
]);

export const flashState = pgEnum('flash_state', ['on', 'off', 'auto_fired', 'auto_not_fired']);

/* =========================================================================
 * Mind (§4.7)
 * ====================================================================== */

export const practiceKind = pgEnum('practice_kind', [
  'meditation',
  'breathwork',
  'grounding',
  'journaling',
  'other',
]);

/* =========================================================================
 * Cross-cutting (§9.2)
 * ====================================================================== */

export const goalStatus = pgEnum('goal_status', [
  'active',
  'achieved',
  'abandoned',
  'paused',
  /** Kept for "goal archaeology" (§4.10) — why did this stop mattering? */
  'superseded',
]);

/** What the user did with a surfaced finding. Dismissals train the ranking (§4.13). */
export const insightDisposition = pgEnum('insight_disposition', [
  'new',
  'seen',
  'acted_on',
  'dismissed',
  'archived',
]);

export const reviewKind = pgEnum('review_kind', ['weekly', 'monthly', 'quarterly', 'annual']);

/**
 * §4.12: "A review the user did not edit is a review they did not do, and the
 * system should treat an unedited draft as incomplete rather than as a
 * completed review."
 */
export const reviewState = pgEnum('review_state', ['drafted', 'editing', 'complete']);

export const documentKind = pgEnum('document_kind', [
  'prescription',
  'lab_report',
  'imaging',
  'discharge_summary',
  'insurance',
  'receipt',
  'identity',
  'other',
]);

export const extractionMethod = pgEnum('extraction_method', ['ocr', 'model', 'manual', 'native_text']);

/* =========================================================================
 * AI (§10)
 * ====================================================================== */

/**
 * What a model call was for. Every call is logged (§9.2 `ai_interaction`):
 * "Complete auditability of everything the AI layer has ever done is a
 * requirement, not a nicety."
 */
export const aiPurpose = pgEnum('ai_purpose', [
  'narration',
  'parsing',
  'classification',
  'embedding',
  'ask',
  'review_draft',
  'extraction',
]);

/**
 * Consent scope for data crossing an inference boundary (§10.10, P7).
 *
 * These are ordered by sensitivity, and `journal` is separate from everything
 * else because §4.7 classifies journal content as the most sensitive data in
 * the system. Nothing crosses without an explicit per-scope grant.
 */
export const consentScope = pgEnum('consent_scope', [
  'none',
  'aggregates_only',
  'non_clinical',
  'clinical',
  'journal',
]);

export const graphNodeKind = pgEnum('graph_node_kind', [
  'entity',
  'concept',
  'event',
  'metric',
  'person',
  'place',
]);

/* =========================================================================
 * Operations (§9.4, §5.11)
 * ====================================================================== */

/** Audit operations. `purge` is the only path that ever removes data (§9.4). */
export const auditOperation = pgEnum('audit_operation', [
  'insert',
  'update',
  'soft_delete',
  'restore',
  'purge',
]);

export const jobStatus = pgEnum('job_status', ['pending', 'running', 'succeeded', 'failed', 'skipped']);

/* =========================================================================
 * Derived TypeScript unions
 *
 * One declaration per vocabulary: the database defines it, TypeScript follows.
 * ====================================================================== */

export type AppRole = (typeof appRole.enumValues)[number];
export type AuthStrategyValue = (typeof authStrategy.enumValues)[number];
export type SourceKind = (typeof sourceKind.enumValues)[number];
export type MetricValueType = (typeof metricValueType.enumValues)[number];
export type Aggregation = (typeof aggregation.enumValues)[number];
export type Domain = (typeof domain.enumValues)[number];
export type MedicalEventType = (typeof medicalEventType.enumValues)[number];
export type ConditionStatus = (typeof conditionStatus.enumValues)[number];
export type Severity = (typeof severity.enumValues)[number];
export type MedicationForm = (typeof medicationForm.enumValues)[number];
export type MedicationEventKind = (typeof medicationEventKind.enumValues)[number];
export type MedicationStopReason = (typeof medicationStopReason.enumValues)[number];
export type LabFlag = (typeof labFlag.enumValues)[number];
export type TreatmentOutcome = (typeof treatmentOutcome.enumValues)[number];
export type BodyRegion = (typeof bodyRegion.enumValues)[number];
export type WorkoutSetKind = (typeof workoutSetKind.enumValues)[number];
export type MuscleGroup = (typeof muscleGroup.enumValues)[number];
export type ExerciseMechanic = (typeof exerciseMechanic.enumValues)[number];
export type EquipmentKind = (typeof equipmentKind.enumValues)[number];
export type RoutineKind = (typeof routineKind.enumValues)[number];
export type RoutinePeriod = (typeof routinePeriod.enumValues)[number];
export type RoutineStepStatus = (typeof routineStepStatus.enumValues)[number];
export type ProductEventKind = (typeof productEventKind.enumValues)[number];
export type ProteinSource = (typeof proteinSource.enumValues)[number];
export type MealCaptureTier = (typeof mealCaptureTier.enumValues)[number];
export type PredictionKind = (typeof predictionKind.enumValues)[number];
export type PredictionMethod = (typeof predictionMethod.enumValues)[number];
export type LifeSpanKind = (typeof lifeSpanKind.enumValues)[number];
export type AccountKind = (typeof accountKind.enumValues)[number];
export type SpendCategory = (typeof spendCategory.enumValues)[number];
export type BudgetPeriod = (typeof budgetPeriod.enumValues)[number];
export type SubscriptionCadence = (typeof subscriptionCadence.enumValues)[number];
export type ShoppingStatus = (typeof shoppingStatus.enumValues)[number];
export type SleepDisturbance = (typeof sleepDisturbance.enumValues)[number];
export type WorkTaskStatus = (typeof workTaskStatus.enumValues)[number];
export type ProjectStatus = (typeof projectStatus.enumValues)[number];
export type CareerEntryKind = (typeof careerEntryKind.enumValues)[number];
export type LearningKind = (typeof learningKind.enumValues)[number];
export type LearningStatus = (typeof learningStatus.enumValues)[number];
export type CalendarSource = (typeof calendarSource.enumValues)[number];
export type MediaKind = (typeof mediaKind.enumValues)[number];
export type StorageTier = (typeof storageTier.enumValues)[number];
export type CaptureDistance = (typeof captureDistance.enumValues)[number];
export type CaptureLighting = (typeof captureLighting.enumValues)[number];
export type CaptureTimeBucket = (typeof captureTimeBucket.enumValues)[number];
export type FlashState = (typeof flashState.enumValues)[number];
export type PracticeKind = (typeof practiceKind.enumValues)[number];
export type GoalStatus = (typeof goalStatus.enumValues)[number];
export type InsightDisposition = (typeof insightDisposition.enumValues)[number];
export type ReviewKind = (typeof reviewKind.enumValues)[number];
export type ReviewState = (typeof reviewState.enumValues)[number];
export type DocumentKind = (typeof documentKind.enumValues)[number];
export type ExtractionMethod = (typeof extractionMethod.enumValues)[number];
export type AiPurpose = (typeof aiPurpose.enumValues)[number];
export type ConsentScope = (typeof consentScope.enumValues)[number];
export type GraphNodeKind = (typeof graphNodeKind.enumValues)[number];
export type AuditOperation = (typeof auditOperation.enumValues)[number];
export type JobStatus = (typeof jobStatus.enumValues)[number];
