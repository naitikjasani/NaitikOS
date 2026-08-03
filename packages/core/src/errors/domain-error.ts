/**
 * The closed `DomainError` union.
 *
 * Blueprint §5.12:
 *
 *   "Functions that can fail return an explicit `Result<T, DomainError>`.
 *    Domain errors are a closed, enumerated union — `ValidationError`,
 *    `NotFound`, `ConflictError`, `PreconditionFailed` — with structured
 *    fields. Exceptions are reserved for genuine bugs, not for expected
 *    outcomes."
 *
 * **Closed** is the operative word. Adding a variant is an architectural
 * decision requiring an ADR (§11.6), not a convenience — because §5.12 also
 * requires that "domain errors map to HTTP status codes in exactly one place",
 * and every exhaustive switch over this union (guarded by `assertNever`) will
 * fail to compile until that mapping is updated. That compile failure is the
 * feature.
 *
 * §5.12 names four variants. Two more were added by
 * [ADR 0004](../../../../docs/adr/0004-auth-domain-errors.md) —
 * `unauthenticated` and `forbidden` — because auth failures must map to 401 and
 * 403, and the alternatives all amounted to a discriminant wearing a disguise.
 * Six is the complete set.
 *
 * Errors are plain data, not `Error` subclasses. They cross the wire, get
 * persisted in the audit log (§9.4), and are pattern-matched — none of which
 * a stack trace helps with, and all of which structured fields do.
 */

import type { Sensitive } from '@naitikos/shared';

/** Discriminant for the union. */
export type DomainErrorKind =
  | 'validation'
  | 'not_found'
  | 'conflict'
  | 'precondition_failed'
  | 'unauthenticated'
  | 'forbidden';

/**
 * Fields common to every variant.
 *
 * `message` is developer-facing and appears in logs. It must never contain
 * user content — §5.13 forbids it, and an error message is one of the easiest
 * places for a journal entry to leak. Where the offending value genuinely aids
 * debugging, wrap it in `Sensitive<T>` via `detail`.
 */
type DomainErrorBase = {
  /** Stable, machine-readable code. Safe to switch on and safe to log. */
  readonly code: string;
  /** Developer-facing description. Never contains user content. */
  readonly message: string;
  /** Optional protected payload for debugging. Redacted in logs. */
  readonly detail?: Sensitive<unknown>;
};

/**
 * Input failed validation.
 *
 * `issues` mirrors the shape Zod produces so a parse failure maps across
 * without translation, and so a form can highlight the offending field.
 */
export type ValidationError = DomainErrorBase & {
  readonly kind: 'validation';
  readonly issues: readonly {
    /** Path to the offending field, e.g. `['sets', 0, 'load']`. */
    readonly path: readonly (string | number)[];
    readonly message: string;
  }[];
};

/** The requested entity does not exist, or is soft-deleted (§9.4). */
export type NotFoundError = DomainErrorBase & {
  readonly kind: 'not_found';
  readonly entity: string;
  readonly id: string;
};

/**
 * The operation conflicts with current state.
 *
 * Covers optimistic-concurrency failures (§9.4 row versioning) and genuine
 * domain conflicts such as two active schedules for one medication, which the
 * exclusion constraint in §9.6 rejects.
 */
export type ConflictError = DomainErrorBase & {
  readonly kind: 'conflict';
  readonly entity: string;
  readonly reason: 'version_mismatch' | 'duplicate' | 'overlapping_interval' | 'invalid_state';
  /** Present for version mismatches, so the caller can refetch and retry. */
  readonly expectedVersion?: number;
  readonly actualVersion?: number;
};

/**
 * A precondition for the operation is not met.
 *
 * Distinct from `validation`: the input is well-formed, but the system is not
 * in a state where the operation makes sense — an unregistered metric key
 * (§9.2), a consent scope that is off (§10.10), a schema version too old to
 * write safely (§5.8).
 */
export type PreconditionFailedError = DomainErrorBase & {
  readonly kind: 'precondition_failed';
  readonly precondition: string;
};

/**
 * No valid session — the caller has not proved who they are. Maps to 401.
 *
 * Distinct from {@link ForbiddenError}: this one means "sign in", that one means
 * "signing in again will not help". See ADR 0004.
 */
export type UnauthenticatedError = DomainErrorBase & {
  readonly kind: 'unauthenticated';
  readonly reason: 'no_session' | 'expired' | 'invalid_token' | 'revoked';
};

/**
 * The caller is known and refused. Maps to 403.
 *
 * **The missing permission is deliberately not carried.** Telling an
 * unauthorised caller exactly which permission would have worked is a small
 * information leak that buys nothing at n=1. It is logged server-side instead
 * (ADR 0004).
 *
 * `stepUpRequired` covers §5.4's rule that "sensitive operations — export,
 * encryption-key access, deletion — require step-up re-authentication
 * regardless of session age". The caller holds the permission; the session is
 * simply too old to exercise it.
 */
export type ForbiddenError = DomainErrorBase & {
  readonly kind: 'forbidden';
  readonly reason: 'insufficient_permission' | 'not_allowlisted' | 'step_up_required';
  /** True when re-authenticating would grant the request (§5.4). */
  readonly stepUpRequired: boolean;
};

/** The complete, closed set. Six variants — see ADR 0004. */
export type DomainError =
  | ValidationError
  | NotFoundError
  | ConflictError
  | PreconditionFailedError
  | UnauthenticatedError
  | ForbiddenError;

/* ------------------------------------------------------------------ *
 * Constructors                                                        *
 *                                                                     *
 * Used instead of object literals so every error carries a code and   *
 * the shape stays consistent across a codebase written over years.    *
 * ------------------------------------------------------------------ */

export function validationError(
  code: string,
  message: string,
  issues: ValidationError['issues'] = [],
  detail?: Sensitive<unknown>,
): ValidationError {
  return { kind: 'validation', code, message, issues, ...(detail ? { detail } : {}) };
}

export function notFoundError(entity: string, id: string, code = 'not_found'): NotFoundError {
  return {
    kind: 'not_found',
    code,
    message: `${entity} not found`,
    entity,
    id,
  };
}

export function conflictError(
  entity: string,
  reason: ConflictError['reason'],
  options: {
    readonly code?: string;
    readonly message?: string;
    readonly expectedVersion?: number;
    readonly actualVersion?: number;
  } = {},
): ConflictError {
  return {
    kind: 'conflict',
    code: options.code ?? `conflict_${reason}`,
    message: options.message ?? `${entity} conflict: ${reason}`,
    entity,
    reason,
    ...(options.expectedVersion === undefined ? {} : { expectedVersion: options.expectedVersion }),
    ...(options.actualVersion === undefined ? {} : { actualVersion: options.actualVersion }),
  };
}

export function preconditionFailedError(
  precondition: string,
  message: string,
  code = 'precondition_failed',
): PreconditionFailedError {
  return { kind: 'precondition_failed', code, message, precondition };
}

export function unauthenticatedError(
  reason: UnauthenticatedError['reason'] = 'no_session',
  message = 'Authentication required.',
): UnauthenticatedError {
  return { kind: 'unauthenticated', code: `unauthenticated_${reason}`, message, reason };
}

export function forbiddenError(
  reason: ForbiddenError['reason'],
  message = 'Not permitted.',
): ForbiddenError {
  return {
    kind: 'forbidden',
    code: `forbidden_${reason}`,
    message,
    reason,
    stepUpRequired: reason === 'step_up_required',
  };
}

/* ------------------------------------------------------------------ *
 * Guards                                                              *
 * ------------------------------------------------------------------ */

const DOMAIN_ERROR_KINDS: readonly DomainErrorKind[] = [
  'validation',
  'not_found',
  'conflict',
  'precondition_failed',
  'unauthenticated',
  'forbidden',
];

export function isDomainError(value: unknown): value is DomainError {
  if (typeof value !== 'object' || value === null) return false;
  const kind: unknown = (value as { kind?: unknown }).kind;
  return (DOMAIN_ERROR_KINDS as readonly unknown[]).includes(kind);
}

/**
 * Is this an authentication or authorization failure?
 *
 * Used by the audit hook (§9.4): every refusal is recorded, and refusals are
 * the security-relevant subset of errors worth alerting on.
 */
export function isAuthError(
  error: DomainError,
): error is UnauthenticatedError | ForbiddenError {
  return error.kind === 'unauthenticated' || error.kind === 'forbidden';
}

/**
 * Is retrying this operation unchanged likely to succeed?
 *
 * Relevant to the offline outbox (§5.7), which must distinguish "the network
 * was down" — retry — from "the server rejected this" — surface it, and never
 * silently drop the write.
 */
export function isRetryable(error: DomainError): boolean {
  return error.kind === 'conflict' && error.reason === 'version_mismatch';
}
