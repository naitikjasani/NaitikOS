/**
 * Ports — the interfaces `core` defines and higher layers implement.
 *
 * §6.2 states the pattern for persistence, and it applies identically to auth:
 *
 *   "Repositories exist so `core` can define `interface ObservationRepository`
 *    without knowing Drizzle exists — dependency inversion, which is what
 *    actually makes the durable layer durable."
 *
 * So `core` declares what an auth provider must be able to do; the Supabase
 * adapter in `apps/web` implements it. Three things follow, and all three are
 * blueprint requirements rather than architectural taste:
 *
 *   - **§5.4's swap stays a swap.** "Migrating to any other Postgres host
 *     becomes a connection-string change plus an auth swap, rather than a
 *     rewrite." That is only true if exactly one file imports the provider SDK.
 *   - **The authorization rules are testable without a network.** §5.4 puts
 *     authorization in the API layer specifically because it is "testable,
 *     readable, and version-controlled"; a fake implementing this interface is
 *     what makes the first adjective true.
 *   - **`core` keeps zero framework imports** (§5.0). No `@supabase/*` here,
 *     and the boundary lint rule fails the build if that changes.
 */

import type { Result } from '@naitikos/shared';

import type { DomainError } from '../errors/domain-error';
import type { Role } from './roles';
import type { AuthStrategy } from './strategies';

/**
 * An identity as the provider knows it — before any of this system's rules
 * have been applied.
 *
 * Deliberately *not* an {@link Actor}. An `Actor` has passed the allowlist and
 * carries a role from this application's own data; a `ProviderIdentity` has
 * merely presented a valid credential. Conflating the two is how an
 * unallowlisted account ends up authorized, so the type system keeps them
 * apart and {@link resolveActor} is the only bridge.
 */
export type ProviderIdentity = {
  readonly subjectId: string;
  readonly email: string;
  /** Whether the provider considers the address verified. */
  readonly emailVerified: boolean;
  /** When this session last proved possession of a credential. */
  readonly authenticatedAt: Date;
  readonly strategy: AuthStrategy;
};

/** Credentials for the password strategy. */
export type PasswordCredentials = {
  readonly email: string;
  readonly password: string;
};

/**
 * What an auth provider must be able to do.
 *
 * Every method returns `Result` rather than throwing — §5.12: "Exceptions are
 * reserved for genuine bugs, not for expected outcomes", and a wrong password
 * is an expected outcome.
 *
 * Methods for strategies that are not yet enabled are present and optional.
 * Declaring them now costs nothing and documents the intended shape, so
 * enabling magic link later is an implementation rather than an interface
 * change — which is the difference between a one-file diff and a refactor.
 */
export type AuthProvider = {
  /**
   * Verify credentials and establish a session.
   *
   * Implementations must not distinguish "no such user" from "wrong password"
   * in the returned error. Doing so turns the sign-in form into an account
   * enumeration oracle, and at n=1 the single valid address is the one thing
   * worth not confirming.
   */
  signInWithPassword(credentials: PasswordCredentials): Promise<Result<ProviderIdentity, DomainError>>;

  /** Read the current session, if any. Called on every protected request. */
  getIdentity(): Promise<Result<ProviderIdentity | null, DomainError>>;

  /**
   * Refresh an expiring session.
   *
   * Must be idempotent and safe to call concurrently: §5.7's outbox drains in
   * parallel with page loads, and two simultaneous refreshes of the same token
   * must not invalidate each other.
   */
  refresh(): Promise<Result<ProviderIdentity | null, DomainError>>;

  /**
   * End the session.
   *
   * Must revoke server-side, not merely clear the cookie. A logout that only
   * deletes a local cookie leaves a valid token in whatever else holds it,
   * which is the difference between signing out and hiding the evidence.
   */
  signOut(): Promise<Result<void, DomainError>>;

  /**
   * Re-prove a credential without starting a new session, for §5.4's step-up.
   *
   * Separate from {@link signInWithPassword} because the existing session must
   * survive: an export that prompts for a password and then signs the user out
   * of their own tab is a worse experience than no step-up at all.
   */
  reauthenticate?(credentials: PasswordCredentials): Promise<Result<ProviderIdentity, DomainError>>;

  /** Begin an OAuth redirect. Returns the URL to send the browser to. */
  startOAuth?(strategy: AuthStrategy, redirectTo: string): Promise<Result<string, DomainError>>;

  /** Exchange an OAuth or magic-link code for a session. */
  exchangeCodeForSession?(code: string): Promise<Result<ProviderIdentity, DomainError>>;

  /** Send a magic link (§5.4's specified strategy, not yet enabled). */
  sendMagicLink?(email: string, redirectTo: string): Promise<Result<void, DomainError>>;
};

/**
 * Where this application's own identity data lives.
 *
 * Split from {@link AuthProvider} on purpose. The provider owns credentials;
 * this owns the profile, the role, and the preferences — application data that
 * must survive a provider migration untouched (§5.4, P2).
 */
export type IdentityRepository = {
  /**
   * Find the role for a verified subject.
   *
   * Returns `null` when no profile exists yet. That is a real state, not an
   * error: the first sign-in of a fresh installation happens before the profile
   * row does, and treating it as a failure would make bootstrapping impossible.
   */
  findRoleBySubject(subjectId: string): Promise<Result<Role | null, DomainError>>;

  /**
   * Bind a provider subject to the singleton profile on first sign-in.
   *
   * Must be idempotent — two tabs racing through a first sign-in must not
   * produce two profiles, and C1 says there is exactly one, forever.
   */
  linkSubject(subjectId: string, email: string): Promise<Result<Role, DomainError>>;
};

/**
 * A recorder for security-relevant events.
 *
 * §9.4 requires the audit log to be append-only and permanent; this is the
 * narrow slice of it that auth writes to. It is a port rather than a direct
 * call so `core` can express "this must be audited" without importing the
 * database — and so tests can assert that a refusal *was* recorded, which is
 * the sort of thing that silently stops working.
 */
export type AuthAuditRecorder = {
  record(event: AuthAuditEvent): Promise<void>;
};

/**
 * A security-relevant event.
 *
 * No user content, ever — §5.13. `email` is present because it is the identity
 * being asserted and an audit trail without it answers nothing; nothing else
 * about the request body is.
 */
export type AuthAuditEvent = {
  readonly kind:
    | 'sign_in_succeeded'
    | 'sign_in_failed'
    | 'sign_out'
    | 'session_refreshed'
    | 'allowlist_rejected'
    | 'authorization_denied'
    | 'step_up_required'
    | 'step_up_succeeded'
    | 'rate_limited';
  readonly email?: string;
  readonly subjectId?: string;
  readonly strategy?: AuthStrategy;
  /** The permission that was refused. Logged, never returned (ADR 0004). */
  readonly permission?: string;
  readonly occurredAt: Date;
  /** Correlates with the request that produced it (§5.13). */
  readonly traceId?: string;
  /** Coarse client hint. Never a full user-agent string or a raw IP. */
  readonly clientHint?: string;
};
