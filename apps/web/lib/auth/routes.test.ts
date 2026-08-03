/**
 * Route classification and redirect safety.
 *
 * These are the rules the proxy enforces before anything else runs. Two
 * properties matter more than the rest and are asserted first:
 *
 *   - **Default deny.** A route nobody classified must be protected, because
 *     the failure mode of the opposite default is an unauthenticated medical
 *     record.
 *   - **No open redirect.** `?next=` arrives in a link someone can send.
 */

import { describe, expect, it } from 'vitest';

import {
  AUTH_ERROR_PATH,
  DEFAULT_AUTHENTICATED_PATH,
  SIGN_IN_PATH,
  isApiRoute,
  isPublicRoute,
  isUnguarded,
  signInUrlFor,
} from './routes';

describe('default deny', () => {
  it.each([
    '/today',
    '/body',
    '/body/skin/photos',
    '/mind/journal',
    '/settings/data/export',
    '/timeline/medical',
    '/api/observations',
    // Paths that merely start with a public prefix's characters must not
    // inherit its publicness.
    '/authorise',
    '/auth-admin',
    '/offline-data',
  ])('treats %s as protected', (pathname) => {
    expect(isPublicRoute(pathname)).toBe(false);
  });

  it('treats an unrecognised future route as protected', () => {
    // The property that matters: adding a route makes it private automatically.
    expect(isPublicRoute('/some/module/invented/in/2029')).toBe(false);
  });
});

describe('public routes', () => {
  it.each(['/auth/sign-in', '/auth/callback', '/auth/error', '/offline'])(
    'allows %s without a session',
    (pathname) => {
      expect(isPublicRoute(pathname)).toBe(true);
    },
  );

  it('allows nested paths under a public prefix', () => {
    expect(isPublicRoute('/auth/sign-in/help')).toBe(true);
  });

  it('allows the sign-in API so a signed-out user can sign in', () => {
    // Circular otherwise: you would need a session to obtain a session.
    expect(isPublicRoute('/api/auth/sign-in')).toBe(true);
    expect(isPublicRoute('/api/auth/session')).toBe(true);
  });

  it('does NOT make sign-out or step-up public', () => {
    // Both act on an existing session; neither is reachable without one.
    expect(isPublicRoute('/api/auth/sign-out')).toBe(false);
    expect(isPublicRoute('/api/auth/step-up')).toBe(false);
  });

  it('treats the root as public so it can redirect by session state', () => {
    expect(isPublicRoute('/')).toBe(true);
  });
});

describe('unguarded paths', () => {
  it.each(['/_next/static/chunk.js', '/favicon.ico', '/icons/192.png', '/robots.txt'])(
    'skips %s entirely',
    (pathname) => {
      expect(isUnguarded(pathname)).toBe(true);
    },
  );

  it('does not skip anything that looks like an app route', () => {
    expect(isUnguarded('/today')).toBe(false);
    expect(isUnguarded('/api/auth/session')).toBe(false);
  });
});

describe('API detection', () => {
  it('distinguishes API routes so they get a 401 rather than a redirect', () => {
    // A fetch that follows a 307 to an HTML sign-in page produces a JSON parse
    // error three layers from the cause.
    expect(isApiRoute('/api/auth/session')).toBe(true);
    expect(isApiRoute('/api')).toBe(true);
    expect(isApiRoute('/today')).toBe(false);
    // Not an API route despite the substring.
    expect(isApiRoute('/apiary')).toBe(false);
  });
});

describe('signInUrlFor — open redirect defence', () => {
  it('preserves an ordinary destination', () => {
    const url = signInUrlFor('/body/skin/photos', '');
    expect(url).toBe(`${SIGN_IN_PATH}?next=%2Fbody%2Fskin%2Fphotos`);
  });

  it('preserves the query string of the intended destination', () => {
    const url = signInUrlFor('/timeline', '?scale=week');
    expect(url).toContain(encodeURIComponent('/timeline?scale=week'));
  });

  it('omits next for the default destination, keeping the URL clean', () => {
    expect(signInUrlFor(DEFAULT_AUTHENTICATED_PATH, '')).toBe(SIGN_IN_PATH);
    expect(signInUrlFor('/', '')).toBe(SIGN_IN_PATH);
  });

  it('percent-encodes so a crafted path cannot inject query parameters', () => {
    // Without encoding, `/a?x=1&next=https://evil` would smuggle a second
    // parameter that the last-wins parser might prefer.
    const url = signInUrlFor('/a', '?x=1&next=https://evil.example.com');
    expect(url).not.toContain('next=https://evil.example.com');
    expect(url.match(/[?&]next=/g)).toHaveLength(1);
  });

  it('always produces a relative URL', () => {
    for (const pathname of ['/today', '/a/b/c', '//evil.example.com']) {
      const url = signInUrlFor(pathname, '');
      expect(url.startsWith(SIGN_IN_PATH)).toBe(true);
    }
  });
});

describe('constants', () => {
  it('lands authenticated users on Today, per §3.2', () => {
    // "Default route is `/today`. There is no home page distinct from Today."
    expect(DEFAULT_AUTHENTICATED_PATH).toBe('/today');
  });

  it('keeps the auth paths public', () => {
    expect(isPublicRoute(SIGN_IN_PATH)).toBe(true);
    expect(isPublicRoute(AUTH_ERROR_PATH)).toBe(true);
  });
});
