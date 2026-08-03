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

/** Identity, authentication, authorization (§5.4). */
export * from './auth';
