/**
 * `DomainError` → HTTP. The one place.
 *
 * §5.12: "domain errors map to HTTP status codes in exactly one place. Every
 * error response carries a stable machine-readable `code`, a human `message`,
 * and a `traceId`."
 *
 * The exhaustive switch below is the mechanism that keeps "exactly one place"
 * true: `assertNever` makes a new `DomainError` variant a compile error here
 * before it is anything else. ADR 0004 exercised that and it worked.
 */

import { assertNever } from '@naitikos/shared';
import type { DomainError } from '@naitikos/core';

/**
 * The wire shape of every failure the API returns.
 *
 * Deliberately flat and deliberately small. It crosses to a client that may be
 * running an older build (§5.8), so it must stay readable without knowing the
 * server's version.
 */
export type ErrorResponseBody = {
  readonly error: {
    /** Stable and machine-readable. Clients branch on this, never on `message`. */
    readonly code: string;
    /** Human-readable, developer-facing, never containing user content (§5.13). */
    readonly message: string;
    /** Correlates with the server log (§5.13). */
    readonly traceId: string;
    /** Field-level detail, present only for validation failures. */
    readonly issues?: readonly { readonly path: readonly (string | number)[]; readonly message: string }[];
    /** Present on 403 when re-authenticating would grant the request (§5.4). */
    readonly stepUpRequired?: boolean;
    /** Present on 409, so an optimistic-concurrency client can refetch. */
    readonly expectedVersion?: number;
    readonly actualVersion?: number;
  };
};

export type MappedError = {
  readonly status: number;
  readonly body: ErrorResponseBody;
  /** Extra headers this error requires — `WWW-Authenticate`, `Retry-After`. */
  readonly headers: Readonly<Record<string, string>>;
};

/**
 * Map a domain error to a response.
 *
 * Note what is *not* here: no 500. A `DomainError` is by definition an expected
 * outcome (§5.12 — "Exceptions are reserved for genuine bugs"), so every branch
 * is a 4xx. An unexpected throw is handled separately by
 * {@link unexpectedErrorResponse}, which deliberately reveals nothing.
 */
export function toHttpError(error: DomainError, traceId: string): MappedError {
  switch (error.kind) {
    case 'validation':
      return {
        status: 400,
        headers: {},
        body: {
          error: { code: error.code, message: error.message, traceId, issues: error.issues },
        },
      };

    case 'unauthenticated':
      return {
        status: 401,
        // RFC 9110: a 401 must carry a challenge. `Bearer` is the honest
        // description even though the token rides in a cookie — the scheme
        // tells a client what kind of credential would satisfy the request.
        headers: { 'WWW-Authenticate': 'Bearer realm="naitikos"' },
        body: { error: { code: error.code, message: error.message, traceId } },
      };

    case 'forbidden':
      return {
        status: 403,
        headers: {},
        body: {
          error: {
            code: error.code,
            message: error.message,
            traceId,
            stepUpRequired: error.stepUpRequired,
          },
        },
      };

    case 'not_found':
      return {
        status: 404,
        headers: {},
        body: { error: { code: error.code, message: error.message, traceId } },
      };

    case 'conflict':
      return {
        status: 409,
        headers: {},
        body: {
          error: {
            code: error.code,
            message: error.message,
            traceId,
            ...(error.expectedVersion === undefined ? {} : { expectedVersion: error.expectedVersion }),
            ...(error.actualVersion === undefined ? {} : { actualVersion: error.actualVersion }),
          },
        },
      };

    case 'precondition_failed':
      return {
        status: 412,
        headers: {},
        body: { error: { code: error.code, message: error.message, traceId } },
      };

    default:
      return assertNever(error, 'DomainError');
  }
}

/**
 * The response for a genuine bug.
 *
 * Says nothing beyond the trace id. §5.14's threat model includes a
 * provider-side breach and a compromised dependency; a stack trace or an
 * exception message in a response body is a free reconnaissance gift, and in
 * this system an exception message could contain a journal entry.
 *
 * The trace id is the entire affordance: the operator reads it off the screen
 * and finds the real error in the log.
 */
export function unexpectedErrorResponse(traceId: string): MappedError {
  return {
    status: 500,
    headers: {},
    body: {
      error: {
        code: 'internal_error',
        message: 'Something went wrong. The details are in the server log.',
        traceId,
      },
    },
  };
}

/**
 * The response for a rate-limited request.
 *
 * Not a `DomainError`: rate limiting is a transport concern that never reaches
 * the domain, and modelling it as one would mean the domain could be
 * rate-limited by a unit test. 429 is also the one status where the body is
 * less useful than the header — `Retry-After` is what a client acts on.
 */
export function rateLimitedResponse(traceId: string, retryAfterSeconds: number): MappedError {
  return {
    status: 429,
    headers: { 'Retry-After': String(Math.max(1, Math.ceil(retryAfterSeconds))) },
    body: {
      error: {
        code: 'rate_limited',
        message: 'Too many requests. Try again shortly.',
        traceId,
      },
    },
  };
}
