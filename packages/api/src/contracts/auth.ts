/**
 * Auth contracts — Zod schemas imported by both client and server.
 *
 * §6.2 explains why these live in a package rather than in the app: "it is
 * imported by client and server, and the shared import is what makes the type
 * safety real rather than aspirational."
 *
 * §5.1 adds the rule that makes them worth writing: "The same Zod schema
 * validates the form, the route handler, and the domain object. One definition,
 * three enforcement points."
 */

import { z } from 'zod';
import {
  AUTH_STRATEGIES,
  DENSITIES,
  MOTION_PREFERENCES,
  NOTIFICATION_CATEGORIES,
  ROLES,
  THEMES,
  UNIT_SYSTEMS,
  isValidLocale,
  isValidTimezone,
} from '@naitikos/core';

/* =========================================================================
 * Primitives
 * ====================================================================== */

/**
 * An email address.
 *
 * Trimmed and lowercased *in the schema*, so the normalised form is the only
 * one that exists past this boundary — matching `normaliseEmail` in core. A
 * transform here is worth more than a convention: it means no handler can
 * forget, and the allowlist never sees a mixed-case address.
 *
 * The 254-character cap is RFC 5321's limit on a forward path. It also stops a
 * megabyte of text reaching the auth provider.
 */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'Enter an email address.')
  .max(254, 'That email address is too long.')
  .email('Enter a valid email address.');

/**
 * A password.
 *
 * Minimum twelve, maximum 128, and **no composition rules** — no "one uppercase
 * and one symbol". Those rules are known to produce weaker passwords by pushing
 * people toward `Password1!`, and NIST SP 800-63B has advised against them for
 * years. Length is the property that matters.
 *
 * The 128 cap is not arbitrary either: bcrypt-family hashes truncate or slow
 * dramatically on very long inputs, and an unbounded password field is a cheap
 * CPU-exhaustion vector on an endpoint that must stay available.
 *
 * There is deliberately no breach-corpus check here. It would need a network
 * call on the sign-in path, and §5.14's threat model does not include an
 * attacker who already knows the single allowlisted address *and* its password
 * from another breach — at which point the allowlist is the only control left,
 * and it holds.
 */
export const passwordSchema = z
  .string()
  .min(12, 'Use at least 12 characters.')
  .max(128, 'Use at most 128 characters.');

/**
 * A post-sign-in destination.
 *
 * **Relative paths only.** This is an open-redirect guard and it is written as
 * a whitelist of shape rather than a blacklist of hosts: must start with a
 * single `/`, must not start with `//` (protocol-relative, which browsers treat
 * as absolute), and must not contain a backslash (some parsers normalise `\` to
 * `/`, so `/\evil.com` can escape a naive check).
 */
export const redirectPathSchema = z
  .string()
  .max(512)
  .refine((value) => value.startsWith('/'), 'Redirect must be a relative path.')
  .refine((value) => !value.startsWith('//'), 'Redirect must not be protocol-relative.')
  .refine((value) => !value.includes('\\'), 'Redirect must not contain a backslash.')
  .refine((value) => !value.toLowerCase().startsWith('/%2f'), 'Redirect must not be encoded-absolute.');

/* =========================================================================
 * Requests
 * ====================================================================== */

export const signInRequestSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  redirectTo: redirectPathSchema.optional(),
});
export type SignInRequest = z.infer<typeof signInRequestSchema>;

/**
 * Step-up re-authentication (§5.4).
 *
 * No email: the caller is already authenticated and the server knows who they
 * are. Accepting an address here would let a step-up prompt be used to probe
 * which addresses exist.
 */
export const stepUpRequestSchema = z.object({
  password: passwordSchema,
});
export type StepUpRequest = z.infer<typeof stepUpRequestSchema>;

/** Sign-out takes no body. Declared so the contract is explicit rather than absent. */
export const signOutRequestSchema = z.object({}).strict();
export type SignOutRequest = z.infer<typeof signOutRequestSchema>;

/* =========================================================================
 * Responses
 * ====================================================================== */

export const roleSchema = z.enum(ROLES);
export const strategySchema = z.enum(AUTH_STRATEGIES);

/**
 * The session as the client sees it.
 *
 * Note what is absent: no access token, no refresh token, no provider subject.
 * Tokens live in httpOnly cookies and must never reach JavaScript — putting one
 * in a response body would make every XSS a session theft. The subject id is
 * withheld because the client has no use for it and it is a stable identifier
 * worth not scattering.
 */
export const sessionResponseSchema = z.object({
  status: z.literal('authenticated'),
  email: z.string(),
  role: roleSchema,
  strategy: strategySchema,
  /** ISO 8601. Drives the client's step-up countdown. */
  authenticatedAt: z.string(),
  /** Permissions this role holds, so the UI can render without a second call. */
  permissions: z.array(z.string()),
});

export const anonymousSessionSchema = z.object({
  status: z.literal('anonymous'),
});

export const sessionEnvelopeSchema = z.discriminatedUnion('status', [
  sessionResponseSchema,
  anonymousSessionSchema,
]);
export type SessionEnvelope = z.infer<typeof sessionEnvelopeSchema>;

export const signInResponseSchema = z.object({
  session: sessionResponseSchema,
  redirectTo: z.string(),
});
export type SignInResponse = z.infer<typeof signInResponseSchema>;

/* =========================================================================
 * Profile and preferences
 * ====================================================================== */

export const profileIdentitySchema = z.object({
  displayName: z.string().trim().min(1, 'Enter a name.').max(120),
  // Validated against the runtime's own zone database rather than a bundled
  // list, which would go stale. §5.3 makes this load-bearing.
  timezone: z.string().refine(isValidTimezone, 'Not a recognised IANA time zone.'),
  locale: z.string().refine(isValidLocale, 'Not a well-formed locale.'),
  unitSystem: z.enum(UNIT_SYSTEMS),
});
export type ProfileIdentityPayload = z.infer<typeof profileIdentitySchema>;

/** Every field optional — a PATCH, so absent means "leave alone". */
export const profileUpdateSchema = profileIdentitySchema.partial();
export type ProfileUpdatePayload = z.infer<typeof profileUpdateSchema>;

export const notificationPreferencesSchema = z.object(
  Object.fromEntries(NOTIFICATION_CATEGORIES.map((c) => [c, z.boolean()])) as Record<
    (typeof NOTIFICATION_CATEGORIES)[number],
    z.ZodBoolean
  >,
);

export const preferencesSchema = z.object({
  theme: z.enum(THEMES),
  density: z.enum(DENSITIES),
  motion: z.enum(MOTION_PREFERENCES),
  notifications: notificationPreferencesSchema,
});
export type PreferencesPayload = z.infer<typeof preferencesSchema>;

export const preferencesUpdateSchema = preferencesSchema.partial();
export type PreferencesUpdatePayload = z.infer<typeof preferencesUpdateSchema>;
