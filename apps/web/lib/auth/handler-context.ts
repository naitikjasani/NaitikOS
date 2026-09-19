/**
 * Shared plumbing for auth route handlers.
 *
 * §5.2: "route handlers are transport, not logic. A handler parses,
 * authenticates, delegates to a domain service, and serialises. Zero business
 * rules. If a handler exceeds roughly thirty lines, logic has leaked into
 * transport."
 *
 * Keeping handlers under thirty lines requires the repetitive parts to live
 * somewhere, and this is that somewhere: trace ids, CSRF verification, rate
 * limiting, and error serialisation. None of it is a business rule; all of it
 * is required on every route.
 */

import { NextResponse, type NextRequest } from 'next/server';
import type { DomainError } from '@naitikos/core';
import { systemClock } from '@naitikos/core';
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  MemoryRateLimitStore,
  RATE_LIMIT_RULES,
  type RateLimitRuleName,
  rateLimitKey,
  rateLimitedResponse,
  toHttpError,
  unexpectedErrorResponse,
  verifyCsrf,
} from '@naitikos/api';

import { clientEnv, isDevelopment } from '../env';

/**
 * Process-wide rate limit store.
 *
 * In-process, with the horizontal-scaling caveat documented on
 * `MemoryRateLimitStore`. Correct for a single-instance deployment; the store
 * is a port precisely so this can be swapped without touching a handler.
 */
const rateLimiter = new MemoryRateLimitStore();

/**
 * A stable, non-identifying client key for rate limiting.
 *
 * §5.11 forbids storing raw addresses, so the IP is hashed. The rate limiter
 * needs the key to be *stable*, not *readable*, and a hash satisfies that
 * while keeping the log free of personal data.
 *
 * Falls back to a constant when no forwarding header is present. That collapses
 * every local request into one bucket, which is the safe direction: it
 * over-limits rather than under-limits.
 */
export async function clientKey(request: NextRequest): Promise<string> {
  const forwarded =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    request.headers.get('x-real-ip') ??
    'unknown';

  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(forwarded));
  return Array.from(new Uint8Array(digest).slice(0, 8))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Correlates a response with the server log (§5.13). */
export function traceIdFor(request: NextRequest): string {
  return request.headers.get('x-vercel-id') ?? crypto.randomUUID();
}

/** Serialise a domain error using the single mapping point (§5.12). */
export function errorResponse(error: DomainError, traceId: string): NextResponse {
  const mapped = toHttpError(error, traceId);
  return NextResponse.json(mapped.body, { status: mapped.status, headers: mapped.headers });
}

/** Serialise an unexpected throw, revealing nothing (§5.14). */
export function internalErrorResponse(traceId: string): NextResponse {
  const mapped = unexpectedErrorResponse(traceId);
  return NextResponse.json(mapped.body, { status: mapped.status });
}

/**
 * Verify CSRF on a state-changing request.
 *
 * @returns a 403 response when the check fails, or `null` to proceed.
 */
export function csrfGuard(request: NextRequest, traceId: string): NextResponse | null {
  const result = verifyCsrf({
    method: request.method,
    origin: request.headers.get('origin'),
    referer: request.headers.get('referer'),
    // From validated configuration, never from the Host header — an attacker
    // controls Host, and checking against it would not be a check.
    // The v0 preview can run a production build on a loopback origin while
    // NEXT_PUBLIC_SITE_URL points at the deployed app. Loopback is not a
    // remotely attacker-controlled origin, so bind preview checks to the
    // request origin; keep the configured-origin check everywhere else.
    expectedOrigin: (() => {
      const requestUrl = request.nextUrl;
      const isLoopback =
        requestUrl.hostname === 'localhost' ||
        requestUrl.hostname === '127.0.0.1' ||
        requestUrl.hostname === '[::1]';
      return isDevelopment() || isLoopback
        ? requestUrl.origin
        : new URL(clientEnv.NEXT_PUBLIC_SITE_URL).origin;
    })(),
    cookieToken: request.cookies.get(CSRF_COOKIE_NAME)?.value ?? null,
    headerToken: request.headers.get(CSRF_HEADER_NAME),
  });

  if (result.ok) return null;

  return NextResponse.json(
    {
      error: {
        code: `csrf_${result.reason}`,
        // Deliberately vague. Telling a cross-origin caller precisely which
        // check it failed helps only the caller.
        message: 'Request rejected.',
        traceId,
      },
    },
    { status: 403 },
  );
}

/**
 * Apply a rate limit.
 *
 * @returns a 429 response when exhausted, or `null` to proceed.
 */
export async function rateLimitGuard(
  request: NextRequest,
  rule: RateLimitRuleName,
  traceId: string,
): Promise<NextResponse | null> {
  const key = rateLimitKey(rule, await clientKey(request));
  const decision = await rateLimiter.hit(key, RATE_LIMIT_RULES[rule], systemClock.nowMillis());

  if (decision.allowed) return null;

  const mapped = rateLimitedResponse(traceId, decision.retryAfterSeconds);
  return NextResponse.json(mapped.body, { status: mapped.status, headers: mapped.headers });
}

/** Clear a client's budget after a successful sign-in. */
export async function resetRateLimit(
  request: NextRequest,
  rule: RateLimitRuleName,
): Promise<void> {
  await rateLimiter.reset(rateLimitKey(rule, await clientKey(request)));
}
