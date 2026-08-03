/**
 * Contracts, error mapping, CSRF, and rate limiting.
 *
 * §11.4 requires "Contract | Zod round-trip | **100%**" coverage of every API
 * contract, and these are the auth ones. The security-relevant assertions —
 * open redirect, token comparison, origin checking — are written as attack
 * cases rather than happy paths, because a guard tested only against valid
 * input is a guard tested against nobody who matters.
 */

import { describe, expect, it } from 'vitest';
import {
  conflictError,
  forbiddenError,
  notFoundError,
  preconditionFailedError,
  unauthenticatedError,
  validationError,
} from '@naitikos/core';

import {
  emailSchema,
  passwordSchema,
  preferencesSchema,
  profileUpdateSchema,
  redirectPathSchema,
  sessionEnvelopeSchema,
  signInRequestSchema,
} from './contracts/auth';
import { rateLimitedResponse, toHttpError, unexpectedErrorResponse } from './errors/http';
import {
  CSRF_COOKIE_OPTIONS,
  generateCsrfToken,
  isStateChangingMethod,
  timingSafeEqual,
  verifyCsrf,
} from './middleware/csrf';
import { MemoryRateLimitStore, RATE_LIMIT_RULES, rateLimitKey } from './middleware/rate-limit';
import { buildContentSecurityPolicy, buildSecurityHeaders, generateNonce } from './middleware/security-headers';

const TRACE = 'trace-abc';

/* =========================================================================
 * Contracts
 * ====================================================================== */

describe('email contract', () => {
  it('normalises to the form the allowlist compares against', () => {
    // The transform is the point: no handler can forget to normalise, because
    // the un-normalised form does not survive parsing.
    expect(emailSchema.parse('  Operator@Example.COM  ')).toBe('operator@example.com');
  });

  it('rejects malformed and oversized addresses', () => {
    expect(emailSchema.safeParse('not-an-email').success).toBe(false);
    expect(emailSchema.safeParse(`${'a'.repeat(250)}@example.com`).success).toBe(false);
  });
});

describe('password contract', () => {
  it('requires length rather than composition', () => {
    // NIST SP 800-63B: composition rules produce weaker passwords.
    expect(passwordSchema.safeParse('correct horse battery staple').success).toBe(true);
    expect(passwordSchema.safeParse('aaaaaaaaaaaa').success).toBe(true);
    expect(passwordSchema.safeParse('short').success).toBe(false);
  });

  it('caps length to bound hashing cost', () => {
    expect(passwordSchema.safeParse('a'.repeat(129)).success).toBe(false);
  });
});

describe('redirect contract — open redirect defence', () => {
  it('accepts an ordinary relative path', () => {
    expect(redirectPathSchema.safeParse('/today').success).toBe(true);
    expect(redirectPathSchema.safeParse('/body/skin?tab=photos').success).toBe(true);
  });

  it.each([
    ['absolute URL', 'https://evil.example.com/steal'],
    ['protocol-relative', '//evil.example.com'],
    ['backslash escape', '/\\evil.example.com'],
    ['encoded absolute', '/%2fevil.example.com'],
    ['bare host', 'evil.example.com'],
    ['javascript scheme', 'javascript:alert(1)'],
  ])('rejects %s', (_label, candidate) => {
    expect(redirectPathSchema.safeParse(candidate).success).toBe(false);
  });
});

describe('sign-in request', () => {
  it('round-trips a valid request', () => {
    const parsed = signInRequestSchema.parse({
      email: 'Operator@Example.com',
      password: 'a-sufficiently-long-password',
      redirectTo: '/today',
    });

    expect(parsed.email).toBe('operator@example.com');
    expect(parsed.redirectTo).toBe('/today');
  });

  it('refuses a hostile redirect alongside valid credentials', () => {
    const result = signInRequestSchema.safeParse({
      email: 'operator@example.com',
      password: 'a-sufficiently-long-password',
      redirectTo: 'https://evil.example.com',
    });

    expect(result.success).toBe(false);
  });
});

describe('session envelope', () => {
  it('never carries a token', () => {
    // A token in a response body makes every XSS a session theft.
    const envelope = sessionEnvelopeSchema.parse({
      status: 'authenticated',
      email: 'operator@example.com',
      role: 'owner',
      strategy: 'password',
      authenticatedAt: '2026-08-03T12:00:00.000Z',
      permissions: ['observation:read'],
    });

    const keys = Object.keys(envelope);
    expect(keys).not.toContain('accessToken');
    expect(keys).not.toContain('refreshToken');
    expect(keys).not.toContain('subjectId');
  });

  it('discriminates the anonymous case', () => {
    const parsed = sessionEnvelopeSchema.parse({ status: 'anonymous' });
    expect(parsed.status).toBe('anonymous');
  });
});

describe('profile and preferences contracts', () => {
  it('rejects a non-existent time zone', () => {
    // §5.3: a bad zone corrupts every observation captured afterwards.
    expect(profileUpdateSchema.safeParse({ timezone: 'Mars/Olympus_Mons' }).success).toBe(false);
    expect(profileUpdateSchema.safeParse({ timezone: 'Asia/Kolkata' }).success).toBe(true);
  });

  it('rejects an unknown notification category', () => {
    const result = preferencesSchema.safeParse({
      theme: 'dark',
      density: 'compact',
      motion: 'reduced',
      notifications: { streak_broken: true },
    });

    // §5.9 forbids streak notifications outright. The schema cannot express
    // one, which is the enforcement.
    expect(result.success).toBe(false);
  });
});

/* =========================================================================
 * Error mapping (§5.12)
 * ====================================================================== */

describe('DomainError → HTTP', () => {
  it.each([
    ['validation', validationError('bad', 'Bad.'), 400],
    ['unauthenticated', unauthenticatedError(), 401],
    ['forbidden', forbiddenError('insufficient_permission'), 403],
    ['not_found', notFoundError('profile', 'x'), 404],
    ['conflict', conflictError('profile', 'version_mismatch'), 409],
    ['precondition', preconditionFailedError('metric_registered', 'No.'), 412],
  ])('maps %s to %i', (_label, error, status) => {
    expect(toHttpError(error, TRACE).status).toBe(status);
  });

  it('attaches a challenge to 401, per RFC 9110', () => {
    const mapped = toHttpError(unauthenticatedError('expired'), TRACE);
    expect(mapped.headers['WWW-Authenticate']).toContain('Bearer');
  });

  it('surfaces stepUpRequired so the client knows to prompt', () => {
    const stepUp = toHttpError(forbiddenError('step_up_required'), TRACE);
    const plain = toHttpError(forbiddenError('insufficient_permission'), TRACE);

    expect(stepUp.body.error.stepUpRequired).toBe(true);
    expect(plain.body.error.stepUpRequired).toBe(false);
  });

  it('carries the trace id on every response', () => {
    for (const error of [
      validationError('a', 'b'),
      unauthenticatedError(),
      forbiddenError('not_allowlisted'),
      notFoundError('x', 'y'),
    ]) {
      expect(toHttpError(error, TRACE).body.error.traceId).toBe(TRACE);
    }
  });

  it('reveals nothing for an unexpected error', () => {
    // §5.14: an exception message in this system could contain a journal entry.
    const mapped = unexpectedErrorResponse(TRACE);

    expect(mapped.status).toBe(500);
    expect(mapped.body.error.traceId).toBe(TRACE);
    expect(JSON.stringify(mapped.body)).not.toMatch(/stack|at |\.ts:/);
  });

  it('sets Retry-After on 429, rounded up and never zero', () => {
    expect(rateLimitedResponse(TRACE, 0.2).headers['Retry-After']).toBe('1');
    expect(rateLimitedResponse(TRACE, 42.1).headers['Retry-After']).toBe('43');
  });
});

/* =========================================================================
 * CSRF
 * ====================================================================== */

describe('CSRF', () => {
  const base = {
    method: 'POST',
    origin: 'https://naitikos.app',
    referer: null,
    expectedOrigin: 'https://naitikos.app',
    cookieToken: 'token-value',
    headerToken: 'token-value',
  };

  it('permits safe methods without a token', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      expect(isStateChangingMethod(method)).toBe(false);
      expect(verifyCsrf({ ...base, method, cookieToken: null, headerToken: null }).ok).toBe(true);
    }
  });

  it('treats every unsafe method as state-changing', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(isStateChangingMethod(method)).toBe(true);
    }
  });

  it('accepts a matching origin and token', () => {
    expect(verifyCsrf(base).ok).toBe(true);
  });

  it('rejects a cross-origin request even when the token matches', () => {
    // The token could be leaked; the Origin header cannot be forged by script.
    const result = verifyCsrf({ ...base, origin: 'https://evil.example.com' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('origin_mismatch');
  });

  it('rejects a request with no origin or referer', () => {
    const result = verifyCsrf({ ...base, origin: null, referer: null });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('origin_missing');
  });

  it('falls back to the referer origin when Origin is absent', () => {
    expect(
      verifyCsrf({ ...base, origin: null, referer: 'https://naitikos.app/auth/sign-in' }).ok,
    ).toBe(true);
  });

  it('rejects a mismatched token on a same-origin request', () => {
    const result = verifyCsrf({ ...base, headerToken: 'different' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('token_mismatch');
  });

  it('rejects a missing or empty token', () => {
    expect(verifyCsrf({ ...base, headerToken: null }).ok).toBe(false);
    expect(verifyCsrf({ ...base, cookieToken: '' }).ok).toBe(false);
  });

  it('compares tokens without early exit on length or content', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
    expect(timingSafeEqual('', '')).toBe(true);
  });

  it('generates unpredictable tokens', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateCsrfToken()));
    expect(tokens.size).toBe(200);
    // base64url — safe in a cookie value without escaping.
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('keeps the CSRF cookie readable by script, and says why', () => {
    // Double-submit requires the client to read it. It is not a credential.
    expect(CSRF_COOKIE_OPTIONS.httpOnly).toBe(false);
    expect(CSRF_COOKIE_OPTIONS.secure).toBe(true);
    expect(CSRF_COOKIE_OPTIONS.sameSite).toBe('lax');
  });
});

/* =========================================================================
 * Rate limiting
 * ====================================================================== */

describe('rate limiting', () => {
  it('allows up to the limit then refuses', async () => {
    const store = new MemoryRateLimitStore();
    const rule = RATE_LIMIT_RULES.signIn;
    const key = rateLimitKey('signIn', 'client-1');
    const now = 1_000_000;

    for (let i = 0; i < rule.limit; i += 1) {
      const decision = await store.hit(key, rule, now);
      expect(decision.allowed, `attempt ${String(i + 1)} should be allowed`).toBe(true);
    }

    const refused = await store.hit(key, rule, now);
    expect(refused.allowed).toBe(false);
    expect(refused.remaining).toBe(0);
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('separates budgets per rule so one cannot exhaust another', () => {
    // Exhausting sign-in must not lock step-up, and vice versa.
    expect(rateLimitKey('signIn', 'c')).not.toBe(rateLimitKey('stepUp', 'c'));
  });

  it('separates budgets per client', async () => {
    const store = new MemoryRateLimitStore();
    const rule = RATE_LIMIT_RULES.stepUp;
    const now = 1_000_000;

    for (let i = 0; i < rule.limit + 1; i += 1) {
      await store.hit(rateLimitKey('stepUp', 'noisy'), rule, now);
    }

    const other = await store.hit(rateLimitKey('stepUp', 'quiet'), rule, now);
    expect(other.allowed).toBe(true);
  });

  it('recovers after the window elapses', async () => {
    const store = new MemoryRateLimitStore();
    const rule = RATE_LIMIT_RULES.signIn;
    const key = rateLimitKey('signIn', 'client-2');
    const now = 1_000_000;

    for (let i = 0; i < rule.limit + 1; i += 1) await store.hit(key, rule, now);
    expect((await store.hit(key, rule, now)).allowed).toBe(false);

    const later = now + rule.windowMs + 1;
    expect((await store.hit(key, rule, later)).allowed).toBe(true);
  });

  it('clears on reset, so a successful sign-in unblocks the user', async () => {
    const store = new MemoryRateLimitStore();
    const rule = RATE_LIMIT_RULES.signIn;
    const key = rateLimitKey('signIn', 'client-3');
    const now = 1_000_000;

    for (let i = 0; i < rule.limit + 1; i += 1) await store.hit(key, rule, now);
    await store.reset(key);

    expect((await store.hit(key, rule, now)).allowed).toBe(true);
  });

  it('keeps step-up stricter than sign-in', () => {
    // Step-up guards export and key access against someone holding an
    // already-unlocked device (§5.4).
    expect(RATE_LIMIT_RULES.stepUp.limit).toBeLessThan(RATE_LIMIT_RULES.signIn.limit);
  });

  it('bounds memory under key-space flooding', async () => {
    const store = new MemoryRateLimitStore(50);
    const rule = RATE_LIMIT_RULES.session;

    for (let i = 0; i < 500; i += 1) {
      await store.hit(rateLimitKey('session', `flood-${String(i)}`), rule, 1_000_000);
    }

    // Still functional rather than having grown without bound.
    expect((await store.hit(rateLimitKey('session', 'real'), rule, 1_000_000)).allowed).toBe(true);
  });
});

/* =========================================================================
 * Security headers
 * ====================================================================== */

describe('security headers', () => {
  const nonce = 'test-nonce';

  it('builds a strict production CSP', () => {
    const csp = buildContentSecurityPolicy({ nonce, connectSources: ['https://x.supabase.co'] });

    expect(csp).toContain(`default-src 'self'`);
    expect(csp).toContain(`'nonce-${nonce}'`);
    expect(csp).toContain(`'strict-dynamic'`);
    expect(csp).toContain(`frame-ancestors 'none'`);
    expect(csp).toContain(`object-src 'none'`);
    expect(csp).toContain('https://x.supabase.co');
  });

  it('never allows unsafe-eval in production', () => {
    // §5.14 names this explicitly.
    const csp = buildContentSecurityPolicy({ nonce });
    expect(csp).not.toContain('unsafe-eval');
  });

  it('never allows inline script in production', () => {
    const csp = buildContentSecurityPolicy({ nonce });
    // `unsafe-inline` must not appear in script-src. It is permitted in
    // style-src as documented debt, so the assertion is scoped to the directive.
    const scriptSrc = csp.split(';').find((d) => d.trim().startsWith('script-src')) ?? '';
    expect(scriptSrc).not.toContain('unsafe-inline');
  });

  it('permits eval only when development is explicitly set', () => {
    expect(buildContentSecurityPolicy({ nonce, development: true })).toContain('unsafe-eval');
  });

  it('restricts connect-src to self plus the declared origins', () => {
    // The exfiltration control: §5.14's first named adversary is a compromised
    // dependency, and this is what stops it phoning home.
    const csp = buildContentSecurityPolicy({ nonce, connectSources: ['https://x.supabase.co'] });
    const connect = (csp.split(';').find((d) => d.trim().startsWith('connect-src')) ?? '').trim();

    expect(connect).toBe(`connect-src 'self' https://x.supabase.co`);
    expect(connect).not.toContain('*');
  });

  it('sends HSTS in production and not in development', () => {
    // Sending it on localhost poisons the browser's HSTS store for every other
    // local project.
    expect(buildSecurityHeaders({ nonce })['Strict-Transport-Security']).toContain('preload');
    expect(buildSecurityHeaders({ nonce, development: true })['Strict-Transport-Security']).toBeUndefined();
  });

  it('keeps referrers same-origin, because paths are sensitive here', () => {
    // `/body/skin/treatments` in a Referer header tells a third party
    // something real about the user.
    expect(buildSecurityHeaders({ nonce })['Referrer-Policy']).toBe('same-origin');
  });

  it('denies the microphone and permits the camera', () => {
    // §4.2's photography protocol needs the camera; nothing needs the mic.
    const policy = buildSecurityHeaders({ nonce })['Permissions-Policy'] ?? '';
    expect(policy).toContain('microphone=()');
    expect(policy).toContain('geolocation=()');
    expect(policy).toContain('camera=(self)');
  });

  it('generates unique nonces', () => {
    const nonces = new Set(Array.from({ length: 200 }, () => generateNonce()));
    expect(nonces.size).toBe(200);
  });
});
