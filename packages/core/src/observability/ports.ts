/**
 * Observability ports.
 *
 * §5.11 is unusually restrictive and the restriction is the design:
 *
 *   "**No third-party analytics. Ever.** (P7.) … An `app_event` table in the same
 *    Postgres … Event names and numeric measurements only. **No payloads,
 *    ever.** The schema cannot represent user content, which makes leakage
 *    impossible rather than prohibited."
 *
 * So these are ports over the project's own Postgres, not adapters for a vendor.
 * "No vendor lock-in" here does not mean *swappable* vendors — it means **no
 * vendor**. §5.14 names the realistic adversary: "a compromised third-party
 * dependency exfiltrating data", and a telemetry SDK is a dependency with network
 * access and a legitimate reason to use it.
 *
 * ## The type system is the enforcement
 *
 * Every signature below accepts names and numbers. None accepts an arbitrary
 * object. That is deliberate: a `properties?: Record<string, unknown>` parameter
 * is how a journal entry ends up in a metrics pipeline, and §5.13 makes the same
 * argument for redaction — "relying on a redaction *list* fails the moment
 * someone adds a field and forgets — relying on a *type* fails loudly at compile
 * time."
 */

import type { Sensitive } from '@naitikos/shared';

/* =========================================================================
 * Structured logging (§5.13)
 * ====================================================================== */

/**
 * §5.13's levels, with their stated meanings.
 *
 * `debug` is "development only, stripped from production builds".
 */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

/**
 * Fields permitted on a log line.
 *
 * §5.13 requires `traceId`, `spanId`, `userId`, and `schemaVersion` "on every
 * entry". Everything else is a bounded set of identifiers and numbers.
 *
 * **There is no `data` field**, and adding one would defeat the file. Where a
 * value genuinely aids debugging, it goes in `protected` as a `Sensitive<T>`,
 * whose serialiser emits `[redacted]` — so the logger *physically cannot*
 * serialise a journal entry.
 */
export type LogContext = {
  readonly traceId?: string;
  readonly spanId?: string;
  readonly userId?: string;
  readonly schemaVersion?: string;
  /** Which module. `events.bus`, `media.pipeline`. */
  readonly component?: string;
  /** Stable, machine-readable. Matches `DomainError.code` where applicable. */
  readonly code?: string;
  /** Numeric measurements only. */
  readonly measurements?: Readonly<Record<string, number>>;
  /** Identifiers — entity ids, event ids. Never content. */
  readonly identifiers?: Readonly<Record<string, string>>;
  /** Redacted on serialisation. The only route for a real value. */
  readonly protected?: Sensitive<unknown>;
};

export type Logger = {
  error(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  debug(message: string, context?: LogContext): void;
  /**
   * A logger bound to fixed context.
   *
   * So a request handler binds its `traceId` once rather than threading it
   * through every call — the mechanism that makes §5.13's "on every entry"
   * survivable in practice rather than being forgotten on the fifth log line.
   */
  child(context: LogContext): Logger;
};

/* =========================================================================
 * Metrics (§5.11, §1.4)
 * ====================================================================== */

/**
 * The metrics §1.4 actually needs.
 *
 * A closed union rather than free-form names, because §5.11's purpose is narrow:
 * "usage telemetry to protect the metrics in §1.4". An open namespace becomes a
 * dumping ground, and §1.4 warns that "vanity metrics are actively harmful in a
 * single-user product because there is no one to impress".
 *
 * `capture.latency` is the one that matters most — §1.4 budgets it at under five
 * seconds p50 and calls a sustained rise "a P1 defect".
 */
export const METRIC_NAMES = [
  /** Cold start → observation persisted. The P1 budget. */
  'capture.latency',
  'daily_close.submitted',
  'daily_close.duration',
  'observation.written',
  'event.published',
  'event.handler.duration',
  'event.dead_lettered',
  'timeline.query.duration',
  'media.upload.duration',
  'media.upload.bytes',
  'media.duplicate_detected',
  'job.run.duration',
  'job.step.duration',
  'job.step.failed',
  'sync.outbox.depth',
  /** §5.16 alerts on this: an entry older than 24h means data believed saved is not. */
  'sync.outbox.oldest_age_seconds',
  'sync.failed',
  'api.request.duration',
  'api.request.failed',
  'route.transition',
] as const;

export type MetricName = (typeof METRIC_NAMES)[number];

/**
 * Low-cardinality dimensions.
 *
 * Bounded on purpose. A `userId` dimension on a single-user system is pointless;
 * an unbounded dimension is how a metrics table grows a row per request.
 */
export type MetricDimensions = {
  readonly route?: string;
  readonly eventType?: string;
  readonly stepName?: string;
  readonly outcome?: 'success' | 'failure';
  readonly deviceClass?: 'phone' | 'tablet' | 'desktop';
};

export type Metrics = {
  /** A monotonic count. */
  increment(name: MetricName, dimensions?: MetricDimensions, by?: number): void;
  /** A distribution — latencies, sizes. */
  observe(name: MetricName, value: number, dimensions?: MetricDimensions): void;
  /** A point-in-time value — outbox depth. */
  gauge(name: MetricName, value: number, dimensions?: MetricDimensions): void;
  /**
   * Time a block and record it.
   *
   * Records on both success and failure with the outcome as a dimension —
   * measuring only the happy path hides the case where failures are slow, which
   * is the case worth knowing about.
   */
  time<T>(name: MetricName, dimensions: MetricDimensions, fn: () => Promise<T>): Promise<T>;
};

/* =========================================================================
 * Tracing (§5.13)
 * ====================================================================== */

/**
 * A span.
 *
 * §5.13 requires `traceId` and `spanId` on every log entry, which implies a trace
 * tree. Deliberately minimal — not OpenTelemetry, because OTel is a dependency
 * with network egress and a collector to operate, and C3 says every piece of
 * infrastructure "is a liability that must justify itself". A trace that lives in
 * the log lines is enough to answer "what did this request do".
 */
export type Span = {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  /** Bounded, like `LogContext`. No free-form attributes. */
  setMeasurement(key: string, value: number): void;
  setIdentifier(key: string, value: string): void;
  /** Marks the span failed. The error is logged separately, never attached. */
  recordFailure(code: string): void;
  end(): void;
};

export type Tracer = {
  startSpan(name: string, parent?: Span): Span;
  /** Runs `fn` inside a span, ending it on both paths. */
  withSpan<T>(name: string, fn: (span: Span) => Promise<T>, parent?: Span): Promise<T>;
  /** The active span, if the runtime can track one. */
  currentSpan(): Span | null;
};

/* =========================================================================
 * Error reporting (§5.14)
 * ====================================================================== */

/**
 * A reported error.
 *
 * §5.14 forbids "crash reporting with payloads" outright: "Body photographs and
 * psychiatric history do not go through Sentry."
 *
 * So this carries a code, a message the application itself wrote, a stack, and
 * identifiers. **Not the error object**, because an arbitrary `Error` may have
 * captured a request body in its message, and not a `context` bag for the same
 * reason.
 */
export type ErrorReport = {
  readonly code: string;
  /** Developer-facing, written by us. Never a stringified user value (§5.13). */
  readonly message: string;
  /**
   * Stack trace.
   *
   * Safe because a stack contains file paths and function names, not values —
   * with one exception worth knowing: a stack from a template-literal throw can
   * embed an interpolated value. Constructing errors with static messages and
   * structured fields (§5.12's `DomainError`) is what keeps that true.
   */
  readonly stack?: string;
  readonly traceId?: string;
  readonly component?: string;
  readonly identifiers?: Readonly<Record<string, string>>;
  /** True for a genuine bug, false for an expected `DomainError` (§5.12). */
  readonly isUnexpected: boolean;
};

export type ErrorReporter = {
  report(error: ErrorReport): void;
};

/* =========================================================================
 * Audit (§9.4)
 * ====================================================================== */

/**
 * Domain audit, distinct from application logging.
 *
 * §9.4: "The audit log is not the application log. Audit is domain data, lives in
 * Postgres, and is retained forever. Application logs are operational exhaust and
 * expire."
 *
 * Declared here because it is an observability *hook* — a caller asks for
 * something to be audited without knowing where audit rows live — but its
 * retention, its sensitivity, and its guarantees are entirely different from
 * `Logger`. Conflating them is how a permanent record ends up on a 30-day
 * retention.
 */
export type AuditHook = {
  recordDomainEvent(input: {
    readonly entityType: string;
    readonly entityId: string;
    readonly operation: 'insert' | 'update' | 'soft_delete' | 'restore' | 'purge';
    readonly actor: string;
    readonly changeReason?: string;
    readonly traceId?: string;
  }): Promise<void>;
};

/* =========================================================================
 * The bundle
 * ====================================================================== */

/**
 * Everything observability, passed as one object.
 *
 * A bundle rather than four parameters, so adding a fifth signal later does not
 * change every call site — and so a caller cannot be given a logger but no
 * metrics and quietly stop recording latency.
 */
export type Observability = {
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly tracer: Tracer;
  readonly errors: ErrorReporter;
  readonly audit: AuditHook;
};

/**
 * A no-op implementation.
 *
 * For tests, and for the CLI paths where telemetry is noise. Exported from `core`
 * rather than a test helper because it is part of the contract: any consumer must
 * be constructible without a telemetry backend, or `core` has acquired an
 * infrastructure dependency by the back door.
 */
export function createNoopObservability(): Observability {
  const noopLogger: Logger = {
    error: () => undefined,
    warn: () => undefined,
    info: () => undefined,
    debug: () => undefined,
    child: () => noopLogger,
  };

  const noopSpan = (name: string): Span => ({
    traceId: 'noop',
    spanId: 'noop',
    name,
    setMeasurement: () => undefined,
    setIdentifier: () => undefined,
    recordFailure: () => undefined,
    end: () => undefined,
  });

  return {
    logger: noopLogger,
    metrics: {
      increment: () => undefined,
      observe: () => undefined,
      gauge: () => undefined,
      time: async (_name, _dimensions, fn) => fn(),
    },
    tracer: {
      startSpan: (name) => noopSpan(name),
      withSpan: async (name, fn) => fn(noopSpan(name)),
      currentSpan: () => null,
    },
    errors: { report: () => undefined },
    audit: { recordDomainEvent: () => Promise.resolve() },
  };
}
