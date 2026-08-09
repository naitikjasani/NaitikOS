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
