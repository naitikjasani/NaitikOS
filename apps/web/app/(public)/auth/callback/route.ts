/**
 * GET /auth/callback
 *
 * The OAuth and magic-link return path. Exchanges a one-time code for a
 * session, then applies the same allowlist and role resolution as password
 * sign-in — §5.4's allowlist is "checked server-side on every request", and a
 * second entrance that skipped it would make the first one decorative.
 *
 * A GET that changes state, which is normally a CSRF hazard. It is safe here
 * for a specific reason: the code is single-use, unguessable, and bound to a
 * PKCE verifier held in an httpOnly cookie this browser set when it started the
 * flow. An attacker who can make a victim's browser issue this GET does not
 * hold the verifier, so the exchange fails.
 */

import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { isErr } from '@naitikos/shared';
import { resolveActor, systemClock } from '@naitikos/core';
import { createAuthAuditRecorder, createIdentityRepository } from '@naitikos/db';

import { createServerSupabase } from '../../../../lib/supabase/clients';
import { createWritableCookieAccessor } from '../../../../lib/supabase/next-cookies';
import { createSupabaseAuthProvider } from '../../../../lib/auth/supabase-auth-provider';
import { getAllowlist, getDb } from '../../../../lib/auth/session';
import { AUTH_ERROR_PATH, DEFAULT_AUTHENTICATED_PATH } from '../../../../lib/auth/routes';

/** Reasons surfaced to `/auth/error`. Coarse on purpose — see below. */
type CallbackFailure = 'invalid_code' | 'not_permitted' | 'provider_error';

function failureRedirect(request: NextRequest, reason: CallbackFailure): NextResponse {
  const url = new URL(AUTH_ERROR_PATH, request.url);
  url.searchParams.set('reason', reason);
  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const code = request.nextUrl.searchParams.get('code');

  // The provider reports its own failures here — a cancelled consent screen,
  // a misconfigured client. Nothing to exchange.
  if (request.nextUrl.searchParams.has('error') || code === null || code === '') {
    return failureRedirect(request, 'invalid_code');
  }

  const cookieStore = await cookies();
  const supabase = createServerSupabase(createWritableCookieAccessor(cookieStore));

  const provider = createSupabaseAuthProvider(supabase);

  const exchanged = await provider.exchangeCodeForSession?.(code);
  if (exchanged === undefined || isErr(exchanged)) {
    return failureRedirect(request, 'invalid_code');
  }

  const db = getDb();
  const audit = createAuthAuditRecorder(db);
  const now = systemClock.now();

  const state = await resolveActor(exchanged.value, {
    allowlist: getAllowlist(),
    identities: createIdentityRepository(db),
    audit,
    now,
  });

  if (isErr(state) || state.value.status !== 'authenticated') {
    // A session was just established for an account that is not permitted.
    // Tear it down before redirecting, or middleware will happily let the
    // holder of that cookie through on the next request.
    await provider.signOut();
    return failureRedirect(request, 'not_permitted');
  }

  await audit.record({
    kind: 'sign_in_succeeded',
    email: state.value.actor.email,
    subjectId: state.value.actor.subjectId,
    strategy: state.value.actor.strategy,
    occurredAt: now,
  });

  /**
   * The post-sign-in destination.
   *
   * `next` arrives in a URL the user may have been sent, so it is untrusted.
   * Only a same-origin relative path is honoured — the same open-redirect rules
   * as `redirectPathSchema`, applied here because this path never passes
   * through that schema.
   */
  const next = request.nextUrl.searchParams.get('next');
  const safeNext =
    next !== null && next.startsWith('/') && !next.startsWith('//') && !next.includes('\\')
      ? next
      : DEFAULT_AUTHENTICATED_PATH;

  return NextResponse.redirect(new URL(safeNext, request.url));
}
