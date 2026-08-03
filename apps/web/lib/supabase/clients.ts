/**
 * Supabase client construction — the only place `@supabase/ssr` is imported.
 *
 * §5.4's migration promise depends on this being true: "Migrating to any other
 * Postgres host becomes a connection-string change plus an auth swap, rather
 * than a rewrite." An auth swap is a swap only if the SDK has one entry point.
 *
 * Three clients, because the App Router has three cookie situations and they
 * are genuinely different:
 *
 *   | Context            | Can write cookies | Used by                        |
 *   |--------------------|-------------------|--------------------------------|
 *   | Browser            | yes               | client components               |
 *   | Server component   | **no**            | reading a session during render |
 *   | Route / middleware | yes               | sign-in, sign-out, refresh      |
 *
 * The middle row is the one that catches people. A React Server Component
 * cannot set a cookie — the response headers are already committed — so a
 * refresh attempted during render silently fails. That is why session
 * *refresh* happens in middleware and nowhere else.
 */

import { createBrowserClient, createServerClient } from '@supabase/ssr';
import type { CookieOptions } from '@supabase/ssr';

import { clientEnv } from '../env';

/**
 * Cookie policy for the session.
 *
 * §5.4 sets a thirty-day sliding session; these attributes are what make it
 * safe to keep one that long.
 *
 * `httpOnly` is the important one and it is *not* set here — `@supabase/ssr`
 * sets it on the auth cookies itself. What this object controls is everything
 * else, and each choice matters:
 *
 *   - `sameSite: 'lax'` — blocks cross-site POST entirely, while still allowing
 *     the top-level GET navigation that an OAuth callback and a magic link both
 *     depend on. `strict` would break both.
 *   - `secure` — always in production. Omitted on localhost only because
 *     browsers refuse `Secure` cookies over plain http, which would make local
 *     development impossible rather than more secure.
 *   - `path: '/'` — the session applies to the whole app.
 */
export const SESSION_COOKIE_OPTIONS: CookieOptions = {
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  path: '/',
  maxAge: 30 * 24 * 60 * 60,
};

/**
 * The browser client.
 *
 * Used only for auth state changes and sign-out. **Never for data** — §5.4:
 * "No client-direct-to-database access. This forgoes Supabase's headline
 * feature deliberately." Data goes through route handlers so invariants live
 * in one place and the offline outbox has one replay target.
 */
export function createBrowserSupabase() {
  return createBrowserClient(clientEnv.NEXT_PUBLIC_SUPABASE_URL, clientEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookieOptions: SESSION_COOKIE_OPTIONS,
  });
}

/** Minimal cookie surface, so this module does not depend on Next's types. */
export type CookieAccessor = {
  getAll(): { name: string; value: string }[];
  setAll(cookies: { name: string; value: string; options?: CookieOptions }[]): void;
};

/**
 * A server client bound to a request's cookies.
 *
 * @param cookies - accessor whose `setAll` may be a no-op in a Server
 *   Component. That is expected and is why {@link createReadOnlyCookieAccessor}
 *   exists rather than the caller being trusted to remember.
 */
export function createServerSupabase(cookies: CookieAccessor) {
  return createServerClient(
    clientEnv.NEXT_PUBLIC_SUPABASE_URL,
    clientEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookieOptions: SESSION_COOKIE_OPTIONS,
      cookies: {
        getAll: () => cookies.getAll(),
        setAll: (toSet) => {
          cookies.setAll(toSet);
        },
      },
    },
  );
}

/**
 * Wrap a read-only cookie store so writes are dropped explicitly.
 *
 * Server Components cannot set cookies. Without this wrapper, `@supabase/ssr`
 * attempts a write, Next throws, and the render fails with an error about
 * cookies that says nothing about auth. Swallowing it here is correct because
 * middleware has already refreshed the session before the render began — the
 * write would be redundant, not lost.
 */
export function createReadOnlyCookieAccessor(
  getAll: () => { name: string; value: string }[],
): CookieAccessor {
  return {
    getAll,
    setAll: () => {
      /* Intentionally empty. See above: middleware owns cookie writes. */
    },
  };
}
