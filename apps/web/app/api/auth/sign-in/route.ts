/**
 * POST /api/auth/sign-in
 *
 * §5.2: "route handlers are transport, not logic." This one parses, rate
 * limits, checks CSRF, delegates to the provider and to `resolveActor`, and
 * serialises. Every decision it appears to make is made elsewhere.
 */

import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { isErr } from '@naitikos/shared';
import { resolveActor, systemClock } from '@naitikos/core';
import { createAuthAuditRecorder, createIdentityRepository } from '@naitikos/db';
import { signInRequestSchema, visiblePermissions } from '@naitikos/api';

import { createServerSupabase } from '../../../../lib/supabase/clients';
import { createWritableCookieAccessor } from '../../../../lib/supabase/next-cookies';
import { createSupabaseAuthProvider } from '../../../../lib/auth/supabase-auth-provider';
import { getAllowlist, getDb } from '../../../../lib/auth/session';
import { DEFAULT_AUTHENTICATED_PATH } from '../../../../lib/auth/routes';
import {
  csrfGuard,
  errorResponse,
  internalErrorResponse,
  rateLimitGuard,
  resetRateLimit,
  traceIdFor,
} from '../../../../lib/auth/handler-context';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const traceId = traceIdFor(request);

  try {
    const csrf = csrfGuard(request, traceId);
    if (csrf !== null) return csrf;

    // Before parsing the body: an attacker should not be able to spend server
    // CPU on validation by flooding malformed requests.
    const limited = await rateLimitGuard(request, 'signIn', traceId);
    if (limited !== null) return limited;

    const parsed = signInRequestSchema.safeParse(await request.json());
    if (!parsed.success) {
      // A generic message. Field-level detail here would confirm which half of
      // the credentials was malformed.
      return NextResponse.json(
        {
          error: {
            code: 'validation_failed',
            message: 'Enter a valid email address and password.',
            traceId,
          },
        },
        { status: 400 },
      );
    }

    const cookieStore = await cookies();
    const supabase = createServerSupabase(createWritableCookieAccessor(cookieStore));

    const provider = createSupabaseAuthProvider(supabase);
    const identity = await provider.signInWithPassword({
      email: parsed.data.email,
      password: parsed.data.password,
    });

    const db = getDb();
    const audit = createAuthAuditRecorder(db);
    const now = systemClock.now();

    if (isErr(identity)) {
      await audit.record({
        kind: 'sign_in_failed',
        email: parsed.data.email,
        strategy: 'password',
        occurredAt: now,
        traceId,
      });
      return errorResponse(identity.error, traceId);
    }

    // The allowlist, the role, and the audit — all of it in one call, which is
    // the only path that produces an Actor (§5.4).
    const state = await resolveActor(identity.value, {
      allowlist: getAllowlist(),
      identities: createIdentityRepository(db),
      audit,
      now,
      traceId,
    });

    if (isErr(state)) {
      // Allowlisted-out. The Supabase session was established a moment ago, so
      // it must be torn down — otherwise a rejected account holds a valid
      // cookie that middleware would wave through.
      await provider.signOut();
      return errorResponse(state.error, traceId);
    }

    if (state.value.status !== 'authenticated') {
      await provider.signOut();
      return errorResponse(
        { kind: 'forbidden', code: 'forbidden_not_allowlisted', message: 'This account is not permitted.', reason: 'not_allowlisted', stepUpRequired: false },
        traceId,
      );
    }

    const { actor } = state.value;

    await audit.record({
      kind: 'sign_in_succeeded',
      email: actor.email,
      subjectId: actor.subjectId,
      strategy: actor.strategy,
      occurredAt: now,
      traceId,
    });

    // Clears the failed-attempt budget so a user who mistyped twice is not
    // penalised on their next sign-out/sign-in cycle.
    await resetRateLimit(request, 'signIn');

    return NextResponse.json({
      session: {
        status: 'authenticated' as const,
        email: actor.email,
        role: actor.role,
        strategy: actor.strategy,
        authenticatedAt: actor.authenticatedAt.toISOString(),
        permissions: visiblePermissions(state.value),
      },
      redirectTo: parsed.data.redirectTo ?? DEFAULT_AUTHENTICATED_PATH,
    });
  } catch {
    // Never leak. An exception message in this system could contain anything.
    return internalErrorResponse(traceId);
  }
}
