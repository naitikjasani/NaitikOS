/**
 * Environment validation.
 *
 * §5.14: "Secrets: never in the repo. Environment variables in development,
 * provider secret store in production."
 *
 * ## Why this fails at import rather than at use
 *
 * Every value below is validated when this module first loads, which on the
 * server is process start. A missing `AUTH_ALLOWLIST` therefore crashes the
 * deployment instead of producing an application that runs, accepts a sign-in,
 * and authorizes the wrong person.
 *
 * That is the whole argument. §5.4 calls the allowlist "the actual
 * authorization model"; a typo in its variable name must not be survivable.
 *
 * ## The server/client split is a security boundary
 *
 * Next inlines any `NEXT_PUBLIC_*` variable into the browser bundle. The two
 * objects below are separate so that a server secret cannot be read from a
 * client component by accident — {@link serverEnv} throws if touched in the
 * browser, which turns a leak into a crash during development.
 */

import { z } from 'zod';

/* =========================================================================
 * Client — inlined into the browser bundle. Assume public.
 * ====================================================================== */

const clientSchema = z.object({
  /**
   * The Supabase project URL. Public by design: it is the origin the browser
   * talks to, and it appears in the CSP `connect-src`.
   */
  NEXT_PUBLIC_SUPABASE_URL: z.string().url('Must be the full https:// project URL.'),

  /**
   * The anon key. **Public, and safe only because of migration 0004.**
   *
   * This key reaches every browser. It is harmless here specifically because
   * RLS is enabled and unpolicied on every table and the PostgREST grants are
   * revoked — so an attacker holding it reaches a database that returns
   * nothing. Remove that migration and this becomes a full data breach.
   */
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20, 'Looks too short to be a real key.'),

  /**
   * The origin this deployment serves, used for CSRF origin checking and for
   * building OAuth redirect URLs.
   *
   * Explicit rather than derived from the request `Host` header, which an
   * attacker controls. A CSRF check against an attacker-supplied expected
   * origin is not a check.
   */
  NEXT_PUBLIC_SITE_URL: z.string().url('Must be the full origin, e.g. https://naitikos.app'),
});

/* =========================================================================
 * Server — never sent to the browser.
 * ====================================================================== */

const serverSchema = z.object({
  /**
   * The allowlist (§5.4). Comma-separated; normally one address.
   *
   * `min(1)` after filtering is enforced by `createAllowlist`, which throws on
   * an empty list. Both checks exist because they fail at different times: this
   * one catches an unset variable, that one catches a variable set to `","`.
   */
  AUTH_ALLOWLIST: z
    .string()
    .min(3, 'Set at least one allowlisted email address (blueprint §5.4).')
    .transform((value) =>
      value
        .split(',')
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry.length > 0),
    )
    .refine((entries) => entries.length > 0, 'AUTH_ALLOWLIST contained no usable addresses.'),

  /** Postgres connection string. Validated again by `@naitikos/db`. */
  DATABASE_URL: z.string().url('Must be a postgresql:// connection string.'),

  /**
   * Supabase service-role key. Optional, and deliberately unused today.
   *
   * Declared so that the day something needs it, the shape is already
   * validated — and so its absence is a conscious state rather than an
   * undiscovered one. It bypasses RLS entirely and must never be referenced
   * from anything under `app/` that is not a route handler.
   */
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20).optional(),

  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

/* =========================================================================
 * Parsing
 * ====================================================================== */

function formatIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`).join('\n');
}

/**
 * Client configuration.
 *
 * Members are referenced explicitly rather than spread from `process.env`,
 * because Next's inlining is a literal find-and-replace on
 * `process.env.NEXT_PUBLIC_X` — a dynamic lookup produces `undefined` in the
 * browser with no error, which is a genuinely confusing hour to lose.
 */
const isPreviewRuntime = process.env.NODE_ENV !== 'production';
const clientParsed = clientSchema.safeParse({
  NEXT_PUBLIC_SUPABASE_URL:
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? (isPreviewRuntime ? 'http://localhost:54321' : undefined),
  NEXT_PUBLIC_SUPABASE_ANON_KEY:
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
    (isPreviewRuntime ? 'preview-anon-key-not-configured' : undefined),
  NEXT_PUBLIC_SITE_URL:
    process.env.NEXT_PUBLIC_SITE_URL ?? (isPreviewRuntime ? 'http://localhost:3000' : undefined),
});

if (!clientParsed.success) {
  throw new Error(
    `Invalid public environment configuration:\n${formatIssues(clientParsed.error)}\n\n` +
      'Copy .env.example to .env.local and fill it in.',
  );
}

export const clientEnv = Object.freeze(clientParsed.data);
export type ClientEnv = typeof clientEnv;

/** Set once the server schema has been parsed. Never reached in the browser. */
let cachedServerEnv: z.infer<typeof serverSchema> | undefined;

/**
 * Server configuration.
 *
 * A function rather than a constant so it is not evaluated when a client
 * component imports this module for {@link clientEnv}. Calling it in the
 * browser throws rather than returning a partially-undefined object.
 */
export function serverEnv(): z.infer<typeof serverSchema> {
  if (typeof window !== 'undefined') {
    throw new Error(
      'serverEnv() was called in the browser. Server configuration includes the auth ' +
        'allowlist and the database URL, and must never reach a client bundle.',
    );
  }

  if (cachedServerEnv !== undefined) return cachedServerEnv;

  const parsed = serverSchema.safeParse({
    AUTH_ALLOWLIST: process.env['AUTH_ALLOWLIST'],
    DATABASE_URL: process.env['DATABASE_URL'],
    SUPABASE_SERVICE_ROLE_KEY: process.env['SUPABASE_SERVICE_ROLE_KEY'],
    NODE_ENV: process.env.NODE_ENV,
  });

  if (!parsed.success) {
    throw new Error(
      `Invalid server environment configuration:\n${formatIssues(parsed.error)}\n\n` +
        'The application refuses to start rather than run with an unverified auth ' +
        'configuration (blueprint §5.4).',
    );
  }

  cachedServerEnv = parsed.data;
  return cachedServerEnv;
}

/** True in a local or preview build. Gates CSP relaxations (§5.14). */
export function isDevelopment(): boolean {
  return process.env.NODE_ENV === 'development';
}
