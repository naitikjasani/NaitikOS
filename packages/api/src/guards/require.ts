/**
 * Route guards.
 *
 * §5.4 puts authorization here: "Authorization lives in the API layer where it
 * is testable, readable, and version-controlled."
 *
 * These are thin on purpose. The *decision* is `authorize` in
 * `@naitikos/core` — a pure function over plain data. This file adds the two
 * things a transport layer owes it: the audit write, and the mapping to a
 * response. §5.2's rule for handlers applies equally here — "route handlers are
 * transport, not logic. Zero business rules."
 *
 * The milestone asked for no duplicated auth logic. This is where that is kept
 * true: there is exactly one call to `authorize` in the codebase, and it is
 * below.
 */

import type { Result } from '@naitikos/shared';
import { err, isErr, ok } from '@naitikos/shared';
import type { Actor, AuthAuditRecorder, AuthState, DomainError, Permission } from '@naitikos/core';
import {
  PERMISSIONS,
  authorize,
  isAuthenticated,
  roleHasPermission,
  unauthenticatedError,
} from '@naitikos/core';

export type GuardContext = {
  readonly state: AuthState;
  readonly audit: AuthAuditRecorder;
  readonly now: Date;
  readonly traceId?: string;
};

/**
 * Require an authenticated caller, without checking any permission.
 *
 * For routes that only need to know *who* — reading one's own session, say. A
 * route that touches data should use {@link requirePermission} instead, because
 * "authenticated" is not an authorization decision and treating it as one is
 * how a `delegate` ends up reading a journal.
 */
export function requireSession(context: GuardContext): Result<Actor, DomainError> {
  if (!isAuthenticated(context.state)) {
    return err(unauthenticatedError('no_session'));
  }
  return ok(context.state.actor);
}

/**
 * Require a permission, auditing every refusal.
 *
 * The audit write is the reason this wrapper exists rather than calling
 * `authorize` directly at each site. §9.4 makes the log "the recovery mechanism
 * of last resort", and a denial that is refused but not recorded is invisible
 * — which is the wrong property for the only security event this system
 * generates.
 *
 * Auditing is fire-and-forget by the recorder's own contract: it never throws,
 * so a failed audit write cannot convert a 403 into a 500.
 */
export async function requirePermission(
  context: GuardContext,
  permission: Permission,
): Promise<Result<Actor, DomainError>> {
  const decision = authorize(context.state, permission, { now: context.now });

  if (isErr(decision)) {
    const error = decision.error;

    await context.audit.record({
      kind:
        error.kind === 'forbidden' && error.reason === 'step_up_required'
          ? 'step_up_required'
          : 'authorization_denied',
      // Recorded server-side; deliberately absent from the response (ADR 0004).
      permission,
      occurredAt: context.now,
      ...(isAuthenticated(context.state)
        ? { subjectId: context.state.actor.subjectId, email: context.state.actor.email }
        : {}),
      ...(context.traceId === undefined ? {} : { traceId: context.traceId }),
    });

    return decision;
  }

  return decision;
}

/**
 * The permissions a role holds, for the session response.
 *
 * Sent to the client so the UI can decide what to render without a second round
 * trip. **Advisory only.** Every one of these is re-checked server-side on the
 * request that uses it; a client that forged this list would gain nothing but a
 * button that returns 403.
 */
export function visiblePermissions(state: AuthState): Permission[] {
  if (!isAuthenticated(state)) return [];
  return PERMISSIONS.filter((permission) => roleHasPermission(state.actor.role, permission));
}
