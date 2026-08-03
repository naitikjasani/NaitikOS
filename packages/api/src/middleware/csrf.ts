/**
 * CSRF protection.
 *
 * ## Why this exists at all when cookies are `SameSite=Lax`
 *
 * `SameSite=Lax` already blocks the classic attack: a cross-site form POST does
 * not carry the session cookie. That covers most of the surface, and on a
 * modern browser it covers it well.
 *
 * It is not sufficient on its own, for three reasons worth writing down because
 * each one is a case where someone reasonably concludes "Lax is enough":
 *
 *   1. **Lax permits top-level GET navigation.** Any state change reachable by
 *      GET is unprotected. The defence is not a token — it is never mutating on
 *      GET, which {@link isStateChangingMethod} encodes.
 *   2. **Browsers disagree.** Older Safari has documented `SameSite` bugs, and
 *      §5.4's thirty-day session means a stale browser stays signed in for a
 *      month.
 *   3. **Defence in depth is the house style.** §5.4 enables RLS "as defence in
 *      depth" against a path the architecture already forbids. Same reasoning.
 *
 * ## The mechanism: double-submit with an origin check
 *
 * A signed token in a cookie, echoed in a header. The attacker cannot read the
 * cookie (different origin) and so cannot set the header to match.
 *
 * **Origin checking is the primary defence and the token is the backup**, which
 * is the opposite of how double-submit is usually presented. An `Origin` header
 * is attached by the browser and unforgeable by page script; a double-submit
 * token can be defeated by a subdomain that can write cookies. This application
 * has no subdomains today — and "today" is exactly the assumption that changes
 * without anyone revisiting the CSRF code.
 */

/** Methods that may change state, per RFC 9110. */
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE']);

export function isStateChangingMethod(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase());
}

export const CSRF_COOKIE_NAME = 'naitikos-csrf';
export const CSRF_HEADER_NAME = 'x-naitikos-csrf';

/** 256 bits, base64url. */
export function generateCsrfToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Constant-time string comparison.
 *
 * A token comparison is the textbook case for this: the attacker controls one
 * side and can measure the response, which is precisely the setup a timing
 * attack needs.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  if (left.length !== right.length) return false;

  let difference = 0;
  for (let i = 0; i < left.length; i += 1) {
    difference |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return difference === 0;
}

export type CsrfCheckInput = {
  readonly method: string;
  /** The `Origin` header, if the browser sent one. */
  readonly origin: string | null;
  /** Fallback when `Origin` is absent — some older browsers on same-origin POST. */
  readonly referer: string | null;
  /** The origin this deployment serves, from validated environment config. */
  readonly expectedOrigin: string;
  readonly cookieToken: string | null;
  readonly headerToken: string | null;
};

export type CsrfResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: CsrfFailureReason };

export type CsrfFailureReason =
  | 'origin_mismatch'
  | 'origin_missing'
  | 'token_missing'
  | 'token_mismatch';

/**
 * Verify a state-changing request.
 *
 * Safe methods pass unconditionally — but see {@link isStateChangingMethod}:
 * the real rule is that a GET must not mutate, and no token can enforce that.
 */
export function verifyCsrf(input: CsrfCheckInput): CsrfResult {
  if (!isStateChangingMethod(input.method)) return { ok: true };

  /* --- 1. Origin, the primary defence ------------------------------- */
  const stated = input.origin ?? originOf(input.referer);

  if (stated === null) {
    // Neither header present on a state-changing request. Refused rather than
    // waved through: a modern browser always sends one, so absence means
    // either a non-browser client (which should use a token deliberately) or
    // something stripping headers.
    return { ok: false, reason: 'origin_missing' };
  }

  if (stated !== input.expectedOrigin) {
    return { ok: false, reason: 'origin_mismatch' };
  }

  /* --- 2. Double-submit token, the backup --------------------------- */
  if (
    input.cookieToken === null ||
    input.headerToken === null ||
    input.cookieToken === '' ||
    input.headerToken === ''
  ) {
    return { ok: false, reason: 'token_missing' };
  }

  if (!timingSafeEqual(input.cookieToken, input.headerToken)) {
    return { ok: false, reason: 'token_mismatch' };
  }

  return { ok: true };
}

/** Reduce a Referer URL to its origin. Returns null if unparseable. */
function originOf(referer: string | null): string | null {
  if (referer === null || referer === '') return null;
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

/**
 * Cookie attributes for the CSRF token.
 *
 * **`httpOnly: false` is required, not an oversight.** Double-submit works by
 * having client JavaScript read the cookie and echo it in a header; an
 * httpOnly cookie cannot be read and the scheme cannot function.
 *
 * That is safe here because the token is not a credential. Knowing it grants
 * nothing — the security property comes from an attacker on another origin
 * being unable to *read* it, which the same-origin policy provides regardless
 * of `httpOnly`. The session token, which *is* a credential, is httpOnly and
 * set elsewhere.
 */
export const CSRF_COOKIE_OPTIONS = Object.freeze({
  name: CSRF_COOKIE_NAME,
  httpOnly: false,
  sameSite: 'lax' as const,
  secure: true,
  path: '/',
  /** Matches §5.4's thirty-day sliding session, so the two expire together. */
  maxAge: 30 * 24 * 60 * 60,
});
