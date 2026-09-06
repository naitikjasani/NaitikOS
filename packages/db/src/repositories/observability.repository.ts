/**
 * Observability, backed by the project's own Postgres.
 *
 * ## "No vendor lock-in" here means no vendor
 *
 * §5.11: "**No third-party analytics. Ever.** (P7.) … An `app_event` table in the
 * same Postgres … Event names and numeric measurements only. **No payloads,
 * ever.** The schema cannot represent user content, which makes leakage impossible
 * rather than prohibited."
 *
 * So this is not a Sentry adapter with the vendor swapped out. There is no vendor.
 * §5.14 names the reason: "a compromised third-party dependency exfiltrating
 * data" is the realistic adversary, and a telemetry SDK is a dependency with
 * network access and a legitimate reason to use it.
 *
 * ## Why metrics are written fire-and-forget
 *
 * Every write here is best-effort and non-blocking, and a failure is swallowed
 * after being handed to `onWriteFailure`. That is the same trade `audit.repository`
 * makes and for a stronger reason: telemetry is operational exhaust. A full
 * `app_event` table must not turn a logged workout into a 500. Audit is domain
 * data and gets more care; this does not.
 *
 * The consequence, stated plainly: **metrics can be lost.** They are for spotting
 * a trend in §1.4's capture-latency budget, not for accounting.
 *
 * ## What is deliberately not here
 *
 * No log storage. §9.4 draws the line — "Application logs are operational exhaust
 * and expire" — so `Logger` writes to stdout, where the platform's log retention
 * owns it, and nothing in Postgres.
 */

import type {
  AuditHook,
  Clock,
  ErrorReport,
  ErrorReporter,
  LogContext,
  LogLevel,
  Logger,
  MetricDimensions,
  MetricName,
  Metrics,
  Observability,
  Span,
  Tracer,
} from '@naitikos/core';
import { systemClock } from '@naitikos/core';
import type { Result } from '@naitikos/shared';
import { ok } from '@naitikos/shared';
import type { DomainError } from '@naitikos/core';
import { asc, count, desc, eq } from 'drizzle-orm';

import type { Database } from '../client';
import { appEvent, auditLog } from '../schema/operations';

export type ObservabilityOptions = {
  readonly clock?: Clock;
  /** Suppresses `debug`. §5.13: "development only, stripped from production builds." */
  readonly minimumLevel?: LogLevel;
  /**
   * Called when a telemetry write fails.
   *
   * Injected so the failure has somewhere to go that is not the table that just
   * failed. Recursing into `app_event` to report that `app_event` is broken is a
   * loop, not a diagnostic.
   */
  readonly onWriteFailure?: (error: unknown, what: string) => void;
  /** Coarse device class, for the mobile-versus-desktop split. */
  readonly deviceClass?: 'phone' | 'tablet' | 'desktop';
  readonly schemaVersion?: string;
};

const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = Object.freeze({
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
});

/* =========================================================================
 * Logger
 * ====================================================================== */

/**
 * A structured logger writing one JSON object per line to stdout.
 *
 * JSON rather than a formatted string, because §5.13 requires `traceId`,
 * `spanId`, `userId`, and `schemaVersion` "on every entry" and a log a platform
 * cannot index by those fields does not answer the question it exists for.
 *
 * Note what cannot be logged: `LogContext` has no `data` field. A value that
 * genuinely aids debugging goes in `protected` as a `Sensitive<T>`, whose
 * serialiser emits `[redacted]` — so this function *physically cannot* write a
 * journal entry to stdout. §5.13: "relying on a redaction list fails the moment
 * someone adds a field and forgets — relying on a type fails loudly at compile
 * time."
 */
export function createConsoleLogger(options: ObservabilityOptions = {}): Logger {
  const clock = options.clock ?? systemClock;
  const threshold = LEVEL_ORDER[options.minimumLevel ?? 'info'];

  function build(bound: LogContext): Logger {
    function emit(level: LogLevel, message: string, context?: LogContext): void {
      if (LEVEL_ORDER[level] > threshold) return;

      const merged: LogContext = {
        ...bound,
        ...context,
        ...(options.schemaVersion === undefined ? {} : { schemaVersion: options.schemaVersion }),
        // Merged rather than replaced: a child logger binds a component and the call
        // site adds measurements, and either overwriting the other loses half.
        ...(bound.measurements === undefined && context?.measurements === undefined
          ? {}
          : { measurements: { ...bound.measurements, ...context?.measurements } }),
        ...(bound.identifiers === undefined && context?.identifiers === undefined
          ? {}
          : { identifiers: { ...bound.identifiers, ...context?.identifiers } }),
      };

      const line = JSON.stringify({
        level,
        time: clock.now().toISOString(),
        message,
        ...merged,
        // `Sensitive<T>` serialises to `[redacted]` via its own toJSON, so this is
        // safe by construction rather than by remembering to strip it.
      });

      /*
       * The three sanctioned `console` calls in the repo.
       *
       * `no-sensitive-log` exists to stop a stray console call carrying user
       * content to a hosting provider's log aggregator. This is the structured
       * logger the rule's message points at — §9.4 keeps application logs out of
       * Postgres, so stdout is the sink — and `line` is a serialised `LogContext`,
       * a type that cannot represent user content. Every other console call in the
       * codebase is still an error.
       */
      // eslint-disable-next-line @naitikos/no-sensitive-log -- See above: this is the logger, and the payload is a LogContext.
      if (level === 'error') console.error(line);
      // eslint-disable-next-line @naitikos/no-sensitive-log -- As above.
      else if (level === 'warn') console.warn(line);
      // eslint-disable-next-line @naitikos/no-sensitive-log -- As above.
      else console.log(line);
    }

    return {
      error: (message, context) => emit('error', message, context),
      warn: (message, context) => emit('warn', message, context),
      info: (message, context) => emit('info', message, context),
      debug: (message, context) => emit('debug', message, context),
      child: (context) => build({ ...bound, ...context }),
    };
  }

  return build({});
}

/* =========================================================================
 * Metrics
 * ====================================================================== */

/**
 * Metrics written to `app_event`.
 *
 * One row per measurement rather than a pre-aggregated counter, and the reason is
 * §9.7's arithmetic: at n=1 with ~50 actions a day this is a few hundred rows a
 * day, which Postgres does not notice. Pre-aggregating would mean read-modify-write
 * on a hot row for no benefit and would throw away the distribution — and it is the
 * *distribution* of capture latency that §1.4 budgets, not the mean.
 *
 * `route` and the other dimensions are low-cardinality by type. That is not
 * politeness; an unbounded dimension is how a metrics table grows a row per
 * request that nobody can group.
 */
export function createPostgresMetrics(db: Database, options: ObservabilityOptions = {}): Metrics {
  const clock = options.clock ?? systemClock;

  function write(name: MetricName, value: number, dimensions?: MetricDimensions): void {
    // Fire-and-forget. Awaiting would put a telemetry write on the critical path of
    // every capture, which is the metric §1.4 calls a P1 if it regresses.
    void db
      .insert(appEvent)
      .values({
        id: crypto.randomUUID(),
        name,
        value: Math.round(value),
        ...(dimensions?.route === undefined ? {} : { route: dimensions.route }),
        occurredAt: clock.now().toISOString(),
        ...(options.deviceClass === undefined && dimensions?.deviceClass === undefined
          ? {}
          : { deviceClass: dimensions?.deviceClass ?? options.deviceClass }),
        ...(options.schemaVersion === undefined ? {} : { schemaVersion: options.schemaVersion }),
      })
      .catch((error: unknown) => {
        options.onWriteFailure?.(error, `metric:${name}`);
      });
  }

  return {
    increment: (name, dimensions, by = 1) => {
      write(name, by, dimensions);
    },
    observe: (name, value, dimensions) => {
      write(name, value, dimensions);
    },
    gauge: (name, value, dimensions) => {
      write(name, value, dimensions);
    },

    async time(name, dimensions, fn) {
      const startedAt = clock.nowMillis();
      try {
        const result = await fn();
        write(name, clock.nowMillis() - startedAt, { ...dimensions, outcome: 'success' });
        return result;
      } catch (error: unknown) {
        // Recorded on the failure path too. Measuring only the happy path hides the
        // case where failures are slow, which is the case worth knowing about.
        write(name, clock.nowMillis() - startedAt, { ...dimensions, outcome: 'failure' });
        throw error;
      }
    },
  };
}

/* =========================================================================
 * Tracing
 * ====================================================================== */

/**
 * An in-process tracer whose spans exist only in log lines.
 *
 * Not OpenTelemetry, deliberately: OTel is a dependency with network egress and a
 * collector to operate, and C3 says every piece of infrastructure "is a liability
 * that must justify itself". §5.13 asks for `traceId` and `spanId` on every log
 * entry — that is a trace tree, and a trace tree assembled from structured log
 * lines answers "what did this request do" without a second system.
 *
 * `currentSpan()` returns `null`. Tracking an ambient span needs
 * `AsyncLocalStorage`, which is a Node API — and `core` declares the port, so the
 * honest implementation is to say we do not track one and have callers pass the
 * parent explicitly.
 */
export function createLoggingTracer(logger: Logger, options: ObservabilityOptions = {}): Tracer {
  const clock = options.clock ?? systemClock;

  function startSpan(name: string, parent?: Span): Span {
    const traceId = parent?.traceId ?? crypto.randomUUID();
    const spanId = crypto.randomUUID();
    const startedAt = clock.nowMillis();

    const measurements: Record<string, number> = {};
    const identifiers: Record<string, string> = {};
    let failureCode: string | null = null;
    let ended = false;

    return {
      traceId,
      spanId,
      ...(parent === undefined ? {} : { parentSpanId: parent.spanId }),
      name,
      setMeasurement: (key, value) => {
        measurements[key] = value;
      },
      setIdentifier: (key, value) => {
        identifiers[key] = value;
      },
      recordFailure: (code) => {
        failureCode = code;
      },
      end: () => {
        // Idempotent. `withSpan` ends the span on both paths and a caller may also
        // call `end()`; a double emission would double-count the duration.
        if (ended) return;
        ended = true;

        logger.info(`span ${name}`, {
          traceId,
          spanId,
          ...(parent === undefined ? {} : { identifiers: { ...identifiers, parentSpanId: parent.spanId } }),
          ...(parent !== undefined ? {} : { identifiers }),
          measurements: { ...measurements, durationMs: clock.nowMillis() - startedAt },
          ...(failureCode === null ? {} : { code: failureCode }),
        });
      },
    };
  }

  return {
    startSpan,
    async withSpan(name, fn, parent) {
      const span = startSpan(name, parent);
      try {
        return await fn(span);
      } catch (error: unknown) {
        span.recordFailure(error instanceof Error ? error.name : 'unknown');
        throw error;
      } finally {
        span.end();
      }
    },
    currentSpan: () => null,
  };
}

/* =========================================================================
 * Error reporting
 * ====================================================================== */

/**
 * Errors reported to the log and counted in `app_event`.
 *
 * §5.14 forbids crash reporting with payloads outright: "Body photographs and
 * psychiatric history do not go through Sentry." So an error becomes a log line
 * (code, our own message, stack) plus a counter — never a captured request, never
 * a serialised exception object, and nothing leaves the machine.
 */
export function createErrorReporter(logger: Logger, metrics: Metrics): ErrorReporter {
  return {
    report(error: ErrorReport) {
      logger.error(error.message, {
        code: error.code,
        ...(error.traceId === undefined ? {} : { traceId: error.traceId }),
        ...(error.component === undefined ? {} : { component: error.component }),
        ...(error.identifiers === undefined ? {} : { identifiers: error.identifiers }),
        measurements: { isUnexpected: error.isUnexpected ? 1 : 0 },
      });

      // Only genuine bugs are counted. An expected `DomainError` (§5.12) — a
      // validation failure, a not-found — is normal operation, and counting those
      // makes the metric a measure of how much the user is typing.
      if (error.isUnexpected) {
        metrics.increment('api.request.failed', { outcome: 'failure' });
      }
    },
  };
}

/* =========================================================================
 * Audit
 * ====================================================================== */

/**
 * The domain audit hook, writing to §9.4's permanent log.
 *
 * Separate from `Logger` on purpose, and the distinction is not stylistic. §9.4:
 * "The audit log is not the application log. Audit is domain data, lives in
 * Postgres, and is retained forever. Application logs are operational exhaust and
 * expire." Conflating them puts a permanent record on a 30-day retention.
 *
 * Unlike metrics, this one **awaits** and lets a failure propagate. An audit row
 * is part of the record, and a mutation whose audit write failed should fail.
 */
export function createAuditHook(db: Database): AuditHook {
  return {
    async recordDomainEvent(input) {
      await db.insert(auditLog).values({
        id: crypto.randomUUID(),
        entityType: input.entityType,
        entityId: input.entityId,
        operation: input.operation,
        actor: input.actor,
        ...(input.changeReason === undefined ? {} : { changeReason: input.changeReason }),
        ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
      });
    },
  };
}

/**
 * Reading the audit log — §3.2's `/settings/data/audit`.
 *
 * A reader, next to the writer, because §9.4 makes this domain data rather than
 * operational exhaust: *"Audit is domain data, lives in Postgres, and is
 * retained forever."* A permanent record nobody can read is a permanent record
 * that might as well not exist, and the whole argument for keeping it forever
 * is that somebody will one day need to ask what changed.
 *
 * **There is no write path here and never will be.** The log is the thing that
 * makes every other soft delete trustworthy; a repository that could amend it
 * would make it evidence of nothing.
 */
export type AuditEntry = {
  readonly id: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly operation: string;
  readonly actor: string;
  readonly changeReason: string | null;
  readonly occurredAt: string;
  readonly traceId: string | null;
};

export type AuditReader = {
  /** Most recent first. Filtered by entity type when one is given. */
  recent(limit: number, entityType?: string): Promise<Result<readonly AuditEntry[], DomainError>>;
  /** Distinct entity types present, for the filter. */
  entityTypes(): Promise<Result<readonly string[], DomainError>>;
  /** Total rows. Shown so a page of fifty is legible as a page of fifty. */
  total(): Promise<Result<number, DomainError>>;
};

export function createAuditReader(db: Database): AuditReader {
  return {
    async recent(limit, entityType) {
      const rows = await db
        .select({
          id: auditLog.id,
          entityType: auditLog.entityType,
          entityId: auditLog.entityId,
          operation: auditLog.operation,
          actor: auditLog.actor,
          changeReason: auditLog.changeReason,
          occurredAt: auditLog.occurredAt,
          traceId: auditLog.traceId,
        })
        .from(auditLog)
        .where(entityType === undefined ? undefined : eq(auditLog.entityType, entityType))
        .orderBy(desc(auditLog.occurredAt))
        .limit(limit);

      /*
       * `before_state` and `after_state` are deliberately not selected.
       *
       * They hold whole entity snapshots — a journal entry, a symptom note —
       * and §5.11's rule is names and numbers, never content. A viewer that
       * rendered them would put the most sensitive text in the database onto a
       * settings page, which is the one screen most likely to be open while
       * somebody is looking over a shoulder. What changed is answerable from
       * `changed_fields` if it is ever needed; what it changed *to* is the
       * entity's own surface to show.
       */
      return ok(rows.map((row) => ({ ...row })));
    },

    async entityTypes() {
      const rows = await db
        .selectDistinct({ entityType: auditLog.entityType })
        .from(auditLog)
        .orderBy(asc(auditLog.entityType));
      return ok(rows.map((row) => row.entityType));
    },

    async total() {
      const rows = await db.select({ total: count() }).from(auditLog);
      return ok(Number(rows[0]?.total ?? 0));
    },
  };
}

/* =========================================================================
 * The bundle
 * ====================================================================== */

/**
 * The whole bundle, wired.
 *
 * One object rather than five parameters, so adding a sixth signal later does not
 * change every call site — and so a caller cannot be handed a logger but no
 * metrics and quietly stop recording latency.
 */
export function createObservability(
  db: Database,
  options: ObservabilityOptions = {},
): Observability {
  const logger = createConsoleLogger(options);
  const metrics = createPostgresMetrics(db, options);

  return {
    logger,
    metrics,
    tracer: createLoggingTracer(logger, options),
    errors: createErrorReporter(logger, metrics),
    audit: createAuditHook(db),
  };
}
