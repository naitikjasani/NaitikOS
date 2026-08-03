/**
 * POST /api/auth/step-up
 *
 * §5.4: "Sensitive operations — export, encryption-key access, deletion —
 * require step-up re-authentication regardless of session age."
 *
 * Re-proves the password without disturbing the session, which refreshes
 * `authenticatedAt` and reopens the fifteen-minute window in `core/auth/actor`.
 */

import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { isErr } from '@naitikos/shared';
import { systemClock } from '@naitikos/core';
import { createAuthAuditRecorder } from '@naitikos/db';
import { stepUpRequestSchema } from '@naitikos/api';

import { createServerSupabase } from '../../../../lib/supabase/clients';
import { createWritableCookieAccessor } from '../../../../lib/supabase/next-cookies';
import { createSupabaseAuthProvider } from '../../../../lib/auth/supabase-auth-provider';
import { getAuthState, getDb } from '../../../../lib/auth/session';
import {
  csrfGuard,
  errorResponse,
  internalErrorResponse,
  rateLimitGuard,
  traceIdFor,
} from '../../../../lib/auth/handler-context';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const traceId = traceIdFor(request);

  try {
    const csrf = csrfGuard(request, traceId);
    if (csrf !== null) return csrf;

    // Stricter than sign-in: the realistic attacker here already holds an
    // unlocked device, which is exactly where a slow guess would work.
    const limited = await rateLimitGuard(request, 'stepUp', traceId);
    if (limited !== null) return limited;

    const state = await getAuthState();
    if (state.status !== 'authenticated') {
      return NextResponse.json(
        {
          error: {
            code: 'unauthenticated_no_session',
            message: 'Authentication required.',
            traceId,
          },
        },
        { status: 401 },
      );
    }

    const parsed = stepUpRequestSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: { code: 'validation_failed', message: 'Enter your password.', traceId } },
        { status: 400 },
      );
    }

    const cookieStore = await cookies();
    const supabase = createServerSupabase(createWritableCookieAccessor(cookieStore));

    const provider = createSupabaseAuthProvider(supabase);
    // The email comes from the verified session, never from the request body —
    // accepting one would let this endpoint probe which addresses exist.
    const result = await provider.reauthenticate?.({
      email: state.actor.email,
      password: parsed.data.password,
    });

    const audit = createAuthAuditRecorder(getDb());

    if (result === undefined || isErr(result)) {
      await audit.record({
        kind: 'sign_in_failed',
        email: state.actor.email,
        subjectId: state.actor.subjectId,
        occurredAt: systemClock.now(),
        traceId,
      });
      return result === undefined
        ? internalErrorResponse(traceId)
        : errorResponse(result.error, traceId);
    }

    await audit.record({
      kind: 'step_up_succeeded',
      email: state.actor.email,
      subjectId: state.actor.subjectId,
      occurredAt: systemClock.now(),
      traceId,
    });

    return NextResponse.json({
      status: 'reauthenticated' as const,
      authenticatedAt: result.value.authenticatedAt.toISOString(),
    });
  } catch {
    return internalErrorResponse(traceId);
  }
}
