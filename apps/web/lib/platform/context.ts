/**
 * Shared plumbing for the platform route handlers.
 *
 * The counterpart to `lib/auth/handler-context.ts`, and it exists for the same
 * stated reason. §5.2: "route handlers are transport, not logic. A handler
 * parses, authenticates, delegates to a domain service, and serialises. Zero
 * business rules. If a handler exceeds roughly thirty lines, logic has leaked
 * into transport."
 *
 * Four routes need the same six things — trace id, CSRF, rate limit, permission,
 * a wired event bus, a Zod parse. Repeating that in each is how the fifth route
 * ends up missing one of them.
 */

import 'server-only';

import { NextResponse, type NextRequest } from 'next/server';
import type { z } from 'zod';
import { isErr } from '@naitikos/shared';
import type { Actor, EventBus, Permission } from '@naitikos/core';
import { createEventBus, systemClock } from '@naitikos/core';
import type { Database } from '@naitikos/db';
import {
  createConsoleLogger,
  createDeadLetterSink,
  createEventStore,
  createHandledLedger,
  createObservability,
  createTaskRepository,
  createTimelineProjectionHandler,
  createTimelineRepository,
  createUploadOutboxRepository,
} from '@naitikos/db';

import { getDb, requireServerPermission } from '../auth/session';
import {
  csrfGuard,
  errorResponse,
  internalErrorResponse,
  rateLimitGuard,
  traceIdFor,
} from '../auth/handler-context';

/**
 * The profile's zone.
 *
 * A constant for now — C1 is one user, and the profile row that owns this is
 * read on the settings path rather than on every timeline query. Threading it
 * through as a parameter keeps the projector honest (it takes a zone, it does
 * not assume one), so replacing this with a profile read is a one-line change
 * at each call site rather than a redesign.
 */
export const DEFAULT_PROFILE_ZONE = 'Asia/Kolkata';

/**
 * The wired platform, per request.
 *
 * Built per invocation rather than cached at module scope, matching every
 * repository factory: a serverless container must not leak one request's
 * handles into another's.
 */
export type PlatformContext = {
  readonly db: Database;
  readonly bus: EventBus;
  readonly timeline: ReturnType<typeof createTimelineRepository>;
  readonly tasks: ReturnType<typeof createTaskRepository>;
  readonly outbox: ReturnType<typeof createUploadOutboxRepository>;
  readonly observability: ReturnType<typeof createObservability>;
  readonly zone: string;
};

export function createPlatformContext(traceId: string): PlatformContext {
  const db = getDb();
  const timeline = createTimelineRepository(db);
  const observability = createObservability(db, {
    onWriteFailure: (error, what) => {
      // Reported through the logger rather than back into `app_event` — recursing
      // into the table that just failed is a loop, not a diagnostic.
      observability.logger.warn('telemetry write failed', {
        traceId,
        component: 'observability',
        code: what,
        identifiers: { detail: error instanceof Error ? error.name : 'unknown' },
      });
    },
  });

  const bus = createEventBus({
    store: createEventStore(db),
    ledger: createHandledLedger(db),
    deadLetter: createDeadLetterSink(db),
    clock: systemClock,
    newId: () => crypto.randomUUID(),
  });

  // The only handler registered today, and the reason a future domain appears on
  // the timeline with no timeline code change: it emits events, and this projects
  // them.
  bus.register(createTimelineProjectionHandler(timeline, DEFAULT_PROFILE_ZONE));

  return {
    db,
    bus,
    timeline,
    tasks: createTaskRepository(db),
    outbox: createUploadOutboxRepository(db),
    observability,
    zone: DEFAULT_PROFILE_ZONE,
  };
}

/* =========================================================================
 * The guard chain
 * ====================================================================== */

export type GuardedRequest = {
  readonly traceId: string;
  readonly actor: Actor;
  readonly platform: PlatformContext;
};

/**
 * Run the guards every platform route needs, in order.
 *
 * The order is not arbitrary. CSRF first, because a cross-origin request should
 * be rejected before it consumes any rate-limit budget — otherwise an attacker
 * can lock the real user out by burning their quota. Rate limit second, so an
 * unauthenticated flood costs one hash rather than a session lookup and a
 * database round-trip. Permission last, because it is the expensive check.
 *
 * @returns either a ready-to-return error response, or the request's context.
 */
export async function guard(
  request: NextRequest,
  permission: Permission,
): Promise<{ response: NextResponse } | { context: GuardedRequest }> {
  const traceId = traceIdFor(request);

  // Safe methods carry no CSRF token and do not need one — `verifyCsrf` returns
  // ok for GET and HEAD.
  const csrf = csrfGuard(request, traceId);
  if (csrf !== null) return { response: csrf };

  // `session` is the general-purpose budget: 120/minute, which is generous for a
  // human scrolling a timeline and tight enough that a loop is noticed.
  const limited = await rateLimitGuard(request, 'session', traceId);
  if (limited !== null) return { response: limited };

  const authorized = await requireServerPermission(permission);
  if (isErr(authorized)) return { response: errorResponse(authorized.error, traceId) };

  return {
    context: {
      traceId,
      actor: authorized.value,
      platform: createPlatformContext(traceId),
    },
  };
}

/** Narrowing helper, so a handler reads as a straight line. */
export function isGuardFailure(
  result: Awaited<ReturnType<typeof guard>>,
): result is { response: NextResponse } {
  return 'response' in result;
}

/* =========================================================================
 * Failing honestly
 * ====================================================================== */

/**
 * The 500 an unhandled throw earns — *and* the log line that makes it findable.
 *
 * `internalErrorResponse` returns nothing but a trace id, deliberately: §5.12
 * says an unexpected error must not leak its shape to the caller, and §5.14
 * names "a compromised third-party dependency exfiltrating data" as the
 * adversary that makes a verbose 500 a real risk rather than a stylistic one.
 * The body it produces therefore points the operator at the server log.
 *
 * Eleven handlers returned that body from a bare `catch { }`. Nothing was
 * logged, so the trace id the response named appeared nowhere, and the operator
 * was sent to search a log for a trace that did not exist. A 500 that lies
 * about where the evidence is costs more than one that says nothing at all —
 * the search happens either way, and only in the first case does it fail
 * silently.
 *
 * ## Why a helper rather than the inline call the other handlers use
 *
 * Most route handlers run `guard` *outside* their `try`, which leaves
 * `platform` in scope in the `catch` and lets them write
 * `platform.observability.logger.error(...)` directly. The handlers this
 * function serves keep `guard` *inside* the `try` on purpose — that is what
 * makes a throw from the guard chain itself (a database handle that will not
 * open, a rate-limit store that faults) come back as a 500 carrying a trace id
 * rather than as Next's opaque digest — and the four `/api/auth` routes never
 * build a platform context at all. Restructuring eleven handlers to match the
 * majority would have traded that guarantee away for symmetry.
 *
 * The emitted line is the same shape the other handlers emit, down to the
 * message. Only the logger's provenance differs, and not in substance:
 * `createObservability` builds its logger from this same `createConsoleLogger`,
 * and §9.4 keeps application logs out of Postgres, so both write the same JSON
 * to the same stdout. Constructed per call rather than at module scope, in line
 * with the rule stated on {@link createPlatformContext} — it holds no handles,
 * but a serverless container that caches one thing at module scope tends to
 * acquire a second.
 *
 * ## What is deliberately not logged
 *
 * The caught error's `message` and `stack` stay out, and this is the one place
 * where that decision is worth spelling out because an incident is exactly when
 * someone reaches for them.
 *
 * §5.11 permits "event names and numeric measurements only. **No payloads,
 * ever.**" A driver's message is not a message we wrote: a Postgres
 * unique-violation reads `Key (content_hash)=(…)` with the conflicting value
 * inline, and `Error.prototype.stack` opens with that same message before the
 * first frame — so logging the stack logs the message, and there is no version
 * of this that takes one without the other. `ErrorReport.stack` in
 * `core/observability/ports.ts` does call a stack safe, but read the reason it
 * gives: "constructing errors with static messages and structured fields
 * (§5.12's `DomainError`) is what keeps that true." That holds for the errors
 * this codebase constructs and not for whatever `pg` throws from inside a
 * connection pool.
 *
 * `LogContext` has nowhere to put them regardless — no `data` field, by
 * construction — so the alternative would have meant smuggling a stack through
 * `identifiers`, a field documented as "identifiers … never content".
 *
 * The class name and the trace id are what every other handler in the codebase
 * records. That is enough to find the request in the platform log and to say
 * which failure class it was; the frames belong in a reproduction, where they
 * are read once rather than retained.
 */
export function unhandledErrorResponse(
  /** Dotted, matching the other handlers: `media.uploads.post`, `timeline.get`. */
  component: string,
  traceId: string,
  error: unknown,
  /**
   * A stable code, for the 500s that are a *condition* rather than a throw.
   *
   * Not every unlogged 500 came from a `catch`. A handler that finds its auth
   * provider missing a method returns the same opaque body, and without a code
   * its log line would be indistinguishable from a genuine exception — which is
   * the difference between "the database blinked" and "this deployment is
   * misconfigured".
   */
  code?: string,
): NextResponse {
  createConsoleLogger().error(`unhandled error in ${component}`, {
    traceId,
    component,
    ...(code === undefined ? {} : { code }),
    identifiers: { name: error instanceof Error ? error.name : 'unknown' },
  });

  return internalErrorResponse(traceId);
}

/* =========================================================================
 * Parsing and serialising
 * ====================================================================== */

/**
 * Parse a JSON body against a schema.
 *
 * Issues are returned with their paths, because a client that cannot tell
 * *which* field it got wrong will retry with the same body. Nothing here echoes
 * a submitted *value* — §5.13's rule holds even in a validation error, and a
 * rejected journal entry must not come back in the response.
 */
export async function parseJson<T extends z.ZodType>(
  request: NextRequest,
  schema: T,
  traceId: string,
): Promise<{ response: NextResponse } | { data: z.infer<T> }> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return {
      response: NextResponse.json(
        { error: { code: 'invalid_json', message: 'Body must be JSON.', traceId } },
        { status: 400 },
      ),
    };
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return {
      response: NextResponse.json(
        {
          error: {
            code: 'validation_failed',
            message: 'The request did not match the expected shape.',
            issues: parsed.error.issues.map((issue) => ({
              path: issue.path.join('.'),
              message: issue.message,
            })),
            traceId,
          },
        },
        { status: 400 },
      ),
    };
  }

  return { data: parsed.data };
}

/** Parse a query string against a schema. */
export function parseQuery<T extends z.ZodType>(
  request: NextRequest,
  schema: T,
  traceId: string,
): { response: NextResponse } | { data: z.infer<T> } {
  const parsed = schema.safeParse(Object.fromEntries(request.nextUrl.searchParams));

  if (!parsed.success) {
    return {
      response: NextResponse.json(
        {
          error: {
            code: 'validation_failed',
            message: 'The query parameters were not valid.',
            issues: parsed.error.issues.map((issue) => ({
              path: issue.path.join('.'),
              message: issue.message,
            })),
            traceId,
          },
        },
        { status: 400 },
      ),
    };
  }

  return { data: parsed.data };
}

/* =========================================================================
 * Bridging Zod output to `exactOptionalPropertyTypes`
 * ====================================================================== */

/**
 * Drop keys whose value is `undefined`.
 *
 * The repo sets `exactOptionalPropertyTypes`, under which `{ from?: string }` and
 * `{ from: string | undefined }` are different types — and Zod's `.optional()`
 * produces the second. So a parsed query cannot be handed to a `core` function
 * whose parameter uses the first, even though every value in it is valid.
 *
 * The alternative is a conditional spread per field at each call site, which for
 * a twelve-field query is twelve chances to typo a key name and silently drop a
 * filter. One helper, applied once, is the safer shape.
 *
 * The mapped type is the interesting part: keys that *can* be undefined become
 * genuinely optional in the result, and keys that cannot are left required — so
 * the output type is what the target actually expects rather than a widened
 * `Partial`.
 */
export function withoutUndefined<T extends object>(
  value: T,
): { [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined> } & {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K];
} {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) out[key] = item;
  }
  return out as ReturnType<typeof withoutUndefined<T>>;
}

export { errorResponse, internalErrorResponse, traceIdFor };
