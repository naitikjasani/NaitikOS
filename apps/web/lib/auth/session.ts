/**
 * Server-side session resolution.
 *
 * The milestone asked for no duplicated auth logic. This module is where that
 * is kept honest: **every** server-side answer to "who is this?" comes from
 * {@link getAuthState}, and every answer to "may they?" comes from
 * {@link requireServerPermission}. Layouts, route handlers, and server actions
 * all call these; none of them assembles an allowlist check or a Supabase
 * client of its own.
 */

import { cookies } from 'next/headers';
import { cache } from 'react';
import type { Result } from '@naitikos/shared';
import { isErr, isOk } from '@naitikos/shared';
import type { Actor, Allowlist, AuthState, DomainError, Permission } from '@naitikos/core';
import { ANONYMOUS, createAllowlist, resolveActor, systemClock } from '@naitikos/core';
import { createAuthAuditRecorder, createDatabase, createIdentityRepository } from '@naitikos/db';
import type { Database } from '@naitikos/db';
import { requirePermission, requireSession } from '@naitikos/api';

import { serverEnv } from '../env';
import { createReadOnlyCookieAccessor, createServerSupabase } from '../supabase/clients';
import { createSupabaseAuthProvider } from './supabase-auth-provider';

/* -------------------------------------------------------------------------
 * Process-scoped singletons
 *
 * The allowlist and the database pool are built once. The allowlist in
 * particular throws when empty (§5.4), so building it at first use turns a
 * misconfiguration into an immediate, loud failure.
 * ---------------------------------------------------------------------- */

let cachedAllowlist: Allowlist | undefined;
let cachedDb: Database | undefined;

function allowlist(): Allowlist {
  cachedAllowlist ??= createAllowlist(serverEnv().AUTH_ALLOWLIST);
  return cachedAllowlist;
}

function database(): Database {
  cachedDb ??= createDatabase(serverEnv().DATABASE_URL);
  return cachedDb;
}

/**
 * Resolve the current request's auth state.
 *
 * Wrapped in React's `cache`, which deduplicates within a single request. That
 * matters more than it looks: a protected layout, a server component, and a
 * route handler in the same render would otherwise each call
 * `supabase.auth.getUser()` — a verified network round trip apiece (see the
 * adapter's note on `getUser` vs `getSession`). One request, one verification.
 *
 * Returns `ANONYMOUS` rather than throwing when the caller is not signed in;
 * refusal is the guards' job, not this function's.
 */
export const getAuthState = cache(async (): Promise<AuthState> => {
  const cookieStore = await cookies();

  // Read-only: a Server Component cannot write cookies, and middleware has
  // already refreshed the session before this render began.
  const supabase = createServerSupabase(
    createReadOnlyCookieAccessor(() => cookieStore.getAll().map((c) => ({ name: c.name, value: c.value }))),
  );

  const provider = createSupabaseAuthProvider(supabase);
  const identity = await provider.getIdentity();

  // A provider failure is treated as anonymous rather than surfaced. A
  // transient Supabase outage should send the user to sign-in, not render a
  // stack trace over a medical record.
  if (isErr(identity)) return ANONYMOUS;

  const db = database();
  const resolved = await resolveActor(identity.value, {
    allowlist: allowlist(),
    identities: createIdentityRepository(db),
    audit: createAuthAuditRecorder(db),
    now: systemClock.now(),
  });

  // A refusal — not allowlisted, revoked, unverified — is also anonymous from
  // the perspective of rendering. It has already been audited by `resolveActor`.
  return isOk(resolved) ? resolved.value : ANONYMOUS;
});

/** The actor, or `null`. For rendering decisions only — never authorization. */
export async function getActor(): Promise<Actor | null> {
  const state = await getAuthState();
  return state.status === 'authenticated' ? state.actor : null;
}

/**
 * Require an authenticated caller.
 *
 * Returns a `Result` rather than redirecting, because the right response
 * differs by caller: a page redirects, a route handler returns 401. Deciding
 * that here would force one of them to be wrong.
 */
export async function requireServerSession(): Promise<Result<Actor, DomainError>> {
  const state = await getAuthState();
  return requireSession({
    state,
    audit: createAuthAuditRecorder(database()),
    now: systemClock.now(),
  });
}

/**
 * Require a permission, auditing the refusal.
 *
 * Delegates to `@naitikos/api`, which delegates to `core`'s `authorize`. Three
 * layers, one decision — the layering exists so the decision is testable
 * without any of the other two (§5.4).
 */
export async function requireServerPermission(
  permission: Permission,
  traceId?: string,
): Promise<Result<Actor, DomainError>> {
  const state = await getAuthState();
  return requirePermission(
    {
      state,
      audit: createAuthAuditRecorder(database()),
      now: systemClock.now(),
      ...(traceId === undefined ? {} : { traceId }),
    },
    permission,
  );
}

/** The shared database handle, for route handlers that need a repository. */
export function getDb(): Database {
  return database();
}

/** The shared allowlist, for the sign-in handler. */
export function getAllowlist(): Allowlist {
  return allowlist();
}
