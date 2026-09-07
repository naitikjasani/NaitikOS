/**
 * Cookie transport policy.
 *
 * One property carries this file, and it is asserted from both directions
 * because only one direction is recoverable:
 *
 *   - **A production origin is never downgraded.** A CSRF token travelling in
 *     cleartext next to a session that reaches medical records is the regression
 *     this predicate exists to not become. Every test below that expects `true`
 *     is really a test that some plausible mistake — a stray `NODE_ENV`, an
 *     `http://` typo in configuration, a hostname that merely *looks* like
 *     loopback — cannot produce `false`.
 *   - **A plaintext loopback origin omits `Secure`,** because a browser that
 *     drops the cookie breaks every mutation in a build served by `next start`.
 *
 * The asymmetry is deliberate: the second failure costs a local afternoon, the
 * first costs a medical record.
 */

import { describe, expect, it } from 'vitest';
import { CSRF_COOKIE_NAME } from '@naitikos/api';

import { csrfCookieAttributes, requiresSecureCookies } from './cookies';

describe('requiresSecureCookies — the production path is never downgraded', () => {
  it.each([
    'https://naitikos.app',
    'https://naitikos.app/',
    'https://naitikos.vercel.app',
    'https://staging.naitikos.app:8443',
  ])('keeps Secure for %s', (siteUrl) => {
    expect(requiresSecureCookies(siteUrl)).toBe(true);
  });

  it('keeps Secure on an https loopback origin — the scheme decides, not the host', () => {
    // Someone running a local TLS terminator. There is no reason to weaken a
    // connection that is already encrypted.
    expect(requiresSecureCookies('https://localhost:3000')).toBe(true);
    expect(requiresSecureCookies('https://127.0.0.1:3000')).toBe(true);
  });

  it('depends on the origin alone, which is what the defect got wrong', () => {
    /*
     * The defect this replaced was `secure: !isDevelopment()` — a build-time
     * fact standing in for a connection-time one. A production build served
     * over `http://localhost`, which is exactly what `next build && next start`
     * does, is a production NODE_ENV on a plaintext connection.
     *
     * The regression is guarded by construction rather than by mutating the
     * environment: the origin is this function's only input, so no value of
     * NODE_ENV can reach it. That is the property worth asserting, and setting
     * `process.env.NODE_ENV` to assert it would be testing Node rather than
     * this predicate — as well as writing to a field Next types as read-only.
     *
     * So: a production origin is Secure and a loopback origin is not, and both
     * answers come from the string.
     */
    expect(requiresSecureCookies('https://naitikos.app')).toBe(true);
    expect(requiresSecureCookies('http://localhost:3000')).toBe(false);
  });
});

describe('requiresSecureCookies — plaintext loopback, and nothing else', () => {
  it.each([
    'http://localhost',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    // The whole 127.0.0.0/8 block answers on the loopback interface.
    'http://127.1.2.3:3000',
    'http://[::1]:3000',
    // RFC 6761 reserves the entire `.localhost` label for loopback.
    'http://naitikos.localhost:3000',
  ])('omits Secure for %s so the browser stores the cookie', (siteUrl) => {
    expect(requiresSecureCookies(siteUrl)).toBe(false);
  });

  it('keeps Secure for a lookalike host that merely contains "localhost"', () => {
    /*
     * The lookalike-origin bug, relocated. Each of these is a name an attacker
     * can register and serve over plaintext, and a `startsWith`/`includes`
     * membership test would hand every one of them a cookie with no `Secure`
     * attribute.
     */
    for (const siteUrl of [
      'http://localhost.evil.example.com',
      'http://notlocalhost',
      'http://localhosts',
      'http://evil.example.com/localhost',
      'http://localhost.attacker.test:3000',
    ]) {
      expect(requiresSecureCookies(siteUrl)).toBe(true);
    }
  });

  it('keeps Secure for a near-miss loopback address', () => {
    // Not in 127.0.0.0/8, and `127.0.0.999` is not an address at all.
    expect(requiresSecureCookies('http://128.0.0.1:3000')).toBe(true);
    expect(requiresSecureCookies('http://27.0.0.1:3000')).toBe(true);
    expect(requiresSecureCookies('http://127.0.0.999:3000')).toBe(true);
  });

  it('keeps Secure on a LAN address, which is plaintext but not private', () => {
    /*
     * The case a developer will actually meet — a phone on the same Wi-Fi
     * loading the PWA. It gets no cookie, and that is the answer: a private
     * network is still a broadcast medium with other people's devices on it.
     */
    for (const siteUrl of ['http://192.168.1.20:3000', 'http://10.0.0.5:3000', 'http://phone.local:3000']) {
      expect(requiresSecureCookies(siteUrl)).toBe(true);
    }
  });
});

describe('requiresSecureCookies — failing closed', () => {
  it.each([
    // A misconfiguration that must fail loudly rather than ship plaintext.
    'http://naitikos.app',
    // Values `lib/env.ts` should already have rejected. Belt and braces: the
    // cost of that guarantee lapsing is a token on the wire in the clear.
    'naitikos.app',
    'localhost:3000',
    '',
    '  ',
    'not a url at all',
    // A scheme that carries no transport guarantee we can reason about.
    'ftp://naitikos.app',
    'file:///tmp/naitikos',
    'javascript:alert(1)',
  ])('keeps Secure for the unrecognised or misconfigured %o', (siteUrl) => {
    expect(requiresSecureCookies(siteUrl)).toBe(true);
  });
});

describe('csrfCookieAttributes', () => {
  it('is never httpOnly, because double-submit requires page script to read it', () => {
    // Not an oversight, and the single most likely thing for a future reader to
    // "fix". The token is not a credential; the defence is that a cross-origin
    // attacker cannot read it, which same-origin policy provides regardless.
    for (const siteUrl of ['https://naitikos.app', 'http://localhost:3000']) {
      expect(csrfCookieAttributes(siteUrl).httpOnly).toBe(false);
    }
  });

  it('is SameSite=Lax — the primary defence, with the token as backup', () => {
    // `strict` would drop the cookie on the top-level GET navigation that the
    // OAuth callback and a magic link both arrive as.
    expect(csrfCookieAttributes('https://naitikos.app').sameSite).toBe('lax');
  });

  it('scopes to the whole app and expires with the session', () => {
    const attributes = csrfCookieAttributes('https://naitikos.app');
    expect(attributes.path).toBe('/');
    // §5.4's thirty-day sliding session, so the two expire together — a token
    // outliving its session is a form a signed-out user can still submit.
    expect(attributes.maxAge).toBe(30 * 24 * 60 * 60);
  });

  it('carries Secure in production and omits it on plaintext loopback', () => {
    expect(csrfCookieAttributes('https://naitikos.app').secure).toBe(true);
    expect(csrfCookieAttributes('http://localhost:3000').secure).toBe(false);
  });

  it('does not name the cookie, so the name has one definition', () => {
    // The name lives with `verifyCsrf` in `packages/api`; a second literal here
    // is how a rename leaves the proxy seeding a cookie nothing reads.
    expect(CSRF_COOKIE_NAME).toBe('naitikos-csrf');
    expect(Object.keys(csrfCookieAttributes('https://naitikos.app'))).not.toContain('name');
  });
});
