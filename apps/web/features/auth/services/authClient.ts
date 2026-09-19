/**
 * The typed client for the auth endpoints.
 *
 * §7.3: services are "plain TypeScript, no React. Coordinates API calls,
 * invokes `core` domain functions, handles multi-step flows. Directly unit
 * testable."
 *
 * Every request goes through {@link authFetch}, which is the single place the
 * CSRF header is attached. A handler-by-handler `fetch` would mean the token is
 * attached four times and forgotten once — and the fifth endpoint would fail in
 * a way that looks like a server bug.
 */

import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from '@naitikos/api';
import type { SessionEnvelope } from '@naitikos/api';

/** A failure the UI can render. Never carries provider detail. */
export type AuthClientError = {
  readonly code: string;
  readonly message: string;
  readonly status: number;
  /** Set on 403 when re-authenticating would help (§5.4). */
  readonly stepUpRequired?: boolean;
  readonly retryAfterSeconds?: number;
};

/**
 * Read the CSRF token from the cookie.
 *
 * Readable by script by design — the double-submit scheme requires it, and the
 * token is not a credential. See `CSRF_COOKIE_OPTIONS` for the full argument.
 */
function readCsrfToken(): string | null {
  if (typeof document === 'undefined') return null;

  const match = document.cookie
    .split('; ')
    .find((entry) => entry.startsWith(`${CSRF_COOKIE_NAME}=`));

  return match === undefined ? null : decodeURIComponent(match.slice(CSRF_COOKIE_NAME.length + 1));
}

async function authFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');

  let token = readCsrfToken();

  // The proxy seeds the double-submit cookie on a page GET. A stale preview
  // tab can still submit before that seed exists, so bootstrap it immediately
  // instead of sending a guaranteed 403 mutation.
  if (token === null && typeof window !== 'undefined') {
    await fetch(window.location.pathname, {
      credentials: 'same-origin',
      cache: 'no-store',
    });
    token = readCsrfToken();
  }

  if (token !== null) headers.set(CSRF_HEADER_NAME, token);

  return fetch(path, {
    ...init,
    headers,
    // Cookies are the session. Without this, cross-origin defaults would drop
    // them and every request would look signed out.
    credentials: 'same-origin',
    // §5.6: personal data is never cached.
    cache: 'no-store',
  });
}

/**
 * Retry once after a stale CSRF cookie/header pair is rejected.
 *
 * Preview tabs can survive a deployment or host change with an old readable
 * CSRF cookie. The server correctly rejects that pair; refreshing the page
 * alone does not help because the proxy sees the old cookie as present. Clear
 * only the non-credential CSRF cookie, let the proxy seed a fresh token, then
 * retry the original request once.
 */
async function authMutation(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await authFetch(path, init);
  if (response.status !== 403 || typeof document === 'undefined') return response;

  let isCsrfRejection = false;
  try {
    const body = (await response.clone().json()) as { error?: { code?: unknown } };
    isCsrfRejection = typeof body.error?.code === 'string' && body.error.code.startsWith('csrf_');
  } catch {
    return response;
  }
  if (!isCsrfRejection) return response;

  document.cookie = `${CSRF_COOKIE_NAME}=; Max-Age=0; path=/`;
  await fetch(window.location.pathname, { credentials: 'same-origin', cache: 'no-store' });
  return authFetch(path, init);
}

/** Normalise any failure response into a renderable error. */
async function toClientError(response: Response): Promise<AuthClientError> {
  const fallback: AuthClientError = {
    code: 'unknown_error',
    message: 'Something went wrong. Try again.',
    status: response.status,
  };

  try {
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null || !('error' in body)) return fallback;

    const error = (body as { error: Record<string, unknown> }).error;
    const retryAfter = response.headers.get('Retry-After');

    return {
      code: typeof error['code'] === 'string' ? error['code'] : fallback.code,
      message: typeof error['message'] === 'string' ? error['message'] : fallback.message,
      status: response.status,
      ...(typeof error['stepUpRequired'] === 'boolean'
        ? { stepUpRequired: error['stepUpRequired'] }
        : {}),
      ...(retryAfter === null ? {} : { retryAfterSeconds: Number(retryAfter) }),
    };
  } catch {
    // A non-JSON body — a proxy error page, most likely.
    return fallback;
  }
}

export type SignInResult =
  | { readonly ok: true; readonly redirectTo: string }
  | { readonly ok: false; readonly error: AuthClientError };

export async function signIn(input: {
  email: string;
  password: string;
  // `| undefined` explicitly: `exactOptionalPropertyTypes` distinguishes an
  // absent key from a present-but-undefined one, and Zod's inferred optional
  // produces the latter.
  redirectTo?: string | undefined;
}): Promise<SignInResult> {
  const response = await authMutation('/api/auth/sign-in', {
    method: 'POST',
    body: JSON.stringify(input),
  });

  if (!response.ok) return { ok: false, error: await toClientError(response) };

  const body = (await response.json()) as { redirectTo: string };
  return { ok: true, redirectTo: body.redirectTo };
}

export async function signOut(): Promise<{ ok: boolean }> {
  const response = await authFetch('/api/auth/sign-out', { method: 'POST' });
  return { ok: response.ok };
}

export async function fetchSession(): Promise<SessionEnvelope> {
  const response = await authFetch('/api/auth/session', { method: 'GET' });

  // Any failure reads as anonymous. The alternative — throwing — would make a
  // transient network blip render an error page over a sign-in form.
  if (!response.ok) return { status: 'anonymous' };

  return (await response.json()) as SessionEnvelope;
}

export type StepUpResult =
  | { readonly ok: true; readonly authenticatedAt: string }
  | { readonly ok: false; readonly error: AuthClientError };

export async function stepUp(password: string): Promise<StepUpResult> {
  const response = await authFetch('/api/auth/step-up', {
    method: 'POST',
    body: JSON.stringify({ password }),
  });

  if (!response.ok) return { ok: false, error: await toClientError(response) };

  const body = (await response.json()) as { authenticatedAt: string };
  return { ok: true, authenticatedAt: body.authenticatedAt };
}
