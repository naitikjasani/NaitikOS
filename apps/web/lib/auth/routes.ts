/**
 * Route classification.
 *
 * A single declarative table, consumed by both the middleware and the layouts.
 * The alternative — each route deciding for itself whether it is public — is
 * how a route ends up unprotected because someone forgot, which is the failure
 * mode this file exists to remove.
 *
 * **Default deny.** Anything not matched below is protected. That is the whole
 * design: adding a route makes it private automatically, and making it public
 * requires an explicit entry that a reader will notice.
 */

/** Prefixes reachable without a session. */
const PUBLIC_PREFIXES: readonly string[] = [
  '/auth/sign-in',
  '/auth/callback',
  '/auth/error',
  // The offline shell (§5.7) must render with no session — a phone in a gym
  // basement cannot verify one.
  '/offline',
];

/** Paths the middleware skips entirely: no auth, no session refresh. */
const UNGUARDED_PREFIXES: readonly string[] = [
  '/_next',
  '/favicon.ico',
  '/manifest.webmanifest',
  '/icons',
  '/robots.txt',
  /*
   * The service worker.
   *
   * Not merely convenient — a redirect here breaks registration outright.
   * `navigator.serviceWorker.register` requires a same-origin response with a
   * JavaScript MIME type, and the guard's 307 to the sign-in page is neither.
   * The symptom is silent: registration rejects, the offline shell never
   * caches, and the failure is only visible in a gym basement.
   */
  '/sw.js',
];

/** API routes that must work without a session — the sign-in endpoint itself. */
const PUBLIC_API_PREFIXES: readonly string[] = [
  '/api/auth/sign-in',
  '/api/auth/session',
  '/api/auth/callback',
];

/** Where an authenticated user lands. §3.2: "Default route is `/today`." */
export const DEFAULT_AUTHENTICATED_PATH = '/today';

export const SIGN_IN_PATH = '/auth/sign-in';
export const AUTH_ERROR_PATH = '/auth/error';

function matches(pathname: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export function isUnguarded(pathname: string): boolean {
  return matches(pathname, UNGUARDED_PREFIXES);
}

export function isPublicRoute(pathname: string): boolean {
  if (pathname === '/') return true; // redirects, decided by session state
  return matches(pathname, PUBLIC_PREFIXES) || matches(pathname, PUBLIC_API_PREFIXES);
}

export function isApiRoute(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/');
}

/**
 * Build the sign-in URL, preserving where the user was going.
 *
 * The destination is carried as a *path only* and re-validated by
 * `redirectPathSchema` on the way back out. A `?next=` parameter is
 * attacker-controllable — it arrives in a link someone can send — so it is
 * treated as untrusted input in both directions.
 */
export function signInUrlFor(pathname: string, search: string): string {
  const target = `${pathname}${search}`;
  if (target === DEFAULT_AUTHENTICATED_PATH || target === '/') return SIGN_IN_PATH;
  return `${SIGN_IN_PATH}?next=${encodeURIComponent(target)}`;
}
