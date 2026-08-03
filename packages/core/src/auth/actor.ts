/**
 * Who is acting, and what they may do.
 *
 * This is the durable half of authorization. It has no idea that Supabase
 * exists, that sessions are carried in cookies, or that HTTP has status codes —
 * §5.0 forbids `core` from knowing any of that, and the point is that when the
 * auth provider is replaced in 2032 this file does not change.
 *
 * §5.4 places the authorization decision here rather than in the database:
 *
 *   "Row Level Security is enabled on every table as defence in depth — but it
 *    is explicitly *not* the primary authorization mechanism. Authorization
 *    lives in the API layer where it is testable, readable, and
 *    version-controlled."
 *
 * "Testable" is the operative word, and it is why {@link authorize} is a pure
 * function over plain data. Every rule in this file can be exercised without a
 * network, a database, or a browser.
 */

import type { Result } from '@naitikos/shared';
import { err, ok } from '@naitikos/shared';

import type { DomainError } from '../errors/domain-error';
import { forbiddenError, unauthenticatedError } from '../errors/domain-error';
import type { Permission, Role } from './roles';
import type { AuthStrategy } from './strategies';
import { requiresStepUp, roleHasPermission } from './roles';

/**
 * A verified identity.
 *
 * `subjectId` is the auth provider's opaque identifier — Supabase's
 * `auth.users.id` today. It is deliberately *not* the profile id: the profile is
 * application data that survives a provider migration, and the subject id is
 * provider data that does not. Keeping them separate is what makes §5.4's "an
 * auth swap" a swap rather than a rewrite.
 */
export type Actor = {
  readonly subjectId: string;
  /** Normalised lowercase. The allowlist compares against this. */
  readonly email: string;
  readonly role: Role;
  /**
   * When the current session last proved possession of a credential.
   *
   * Not when the session was issued — a session refreshed for thirty days
   * (§5.4) has a recent issue time and a stale authentication time. Step-up
   * checks read this one.
   */
  readonly authenticatedAt: Date;
  /**
   * How they authenticated. Recorded for the audit trail (§9.4).
   *
   * Typed as the union rather than `string` so the session contract and the
   * audit event agree with the registry — a stray strategy name would
   * otherwise reach the wire and fail Zod parsing at the client instead of at
   * the compiler.
   */
  readonly strategy: AuthStrategy;
};

/**
 * The result of evaluating a request's credentials.
 *
 * Explicitly a union rather than `Actor | null`, so "signed out" and "signed in"
 * are both first-class and a caller cannot forget the third possibility by
 * writing `if (actor)`.
 */
export type AuthState =
  | { readonly status: 'anonymous' }
  | { readonly status: 'authenticated'; readonly actor: Actor };

export const ANONYMOUS: AuthState = Object.freeze({ status: 'anonymous' });

export function authenticated(actor: Actor): AuthState {
  return { status: 'authenticated', actor };
}

export function isAuthenticated(
  state: AuthState,
): state is { status: 'authenticated'; actor: Actor } {
  return state.status === 'authenticated';
}

/**
 * How recently a step-up-protected action requires re-authentication.
 *
 * Fifteen minutes. §5.4 sets the session at thirty days sliding precisely so
 * the tool is not constantly re-authenticating (P1), which means the step-up
 * window is the *only* thing standing between a borrowed unlocked phone and a
 * complete export of a medical record. Long enough to complete an export
 * without re-prompting mid-flow; short enough that a walk to the coffee machine
 * closes it.
 */
export const STEP_UP_WINDOW_MS = 15 * 60 * 1000;

export type AuthorizeOptions = {
  /** Injected rather than read from the clock — §11.3, and it makes this testable. */
  readonly now: Date;
  /** Override for tests and for a future per-permission window. */
  readonly stepUpWindowMs?: number;
};

/**
 * The single authorization decision in the system.
 *
 * Everything that guards anything calls this. There is no second place where a
 * role is compared or a permission is inferred, which is the property that
 * makes the model auditable: to know what the system permits, read this
 * function and {@link ROLE_PERMISSIONS}.
 *
 * Order matters and is deliberate:
 *
 *   1. Anonymous → 401. "Sign in" is actionable.
 *   2. Permission missing → 403. Signing in again will not help.
 *   3. Step-up stale → 403 with `stepUpRequired`. Re-authenticating *will* help.
 *
 * Checking the permission before the freshness matters: a caller who will never
 * hold `export:execute` should be refused outright rather than sent to
 * re-authenticate and refused afterwards.
 */
export function authorize(
  state: AuthState,
  permission: Permission,
  options: AuthorizeOptions,
): Result<Actor, DomainError> {
  if (!isAuthenticated(state)) {
    return err(unauthenticatedError('no_session'));
  }

  const { actor } = state;

  if (!roleHasPermission(actor.role, permission)) {
    // The missing permission is not returned to the caller (ADR 0004).
    return err(forbiddenError('insufficient_permission'));
  }

  if (requiresStepUp(permission)) {
    const windowMs = options.stepUpWindowMs ?? STEP_UP_WINDOW_MS;
    const age = options.now.getTime() - actor.authenticatedAt.getTime();

    // A negative age means the recorded authentication time is in the future:
    // a clock-skew case §5.8 anticipates. Treated as stale rather than fresh,
    // because failing closed is the correct direction for an export.
    if (age < 0 || age > windowMs) {
      return err(forbiddenError('step_up_required', 'Re-authentication required.'));
    }
  }

  return ok(actor);
}

/**
 * Non-throwing predicate for UI use.
 *
 * Components ask this to decide whether to render a control. It deliberately
 * ignores step-up: hiding the export button because the session is twenty
 * minutes old would be baffling. The control renders, and the guard prompts.
 * **Never** the authorization decision itself — that is {@link authorize}, on
 * the server.
 */
export function can(state: AuthState, permission: Permission): boolean {
  return isAuthenticated(state) && roleHasPermission(state.actor.role, permission);
}
