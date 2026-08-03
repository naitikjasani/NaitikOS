/**
 * The Supabase adapter for `core`'s {@link AuthProvider} port.
 *
 * This is the "auth swap" boundary §5.4 describes. Everything above it — the
 * allowlist, the role matrix, the step-up window, every guard — is written
 * against the interface and does not know Supabase exists. Replacing the
 * provider means rewriting this file and nothing else.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthError, User } from '@supabase/supabase-js';
import type { Result } from '@naitikos/shared';
import { err, ok } from '@naitikos/shared';
import type { AuthProvider, DomainError, PasswordCredentials, ProviderIdentity } from '@naitikos/core';
import { forbiddenError, unauthenticatedError, validationError } from '@naitikos/core';

/**
 * Map a Supabase user to a provider identity.
 *
 * `authenticatedAt` comes from `last_sign_in_at`, not from the token's `iat`.
 * The distinction is load-bearing for step-up (§5.4): a session refreshed
 * silently for thirty days has a *recent* token and a *stale* authentication,
 * and using `iat` would let a month-old session export a medical record without
 * re-prompting.
 */
function toIdentity(user: User, strategy: ProviderIdentity['strategy']): ProviderIdentity | null {
  const email = user.email;
  if (email === undefined || email === '') return null;

  const lastSignIn = user.last_sign_in_at;

  return {
    subjectId: user.id,
    email,
    // Supabase sets `email_confirmed_at` when the address is verified. Absent
    // means unverified, which `resolveActor` refuses.
    emailVerified: user.email_confirmed_at != null,
    /**
     * Parsing a timestamp the provider supplied, not reading the wall clock.
     * §11.3's ban targets the latter — an ambient `new Date()` silently adopts
     * the runtime's zone. This adopts Supabase's, which is UTC and explicit.
     *
     * The epoch fallback is deliberately the *oldest possible* instant: a user
     * with no recorded sign-in is treated as maximally stale, so step-up
     * (§5.4) demands re-authentication rather than waving them through.
     */
    // eslint-disable-next-line no-restricted-syntax -- Parsing a provider-supplied ISO timestamp, not reading wall time. See above.
    authenticatedAt: lastSignIn == null ? new Date(0) : new Date(lastSignIn),
    strategy,
  };
}

/**
 * Translate a provider error.
 *
 * **Every credential failure returns the same error.** Supabase distinguishes
 * "user not found" from "invalid password"; surfacing that distinction would
 * make the sign-in form an account-enumeration oracle, and with a single valid
 * address the one thing worth not confirming is which address it is.
 *
 * Rate limiting is passed through as-is, because a client that is being
 * throttled by the provider needs to know that rather than retry.
 */
function toDomainError(error: AuthError): DomainError {
  if (error.status === 429) {
    return forbiddenError('insufficient_permission', 'Too many attempts. Try again shortly.');
  }

  if (error.status === 400 || error.status === 401) {
    return unauthenticatedError('invalid_token', 'Those credentials are not valid.');
  }

  // Anything else is a genuine provider fault. The message is the provider's
  // and is developer-facing only; it never contains user content.
  return validationError('auth_provider_error', error.message);
}

export function createSupabaseAuthProvider(client: SupabaseClient): AuthProvider {
  return {
    async signInWithPassword(
      credentials: PasswordCredentials,
    ): Promise<Result<ProviderIdentity, DomainError>> {
      const { data, error } = await client.auth.signInWithPassword({
        email: credentials.email,
        password: credentials.password,
      });

      if (error !== null) return err(toDomainError(error));

      const identity = data.user === null ? null : toIdentity(data.user, 'password');
      if (identity === null) {
        return err(unauthenticatedError('invalid_token', 'Those credentials are not valid.'));
      }

      return ok(identity);
    },

    async getIdentity(): Promise<Result<ProviderIdentity | null, DomainError>> {
      /**
       * `getUser`, never `getSession`.
       *
       * `getSession` reads the cookie and trusts it. `getUser` verifies the JWT
       * against the auth server. On a server that is the difference between
       * checking a credential and believing one — a forged cookie passes
       * `getSession` and fails `getUser`.
       *
       * It costs a network round trip per protected request, which is the price
       * of the guarantee and is why middleware does it once rather than every
       * component doing it.
       */
      const { data, error } = await client.auth.getUser();

      if (error !== null) {
        // A missing session is not an error condition — an anonymous visitor on
        // a public page reaches here constantly.
        if (error.status === 401 || error.status === 400) return ok(null);
        return err(toDomainError(error));
      }

      if (data.user === null) return ok(null);

      const strategy = inferStrategy(data.user);
      return ok(toIdentity(data.user, strategy));
    },

    async refresh(): Promise<Result<ProviderIdentity | null, DomainError>> {
      const { data, error } = await client.auth.refreshSession();

      if (error !== null) {
        // An expired or revoked refresh token means signed out, not broken.
        if (error.status === 401 || error.status === 400) return ok(null);
        return err(toDomainError(error));
      }

      if (data.user === null) return ok(null);
      return ok(toIdentity(data.user, inferStrategy(data.user)));
    },

    async signOut(): Promise<Result<void, DomainError>> {
      /**
       * `scope: 'global'` — revoke every session, not just this browser's.
       *
       * The port's contract requires server-side revocation: "A logout that
       * only deletes a local cookie leaves a valid token in whatever else holds
       * it, which is the difference between signing out and hiding the
       * evidence." On a phone that may have been handed to someone, local-only
       * sign-out is not sign-out.
       */
      const { error } = await client.auth.signOut({ scope: 'global' });
      if (error !== null) return err(toDomainError(error));
      return ok(undefined);
    },

    async reauthenticate(
      credentials: PasswordCredentials,
    ): Promise<Result<ProviderIdentity, DomainError>> {
      /**
       * Step-up (§5.4).
       *
       * Implemented as a fresh password sign-in, which Supabase treats as
       * establishing a session for the same user — updating `last_sign_in_at`
       * and therefore the step-up clock. The existing session survives because
       * it is the same subject; the port's requirement that "the existing
       * session must survive" is met.
       *
       * A dedicated re-auth endpoint would be cleaner. Supabase's
       * `reauthenticate()` sends a one-time code by email and is built for a
       * different flow, so this is the honest option available today. Recorded
       * in docs/auth.md as debt.
       */
      const { data, error } = await client.auth.signInWithPassword({
        email: credentials.email,
        password: credentials.password,
      });

      if (error !== null) return err(toDomainError(error));

      const identity = data.user === null ? null : toIdentity(data.user, 'password');
      if (identity === null) {
        return err(unauthenticatedError('invalid_token', 'Those credentials are not valid.'));
      }

      return ok(identity);
    },

    async startOAuth(strategy, redirectTo): Promise<Result<string, DomainError>> {
      // Only Google is modelled today, and it is disabled in the registry. The
      // guard is here rather than at the call site so an enabled-but-unmapped
      // strategy cannot silently start a redirect to nowhere.
      if (strategy !== 'oauth_google') {
        return err(validationError('unsupported_strategy', `No OAuth mapping for "${strategy}".`));
      }

      const { data, error } = await client.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo,
          // `consent` rather than the default: it forces the account chooser,
          // so a shared machine does not silently reuse a signed-in Google
          // account. Worth the extra click on a health record.
          queryParams: { prompt: 'consent' },
          skipBrowserRedirect: true,
        },
      });

      if (error !== null) return err(toDomainError(error));
      if (data.url === null) {
        return err(validationError('oauth_no_url', 'The provider returned no redirect URL.'));
      }

      return ok(data.url);
    },

    async exchangeCodeForSession(code: string): Promise<Result<ProviderIdentity, DomainError>> {
      const { data, error } = await client.auth.exchangeCodeForSession(code);

      if (error !== null) return err(toDomainError(error));

      const identity = data.user === null ? null : toIdentity(data.user, inferStrategy(data.user));
      if (identity === null) {
        return err(unauthenticatedError('invalid_token', 'That sign-in link is not valid.'));
      }

      return ok(identity);
    },

    async sendMagicLink(email: string, redirectTo: string): Promise<Result<void, DomainError>> {
      /**
       * §5.4's specified strategy, wired but disabled in the registry.
       *
       * `shouldCreateUser: false` is the important argument: §5.4 requires
       * sign-up to be disabled at the provider, and without this a magic link
       * to an unknown address would *create* that account. The allowlist would
       * still refuse it at sign-in, but an attacker-created row in `auth.users`
       * is a worse starting position than no row.
       */
      const { error } = await client.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: redirectTo, shouldCreateUser: false },
      });

      if (error !== null) return err(toDomainError(error));
      return ok(undefined);
    },
  };
}

/**
 * Infer which strategy produced the current session.
 *
 * Supabase records the identity providers on the user. `email` covers both
 * password and magic link — it cannot distinguish them, so password is assumed,
 * which is correct while it is the only enabled email strategy. Revisit when
 * magic link is turned on.
 */
function inferStrategy(user: User): ProviderIdentity['strategy'] {
  const providers = user.app_metadata['providers'];
  if (Array.isArray(providers) && providers.includes('google')) return 'oauth_google';
  return 'password';
}
