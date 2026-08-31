/**
 * @naitikos/core — the durable layer.
 *
 * Blueprint §5.0:
 *
 *   "Domain logic must be able to compile and run with zero framework imports.
 *    ...it is the only part of the system intended to survive two decades."
 *
 * The framework ban is enforced mechanically by `boundaries/external`
 * (packages/config/eslint/boundaries.js) and, before that, by this package's
 * package.json simply not declaring React, Next, Drizzle, or Supabase.
 *
 * Subdirectories are populated per the roadmap (§12). Each carries a README
 * stating what it owns.
 */

export type {
  DomainError,
  DomainErrorKind,
  ValidationError,
  NotFoundError,
  ConflictError,
  PreconditionFailedError,
  UnauthenticatedError,
  ForbiddenError,
} from './errors/domain-error';

export {
  validationError,
  notFoundError,
  conflictError,
  preconditionFailedError,
  unauthenticatedError,
  forbiddenError,
  isDomainError,
  isAuthError,
  isRetryable,
} from './errors/domain-error';

/** The clock — the one sanctioned reader of wall time (§11.3). */
export type { Clock } from './temporal/clock';
export { systemClock, fixedClock, manualClock } from './temporal/clock';

/** Instant parsing and calendar arithmetic — the sanctioned `Date` parse (§11.3). */
export {
  parseInstant,
  parseSqlTimestamp,
  utcNoonOn,
  utcNoonAt,
  addUtcDays,
  utcDayKey,
  utcDaysBetween,
  dayKeyIndex,
  shiftDayKey,
  isoWeekday,
  isoFromMillis,
  isoAfterSeconds,
} from './temporal/instant';

/** IANA zone validation and local-day boundaries (§5.3). */
export { isIanaZone, zonedDayStart, zonedDayBounds } from './temporal/zone';

/** Identity, authentication, authorization (§5.4). */
export * from './auth';

/* -------------------------------------------------------------------------
 * Units — §6.2's "no path by which milligrams become micrograms".
 * ---------------------------------------------------------------------- */
export type { Decimal, RoundingMode, FormatOptions, QuantityFitFailure } from './units/decimal';
export {
  DECIMAL_ZERO,
  DECIMAL_ONE,
  QUANTITY_SCALE,
  QUANTITY_PRECISION,
  parseDecimal,
  decimalFromInteger,
  decimalFromUnscaled,
  formatDecimal,
  compareDecimal,
  isZero,
  signOf,
  minDecimal,
  maxDecimal,
  addDecimal,
  subtractDecimal,
  multiplyDecimal,
  negateDecimal,
  absDecimal,
  divideDecimal,
  roundDecimal,
  checkQuantityFit,
  toQuantityString,
} from './units/decimal';

export type { Dimension, UnitCode, UnitDefinition, Quantity, Analyte } from './units/quantity';
export {
  UNITS,
  UNIT_CODES,
  MOLAR_MASSES,
  isUnitCode,
  unitDefinition,
  quantity,
  dimensionOf,
  formatQuantity,
  convertQuantity,
  convertTemperatureDelta,
  convertConcentration,
  compareQuantity,
  roundQuantity,
} from './units/quantity';

/* -------------------------------------------------------------------------
 * The observation substrate (§9.1, §9.2) — the spine of the record.
 * ---------------------------------------------------------------------- */
export type {
  MetricKey,
  MetricValueType,
  MetricAggregation,
  MetricDomain,
  MetricDefinition,
  MetricRegistry,
} from './observations/metric';
export {
  METRIC_VALUE_TYPES,
  METRIC_AGGREGATIONS,
  METRIC_DOMAINS,
  DAILY_CLOSE_ELEMENT_BUDGET,
  createMetricRegistry,
} from './observations/metric';

export { MVP_METRICS, DAILY_CLOSE_METRICS } from './observations/mvp-metrics';

export type {
  ObservationId,
  ObservationSourceId,
  SourceKind,
  ObservationSource,
  ObservationSubject,
  Observation,
  Supersession,
  ObservationValueInput,
  ObservationInput,
} from './observations/observation';
export { SOURCE_KINDS, TEXT_VALUE_PLACEHOLDER } from './observations/observation';

export type { Hlc, HlcState, HlcTick, ClockAnomaly } from './observations/hlc';
export {
  MAX_CLOCK_DRIFT_MS,
  nodeIdFrom,
  initialHlcState,
  formatHlc,
  parseHlc,
  compareHlc,
  hlcTick,
  hlcReceive,
  clockSkewMs,
} from './observations/hlc';

export type { NormalisedValue, ObservationWriteContext, PreparedWrite, DecodedValue } from './observations/write';
export { normaliseValue, prepareObservations, decodeValue, isTapScale } from './observations/write';

/* -------------------------------------------------------------------------
 * The Daily Close (§4.0) — the ritual the whole product is built around.
 * ---------------------------------------------------------------------- */
export type { CloseControl, CloseField, CloseMedication, CloseForm } from './close/form';
export { buildCloseForm, medicationHeadroom } from './close/form';

export type {
  CloseAnswer,
  CloseSubmission,
  ExistingObservation,
  ExistingMedicationEvent,
  ExistingCloseState,
  ClosePlanContext,
  MedicationEventWrite,
  NoteWrite,
  ClosePlan,
} from './close/plan';
export {
  CLOSE_COMPLETION_METRIC,
  CLOSE_REVISION_REASON,
  resolveObservedAt,
  planDailyClose,
  isEmptyPlan,
} from './close/plan';

/* -------------------------------------------------------------------------
 * Statistics (§6.2) — trends and moving averages. Drawn, never stored.
 * ---------------------------------------------------------------------- */
export type { DailyValue, DailyEstimate, DailyBand } from './statistics/types';
export type { MovingAverageOptions, TrendSummary } from './statistics/moving-average';
export {
  DEFAULT_TREND_WINDOW_DAYS,
  collapseByDay,
  movingAverage,
  summariseTrend,
} from './statistics/moving-average';

export type { LinearFit, ProjectedPoint } from './statistics/trend';
export {
  TREND_CAVEAT,
  MIN_TREND_POINTS,
  MAX_PROJECTION_DAYS,
  linearTrend,
  trendBand,
  projectForward,
} from './statistics/trend';

/* -------------------------------------------------------------------------
 * Derivation (§6.2) — observations in, derived facts out.
 * ---------------------------------------------------------------------- */
export type { RollupOptions } from './derivation/rollup';
export { aggregate, dailyRollup } from './derivation/rollup';

/* -------------------------------------------------------------------------
 * Gym (§4.1) — the first full domain.
 * ---------------------------------------------------------------------- */
export type {
  MuscleGroup,
  ExerciseMechanic,
  EquipmentKind,
  WorkoutSetKind,
  Exercise,
} from './domain/gym/exercise';
export {
  MUSCLE_GROUPS,
  MUSCLE_GROUP_LABELS,
  EQUIPMENT_KINDS,
  WORKOUT_SET_KINDS,
  VOLUME_BEARING_KINDS,
  countsTowardsVolume,
  exerciseSlug,
  scoreExerciseMatch,
  searchExercises,
} from './domain/gym/exercise';

export type {
  WorkoutSession,
  WorkoutSet,
  SetSide,
  SetLogInput,
  SetLogContext,
  PlannedSet,
  SessionCloseContext,
  SessionClosePlan,
} from './domain/gym/session';
export {
  GYM_METRICS,
  SET_SUBJECT_TYPE,
  SESSION_SUBJECT_TYPE,
  MAX_REPS,
  MAX_REST_SECONDS,
  RPE_STEP,
  MIN_RPE,
  MAX_RPE,
  planSetLog,
  sessionDurationMinutes,
  planSessionClose,
} from './domain/gym/session';

export type { VolumeExclusion, SetVolume, SessionVolume, ExerciseLookup } from './domain/gym/volume';
export {
  SECONDARY_MUSCLE_SHARE,
  effectiveLoad,
  setVolume,
  sessionVolume,
  volumeByMuscle,
  setsByMuscle,
} from './domain/gym/volume';

export type {
  PersonalRecordKind,
  ExerciseBest,
  RecordCandidate,
  RecordVerdict,
} from './domain/gym/records';
export {
  MAX_ESTIMABLE_REPS,
  NO_HISTORY,
  NO_RECORD,
  RECORD_LABELS,
  estimateOneRepMax,
  bestFrom,
  detectRecords,
  relativeStrength,
} from './domain/gym/records';

export type { HistoricalSet, SetPrefill, ProgressionPoint } from './domain/gym/progression';
export {
  EMPTY_PREFILL,
  lastSessionFor,
  prefillFor,
  progressionBySession,
  progressionSeries,
} from './domain/gym/progression';

export type {
  Program,
  ProgramBlock,
  PrescribedExercise,
  AdherenceWindow,
  ProgramAdherence,
} from './domain/gym/program';
export { parsePrescription, programAdherence, nextBlock } from './domain/gym/program';

/* -------------------------------------------------------------------------
 * Mind (§4.7) — the module with the highest duty of care.
 * ---------------------------------------------------------------------- */
export type { MindScaleId, MindScale, ScaleDirection, ScaleTone, Movement } from './domain/mind/scales';
export {
  MIND_METRICS,
  MIND_SCALE_IDS,
  MIND_SCALES,
  MOVEMENT_THRESHOLD,
  MIN_MOVEMENT_DAYS,
  scaleLabel,
  toneFor,
  describeMovement,
} from './domain/mind/scales';

export type {
  EpisodeSeverity,
  AnxietyEpisode,
  EpisodeInput,
  PlannedEpisode,
  EpisodeSummary,
} from './domain/mind/episode';
export {
  EPISODE_SUBJECT_TYPE,
  MAX_EPISODE_MINUTES,
  severityFor,
  episodeDurationMinutes,
  planEpisode,
  summariseEpisodes,
} from './domain/mind/episode';

export type { JournalConsent, JournalEntry, JournalEntryInput, JournalListItem, JournalPrompt } from './domain/mind/journal';
export {
  JOURNAL_CONSENT_SCOPES,
  MAX_JOURNAL_CHARACTERS,
  planJournalEntry,
  wordCount,
  journalListItem,
  promptForDay,
} from './domain/mind/journal';

export type { PracticeKind, PracticeSession, PracticeInput, PlannedPractice } from './domain/mind/practice';
export {
  PRACTICE_KINDS,
  PRACTICE_KIND_LABELS,
  PRACTICE_METRICS,
  PRACTICE_SUBJECT_TYPE,
  MAX_PRACTICE_MINUTES,
  isPracticeKind,
  practiceDelta,
  planPractice,
} from './domain/mind/practice';

export type { CrisisContact, CrisisPlan, CrisisSurface, CrisisEvaluation } from './domain/mind/crisis';
export {
  CRISIS_CONSECUTIVE_DAYS,
  SEVERE_ANXIETY,
  SEVERE_LOW_MOOD,
  parseContacts,
  evaluateCrisisState,
  crisisSurface,
  shouldInvitePlanning,
} from './domain/mind/crisis';

/* -------------------------------------------------------------------------
 * Medication (§4.4, §4.7) — Health owns it, Mind reads it.
 * ---------------------------------------------------------------------- */
export type {
  Medication,
  MedicationSchedule,
  MedicationEvent,
  MedicationEventKind,
  DayAdherence,
  WindowAdherence,
  MedicationAnnotation,
  MedicationAnnotationKind,
} from './domain/medication/adherence';
export {
  ADHERENCE_METRIC,
  medicationLabel,
  expectedDosesPerDay,
  scheduleOn,
  dayAdherence,
  windowAdherence,
  medicationAnnotations,
  adherenceValue,
} from './domain/medication/adherence';

/* -------------------------------------------------------------------------
 * The routine engine (§9.2) — one implementation, three consumers.
 * ---------------------------------------------------------------------- */
export type {
  RoutineKind,
  RoutinePeriod,
  RoutineStepStatus,
  Routine,
  RoutineStep,
  RoutineLog,
  DayRoutineAdherence,
  RoutineWindowAdherence,
} from './domain/routine/adherence';
export {
  ROUTINE_ADHERENCE_METRIC,
  ROUTINE_KINDS,
  ROUTINE_PERIODS,
  ROUTINE_PERIOD_LABELS,
  requiredSteps,
  dayAdherence as routineDayAdherence,
  windowAdherence as routineWindowAdherence,
  windowDayKeys,
  isRoutineDue,
} from './domain/routine/adherence';

/* -------------------------------------------------------------------------
 * Skin (§4.2) — the protocol is the module.
 * ---------------------------------------------------------------------- */
export type {
  BodyRegion,
  SkinState,
  SkinRegionState,
  SkinStateInput,
  SkinRegionInput,
  ExistingSkinObservation,
  PlannedSkinState,
  RegionTrend,
} from './domain/skin/state';
export {
  SKIN_METRICS,
  SKIN_REVISION_REASON,
  SKIN_STATE_SUBJECT_TYPE,
  SKIN_REGION_SUBJECT_TYPE,
  BODY_REGIONS,
  TRACKED_REGIONS,
  REGION_LABELS,
  SKIN_STATE_LABELS,
  MAX_LESION_COUNT,
  isBodyRegion,
  planSkinState,
  regionTrends,
} from './domain/skin/state';

export type {
  ProductEventKind,
  ProductSeverity,
  SkincareProduct,
  ProductEvent,
  UsePeriod,
  Reaction,
  ProductChange,
} from './domain/skin/product';
export {
  PRODUCT_EVENT_KINDS,
  CHANGE_WINDOW_DAYS,
  productLabel,
  isActiveOn,
  usePeriods,
  daysSinceIntroduction,
  reactionHistory,
  changesBefore,
} from './domain/skin/product';

export type {
  CaptureDistance,
  CaptureLighting,
  CaptureTimeBucket,
  FlashState,
  SeriesPhoto,
  CheckStatus,
  ProtocolCheck,
  CaptureCandidate,
  ProtocolVerdict,
} from './domain/skin/protocol';
export {
  CAPTURE_DISTANCES,
  CAPTURE_LIGHTING,
  CAPTURE_TIME_BUCKETS,
  FLASH_STATES,
  LIGHTING_LABELS,
  DISTANCE_LABELS,
  RECOMMENDED,
  LUMINANCE_TOLERANCE,
  COMPLIANCE_THRESHOLD,
  seriesKey,
  alignmentReferenceFor,
  timeBucketFor,
  evaluateProtocol,
  toProtocolBlock,
  comparablePhotos,
} from './domain/skin/protocol';

/* -------------------------------------------------------------------------
 * Health core (§4.4) — vitals, labs, conditions, symptoms, appointments.
 * ---------------------------------------------------------------------- */
export type { AnalyteDefinition, CanonicalFailure, CanonicalValue } from './domain/health/analyte';
export {
  ANALYTES,
  LAB_METRIC_PREFIX,
  analyteBySlug,
  analyteFor,
  analyteForMetricKey,
  foldAnalyteName,
  labMetricKey,
  normaliseUnit,
  toCanonical,
} from './domain/health/analyte';

export type {
  LabFlag,
  FlagSource,
  EffectiveFlag,
  PrintedRange,
  RangedResult,
  RangeShift,
} from './domain/health/reference-range';
export {
  LAB_FLAGS,
  LAB_FLAG_LABELS,
  RANGE_CAVEAT,
  classifyAgainstRange,
  describeRange,
  effectiveFlag,
  formatMeasured,
  isCritical,
  isOutOfRange,
  rangeShifts,
} from './domain/health/reference-range';

export type { VitalKind, VitalObservation, VitalReading, VitalReadingInput } from './domain/health/vitals';
export {
  VITAL_METRICS,
  VITAL_LABELS,
  VITAL_READING_SUBJECT_TYPE,
  formatBloodPressure,
  pairReadings,
  planVitalReading,
} from './domain/health/vitals';

export type { Condition, ConditionInput, ConditionStatus } from './domain/health/condition';
export {
  CONDITION_STATUSES,
  CONDITION_STATUS_LABELS,
  CONDITION_STATUS_NOTES,
  activeOn,
  believedAt,
  currentConditions,
  describeOnset,
  isConditionStatus,
  validateCondition,
} from './domain/health/condition';

export type { Severity, Symptom, SymptomInput, PlannedSymptom } from './domain/health/symptom';
export {
  MAX_SYMPTOM_INTENSITY,
  MIN_SYMPTOM_INTENSITY,
  SEVERITIES,
  SEVERITY_LABELS,
  SYMPTOM_METRIC,
  SYMPTOM_SUBJECT_TYPE,
  openSymptoms,
  planSymptom,
  symptomDurationMinutes,
  symptomFrequency,
} from './domain/health/symptom';

export type { SideEffect, SideEffectInput } from './domain/health/side-effect';
export { ongoing, unreported, validateSideEffect } from './domain/health/side-effect';

export type {
  AdherenceHighlight,
  Appointment,
  AppointmentQuestion,
  ConditionHighlight,
  DerivedQuestions,
  LabHighlight,
  QuestionInput,
  QuestionSource,
  SideEffectHighlight,
  SymptomHighlight,
} from './domain/health/appointment';
export {
  ADHERENCE_MENTION_THRESHOLD,
  MAX_QUESTIONS,
  SUSPECTED_STALE_DAYS,
  SYMPTOM_RECURRENCE_THRESHOLD,
  awaitingNotes,
  deriveQuestions,
  describeWhen,
  formatDay,
  mergeQuestions,
  nextAppointment,
} from './domain/health/appointment';

export { HEALTH_METRICS } from './domain/health/metrics';

/* -------------------------------------------------------------------------
 * Nutrition (§4.3) — the ten-second rule, and the vocabulary behind it.
 * ---------------------------------------------------------------------- */
export type { NutrientDefinition, NutrientCanonicalFailure, NutrientCanonicalResult, ProteinSource } from './domain/nutrition/nutrient';
export {
  NUTRIENTS,
  NUTRIENT_TO_ANALYTE,
  NUTRITION_METRIC_PREFIX,
  PROTEIN_SOURCES,
  PROTEIN_SOURCE_LABELS,
  foldNutrientName,
  fromInternationalUnits,
  normaliseNutrientUnit,
  nutrientByKey,
  nutrientFor,
  nutrientForMetricKey,
  nutritionMetricKey,
  proteinSourceMetricKey,
  toCanonicalNutrient,
  toInternationalUnits,
} from './domain/nutrition/nutrient';

export { NUTRITION_METRICS } from './domain/nutrition/metrics';

export type { Food, FoodNutrient, FoodSearchResult, FoodVersion } from './domain/nutrition/food';
export { currentFoodVersion, foodLabel, scoreFoodMatch, searchFoods, versionAt } from './domain/nutrition/food';

export type {
  FoodVersionFacts,
  MealItemFacts,
  MealTotals,
  NutrientRow,
  NutrientTotal,
  ProteinSplit,
  UnresolvedItem,
} from './domain/nutrition/nutrients';
export { PSEUDO_UNITS, basisMultiple, isPseudoUnit, mealTotals, proteinBySource } from './domain/nutrition/nutrients';

export type { FoodUsage, MealSlot, SuggestOptions, Suggestion, TemplateUsage } from './domain/nutrition/ranking';
export {
  DEFAULT_SLOTS,
  HALF_LIFE_DAYS,
  MAX_SUGGESTIONS,
  MAX_TEMPLATE_SUGGESTIONS,
  rankTemplates,
  slotForLocalTime,
  suggestFoods,
} from './domain/nutrition/ranking';

export type { LoggedItem, MealTemplate, ResolvedItem, ResolvedTemplate, TemplateItem } from './domain/nutrition/template';
export {
  MIN_MEALS_FOR_DRIFT,
  parseTemplateItems,
  resolveTemplate,
  templateDrift,
  templateFromMeal,
} from './domain/nutrition/template';

export type { NutritionTarget, TargetEvaluation, TargetStatus } from './domain/nutrition/targets';
export { TARGET_STATUS_LABELS, activeTargets, evaluateTargets, phaseFor } from './domain/nutrition/targets';

export type { LabelField, ParsedLabel, ParsedMeal, ParsedMealItem } from './domain/nutrition/parser';
export {
  LABEL_REVIEW_FLOOR,
  MAX_PARSE_CONFIDENCE,
  MIN_FOOD_MATCH_SCORE,
  matchNutrientLabel,
  parseMealText,
  parseNutritionLabel,
} from './domain/nutrition/parser';

/* -------------------------------------------------------------------------
 * Teeth (§4.5) — FDI notation and per-tooth history. Reuses the routine engine.
 * ---------------------------------------------------------------------- */
export type { Quadrant, Tooth, ToothNotation, ToothPosition, DentalProcedure, ProcedureInput } from './domain/teeth/tooth';
export { ARCHES, byTooth, parseTooth, toothLabel, totalCost } from './domain/teeth/tooth';

/* -------------------------------------------------------------------------
 * Goals (§4.10) — a declaration plus a projection. No progress data of its own.
 * ---------------------------------------------------------------------- */
export type { Goal, GoalInput, GoalComparator, GoalStatus, GoalTarget, GoalTargetInput } from './domain/goal/target';
export {
  GOAL_COMPARATORS,
  GOAL_STATUSES,
  GOAL_STATUS_LABELS,
  MIN_RATE_WINDOW_DAYS,
  describeTarget,
  isGoalComparator,
  validateGoal,
  validateTarget,
} from './domain/goal/target';

export type { GoalProgress, ProgressInput, ProgressStatus } from './domain/goal/progress';
export {
  MAX_ARRIVAL_DAYS,
  PROGRESS_STATUS_LABELS,
  deriveProgress,
  explainProgress,
  projectedArrival,
} from './domain/goal/progress';

/* --- Work (§4.8) ------------------------------------------------------- */

export type { Task, TaskInput, TaskStatus, TaskBucketKey, TaskBuckets } from './domain/work/task';
export {
  SOON_DAYS,
  STALE_TASK_DAYS,
  TASK_BUCKET_LABELS,
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  bucketTasks,
  closedPerDay,
  isTaskStatus,
  staleTasks,
  validateTask,
} from './domain/work/task';

export type {
  CareerEntry,
  CareerEntryInput,
  CareerEntryKind,
  CareerPeriod,
  SkillTally,
} from './domain/work/career';
export {
  CAREER_ENTRY_KINDS,
  CAREER_GAP_DAYS,
  CAREER_KIND_LABELS,
  isCareerEntryKind,
  loggingGap,
  summarisePeriod,
  validateCareerEntry,
} from './domain/work/career';

export type { WorkProject, WorkProjectInput, ProjectStanding, ProjectStatus } from './domain/work/project';
export {
  PROJECT_STATUSES,
  PROJECT_STATUS_LABELS,
  isProjectStatus,
  projectStanding,
  validateProject,
} from './domain/work/project';

export type { LearningItem, LearningItemInput, LearningKind, LearningStatus, SkillCrossover } from './domain/work/learning';
export {
  DEFAULT_UNIT_LABEL,
  LEARNING_KINDS,
  LEARNING_KIND_LABELS,
  LEARNING_STATUSES,
  LEARNING_STATUS_LABELS,
  describeProgress,
  isLearningKind,
  isLearningStatus,
  learningProgress,
  queueOrder,
  skillCrossover,
  validateLearningItem,
} from './domain/work/learning';

export type { LoadDay, LoadEvent, LoadSession } from './domain/work/load';
export {
  HEAVY_MEETING_MINUTES,
  bestFocusDays,
  dailyLoad,
  meanOver,
  minutesBetween,
  withinWindow,
} from './domain/work/load';

export type { FocusSession, FocusSessionInput, HourBand } from './domain/work/focus';
export {
  MIN_FOCUS_MINUTES,
  busiestHours,
  focusByHour,
  totalFocusMinutes,
  validateFocusSession,
} from './domain/work/focus';

export type { IcsEvent, IcsParse } from './domain/work/ics';
export { TRAVEL_WORDS, looksLikeTravel, parseIcs, parseIcsInstant } from './domain/work/ics';


export type { GoalTension, TensionKind } from './domain/goal/tension';
export { ANTAGONISTIC_PAIRS, detectTensions } from './domain/goal/tension';

export type { ProgressSnapshot } from './domain/goal/snapshot';
export { planSnapshot, snapshotDrift } from './domain/goal/snapshot';

/* -------------------------------------------------------------------------
 * Documents (§4.11, §9.9) — the vault, and the extraction pipeline.
 * ---------------------------------------------------------------------- */
export type {
  CandidateLabResult,
  ConfirmationDecision,
  ConfirmedResult,
  DocumentExtraction,
  ExtractedField,
  ExtractionMethod,
  ParsedLabReport,
} from './domain/document/extraction';
export {
  EXTRACTION_METHODS,
  IMPLEMENTED_METHODS,
  MAX_EXTRACTION_CONFIDENCE,
  REVIEW_FLOOR,
  confirmCandidates,
  isPreAccepted,
  overallConfidence,
} from './domain/document/extraction';

export {
  MIN_LABEL_COVERAGE,
  PARSER_ENGINE,
  PARSER_VERSION,
  findCollectionDate,
  matchAnalyteLabel,
  parseLabReport,
} from './domain/document/lab-parser';

export type { DocumentKind, VaultDocument, DocumentInput } from './domain/document/vault';
export {
  DOCUMENT_KINDS,
  DOCUMENT_KIND_LABELS,
  documentTier,
  expiringSoon,
  validateDocument,
} from './domain/document/vault';

/* -------------------------------------------------------------------------
 * Sleep (§4.6) — a night is an entity; consistency is why.
 * ---------------------------------------------------------------------- */
export type { SleepNight, SleepNightInput, SleepDisturbance } from './domain/sleep/night';
export {
  SLEEP_DISTURBANCES,
  SLEEP_DISTURBANCE_LABELS,
  describeNight,
  sleepEfficiency,
  timeInBedHours,
  validateSleepNight,
} from './domain/sleep/night';

export type { NightPoint, ConsistencyReport, SleepDebt } from './domain/sleep/consistency';
export {
  MIN_CONSISTENCY_NIGHTS,
  consistencyOver,
  sleepDebt,
  sleepMidpointMinutes,
} from './domain/sleep/consistency';

/* -------------------------------------------------------------------------
 * Detectors (§10.6) — stage 1, deterministic. No model involvement.
 * ---------------------------------------------------------------------- */
export { logGamma, logChoose, binomialTailBelow } from './statistics/binomial';
export type { PairedSample, DailyPair, Correlation, LaggedCorrelation } from './statistics/correlation';
export {
  MIN_CORRELATION_N,
  spearman,
  bestLaggedCorrelation,
  pairOnDayKey,
} from './statistics/correlation';

export type { FdrResult } from './statistics/fdr';
export { DEFAULT_ALPHA, benjaminiHochberg } from './statistics/fdr';

export type {
  DetectorId,
  FindingConfidence,
  FindingEvidence,
  Finding,
  InsufficientData,
  DetectorOutcome,
} from './detectors/types';
export { EMPTY_OUTCOME, findingId } from './detectors/types';

export type { AdherenceDay, AdherenceSeries, AdherenceOptions } from './detectors/adherence';
export {
  MIN_RECORDED_DAYS,
  MIN_BASELINE_UNITS,
  RECENT_WINDOW_DAYS,
  detectAdherence,
} from './detectors/adherence';

export type { StreakDay, StreakSeries } from './detectors/streak';
export { MIN_STREAK_DAYS, BREAK_REPORT_WINDOW_DAYS, detectStreak } from './detectors/streak';

export type {
  BaselineState,
  PreRegisteredHypothesis,
  BatteryInput,
  BatteryOutcome,
} from './detectors/battery';
export { BASELINE_DAYS, PRE_REGISTERED, CORRELATION_PAIRS, baselineState, runBattery } from './detectors/battery';

/* -------------------------------------------------------------------------
 * The Consultation Pack (§10.7) — V2's highest-value deliverable.
 * ---------------------------------------------------------------------- */
export type {
  PackSpecialty,
  PackSection,
  PackConditionRow,
  PackMedicationRow,
  PackLabRow,
  PackSymptomRow,
  PackTreatmentRow,
  ConsultationPackDocument,
} from './domain/health/consultation-pack';
export {
  PACK_SPECIALTIES,
  PACK_SECTIONS,
  PACK_SECTION_TITLES,
  PACK_LIMITATION,
  specialtyFor,
  isRelevantTo,
  orderSection,
  leadCount,
  adherenceNote,
  sideEffectLeads,
} from './domain/health/consultation-pack';

/* -------------------------------------------------------------------------
 * The knowledge graph (§10.2) — association and precedence, never cause.
 * ---------------------------------------------------------------------- */
export type {
  EdgeType,
  EdgeOrigin,
  EdgeStatistics,
  GraphEdge,
  EdgeRejection,
  EdgeResult,
} from './graph/edges';
export { EDGE_TYPES, PERMITTED_ORIGINS, edgeOriginFor, buildEdge, edgeKey } from './graph/edges';

export type { StoredEdge, Reconciliation } from './graph/reconcile';
export {
  EDGE_RETENTION_WEIGHT,
  UNSUPPORTED_NIGHTS_BEFORE_REMOVAL,
  reconcileEdges,
  edgesForCorrelation,
} from './graph/reconcile';

export type { CorrelationPair, MetricSeries, CorrelationInput } from './detectors/correlation';
export {
  MAX_LAG_DAYS,
  MIN_PAIRED_OBSERVATIONS,
  MIN_REPORTABLE_RHO,
  DOES_NOT_PROVE,
  detectCorrelation,
} from './detectors/correlation';

/* -------------------------------------------------------------------------
 * Validation (§1.4, §1.5, §12 V1) — the metrics that protect the metrics.
 * ---------------------------------------------------------------------- */
export type { Distribution, MetricStatus, BudgetedMetric, TimedEvent, CompletionFunnel, GamingVerdict, MealTier } from './validation/metrics';
export {
  EMPTY_DISTRIBUTION,
  CAPTURE_LATENCY_BUDGET_MS,
  TIME_IN_APP_CEILING_MINUTES,
  CORRECTION_RATE_CEILING,
  DERIVED_FACT_TARGET,
  SESSION_GAP_MINUTES,
  NUTRITION_LOG_BUDGET_MS,
  MEAL_TIERS,
  ASSISTED_TIER_FLOOR,
  distributionOf,
  mealLogLatency,
  mealTierMix,
  captureLatency,
  timeInApp,
  correctionRate,
  derivedFactRatio,
  foregroundMinutesByDay,
  closeFunnel,
  detectGaming,
} from './validation/metrics';

export type { GateVerdict, GateEvaluation } from './validation/gate';
export {
  GATE_WINDOW_DAYS,
  GATE_REQUIRED_DAYS,
  VALIDATION_START_DAY,
  VALIDATION_END_DAY,
  evaluateGate,
  gateWindowDays,
} from './validation/gate';

/* -------------------------------------------------------------------------
 * Domain events (ADR 0005) — an integration log, not a system of record.
 * ---------------------------------------------------------------------- */
export type {
  EventId,
  CorrelationId,
  EventSequence,
  EventSource,
  EventSubject,
  EventMetadata,
  DomainEvent,
  UnsequencedEvent,
  EventDraft,
} from './events/envelope';
export { EVENT_SOURCES, isEventSource, compareEvents } from './events/envelope';

export type {
  EventType,
  EventCategory,
  EventDescriptor,
  EventPayloadMap,
} from './events/registry';
export {
  EVENT_REGISTRY,
  EVENT_TYPES,
  EVENT_CATEGORIES,
  isEventType,
  describeEvent,
  currentVersion,
  eventsInCategory,
  clinicalEventTypes,
} from './events/registry';

export { validateEventPayload, payloadSpecFor, allPayloadSpecs } from './events/validate';
export type { Upcaster } from './events/migrate';
export { UPCASTERS, upcast, upcastWith, upcastAll } from './events/migrate';

export type {
  EventStore,
  EventHandler,
  DeadLetterSink,
  DeadLetterEntry,
  HandledLedger,
  BusDependencies,
  EventBus,
  PublishResult,
  ReplayOptions,
  ReplaySummary,
} from './events/bus';
export { createEventBus } from './events/bus';

/* --- Timeline --------------------------------------------------------- */
export type {
  TimelineEntry,
  TimelineLink,
  TimelineMedia,
  TimelineQuery,
  TimelineGrouping,
  TimelineGroup,
  TimelinePage,
} from './timeline/types';
export { TIMELINE_PAGE_SIZE, TIMELINE_MAX_PAGE_SIZE, normaliseQuery } from './timeline/types';
export { projectEvent, projectEvents, renderedEventTypes } from './timeline/project';
export {
  dayKeyInZone,
  hourInZone,
  minuteInZone,
  weekKeyInZone,
  monthKeyInZone,
  groupEntries,
  emptyDaysInRange,
} from './timeline/grouping';

/* --- Media and storage ------------------------------------------------ */
export type {
  StorageTier,
  StorageKey,
  UploadRequest,
  UploadResult,
  SignedUrl,
  StorageProvider,
} from './media/storage';
export {
  PRIVATE_URL_TTL_SECONDS,
  SENSITIVE_URL_TTL_SECONDS,
  BUCKET_FOR_TIER,
  urlTtlForTier,
} from './media/storage';

export type { StorageKeyInput } from './media/keys';
export {
  buildStorageKey,
  thumbnailKey,
  isThumbnailKey,
  tierFromKey,
  contentHashFromKey,
} from './media/keys';

export type {
  MediaMetadata,
  MediaHashes,
  CaptureProtocol,
  Thumbnail,
  ProcessedMedia,
  MetadataExtractor,
  Hasher,
  Compressor,
  Thumbnailer,
  Encryptor,
  TextExtractor,
  VisionAnalyser,
  PipelineStages,
  PipelineOptions,
  DuplicateVerdict,
  DedupeCandidate,
} from './media/pipeline';
export {
  DEFAULT_LONG_EDGE,
  DEFAULT_THUMBNAIL_SIZES,
  MAX_OBJECT_BYTES,
  PERCEPTUAL_DUPLICATE_THRESHOLD,
  runPipeline,
  hammingDistance,
  classifyDuplicate,
} from './media/pipeline';

/* --- Background jobs (§5.2: one scheduled entry point) ---------------- */
export type {
  JobStepName,
  JobStep,
  JobStepContext,
  JobStepOutcome,
  TaskKind,
  DeferredTask,
  JobRunSummary,
  JobRunRecorder,
  RunnerDependencies,
} from './jobs/registry';
export {
  JOB_STEPS,
  TASK_KINDS,
  TASK_MAX_ATTEMPTS,
  DEFAULT_RUN_BUDGET_MS,
  backoffSeconds,
  runNightly,
} from './jobs/registry';

/* --- Observability (§5.11, §5.13) ------------------------------------- */
export type {
  LogLevel,
  LogContext,
  Logger,
  MetricName,
  MetricDimensions,
  Metrics,
  Span,
  Tracer,
  ErrorReport,
  ErrorReporter,
  AuditHook,
  Observability,
} from './observability/ports';
export { METRIC_NAMES, createNoopObservability } from './observability/ports';

/* -------------------------------------------------------------------------
 * Export (§9.10) — the P2 obligation.
 * ---------------------------------------------------------------------- */
export type { ZipEntry, ZipFailure } from './export/zip';
export { MAX_ARCHIVE_BYTES, MAX_ARCHIVE_ENTRIES, crc32, buildZip } from './export/zip';

export type { ExportTable, ExportMedia, ExportInput, ExportManifest, ExportBundle } from './export/bundle';
export {
  EXPORT_FORMAT_VERSION,
  toNdjson,
  buildSchemaDocument,
  buildReadme,
  buildDecryptionGuide,
  buildExportBundle,
} from './export/bundle';

/* --- Reviews (§4.12) --- */
export type { ReviewKind, ReviewState, ReviewPeriod } from './domain/review/period';
export {
  REVIEW_KINDS,
  REVIEW_KIND_LABELS,
  REVIEW_STATES,
  isReviewKind,
  isReviewState,
  periodContaining,
  previousPeriod,
  isPeriodClosed,
  recentPeriods,
} from './domain/review/period';

export type { ReviewInputs, DraftSection, ReviewDraft } from './domain/review/draft';
export {
  REVIEW_PROMPTS,
  EMPTY_RECORD_HEADING,
  assembleDraft,
  draftToMarkdown,
  isReviewComplete,
} from './domain/review/draft';
