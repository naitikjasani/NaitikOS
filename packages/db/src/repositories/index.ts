/**
 * Repositories — the implementations of ports `core` declares (§6.2).
 *
 * Every one is a factory taking a {@link Database}, never a module-level
 * singleton reading an ambient connection. That is what lets a test pass a
 * transaction that rolls back, and what stops a serverless invocation
 * inheriting another request's client.
 */

export { createIdentityRepository, SINGLETON_PROFILE_ID } from './identity.repository';
export { createAuthAuditRecorder, AUTH_ENTITY_TYPE } from './audit.repository';
export type { AuditRecorderOptions } from './audit.repository';
export { createProfileRepository, PREFERENCES_KEY } from './profile.repository';
export type { ProfileRepository } from './profile.repository';

/* --- The event backbone (ADR 0005) ------------------------------------ */
export {
  createEventStore,
  createHandledLedger,
  createDeadLetterSink,
  openDeadLetters,
  latestSequence,
  unknownEventTypes,
} from './event-store.repository';

export { createTimelineRepository, createTimelineProjectionHandler } from './timeline.repository';
export type { TimelineRepository } from './timeline.repository';

/* --- Deferred work and the media outbox (§5.2, §5.7) ------------------- */
export { createTaskRepository } from './task.repository';
export type { TaskRepository, EnqueueTaskInput } from './task.repository';

export { createUploadOutboxRepository } from './upload-outbox.repository';
export type {
  UploadOutboxRepository,
  EnqueueUploadInput,
  OutboxEntry,
  OutboxStatus,
  OutboxHealth,
} from './upload-outbox.repository';

/* --- The nightly run's completion record (§5.16) ----------------------- */
export {
  createJobRunRecorder,
  lastJobRun,
  hasCompletedRunSince,
  abandonedJobRuns,
  NIGHTLY_JOB_NAME,
} from './job-run.repository';

/* --- Observability, in our own Postgres (§5.11 — no vendor) ------------ */
export {
  createObservability,
  createConsoleLogger,
  createPostgresMetrics,
  createLoggingTracer,
  createErrorReporter,
  createAuditHook,
} from './observability.repository';
export type { ObservabilityOptions } from './observability.repository';
