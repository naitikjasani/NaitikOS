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
 * **Closed** is the operative word. These four variants are the complete set.
 * Adding a fifth is an architectural decision requiring an ADR (§11.6), not a
 * convenience — because §5.12 also requires that "domain errors map to HTTP
 * status codes in exactly one place", and every exhaustive switch over this
 * union (guarded by `assertNever`) will fail to compile until that mapping is
 * updated. That compile failure is the feature.
 *
 * Errors are plain data, not `Error` subclasses. They cross the wire, get
 * persisted in the audit log (§9.4), and are pattern-matched — none of which
 * a stack trace helps with, and all of which structured fields do.
 */

import type { Sensitive } from '@naitikos/shared';

/** Discriminant for the union. */
export type DomainErrorKind = 'validation' | 'not_found' | 'conflict' | 'precondition_failed';

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

/** The complete, closed set. */
export type DomainError =
  | ValidationError
  | NotFoundError
  | ConflictError
  | PreconditionFailedError;

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

/* ------------------------------------------------------------------ *
 * Guards                                                              *
 * ------------------------------------------------------------------ */

export function isDomainError(value: unknown): value is DomainError {
  if (typeof value !== 'object' || value === null) return false;
  const kind: unknown = (value as { kind?: unknown }).kind;
  return (
    kind === 'validation' ||
    kind === 'not_found' ||
    kind === 'conflict' ||
    kind === 'precondition_failed'
  );
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
