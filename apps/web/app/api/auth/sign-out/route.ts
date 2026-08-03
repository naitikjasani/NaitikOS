/**
 * POST /api/auth/sign-out
 *
 * POST rather than GET, deliberately. A GET sign-out is triggerable by any
 * `<img src="/api/auth/sign-out">` on any page — a nuisance CSRF that logs the
 * user out mid-entry. `SameSite=Lax` permits top-level GET, so the method is
 * the defence, not the cookie policy.
 */

import { cookies } from 'next/headers';
import { systemClock } from '@naitikos/core';
import { NextResponse, type NextRequest } from 'next/server';
import { createAuthAuditRecorder } from '@naitikos/db';

import { createServerSupabase } from '../../../../lib/supabase/clients';
import { createWritableCookieAccessor } from '../../../../lib/supabase/next-cookies';
import { createSupabaseAuthProvider } from '../../../../lib/auth/supabase-auth-provider';
import { getAuthState, getDb } from '../../../../lib/auth/session';
import {
  csrfGuard,
  internalErrorResponse,
  traceIdFor,
} from '../../../../lib/auth/handler-context';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const traceId = traceIdFor(request);

  try {
    const csrf = csrfGuard(request, traceId);
    if (csrf !== null) return csrf;

    // Read before revoking, so the audit record knows who left.
    const state = await getAuthState();

    const cookieStore = await cookies();
    const supabase = createServerSupabase(createWritableCookieAccessor(cookieStore));

    // Global scope: revoke every session, not just this browser's. A local-only
    // sign-out on a phone that was handed to someone is not a sign-out.
    await createSupabaseAuthProvider(supabase).signOut();

    if (state.status === 'authenticated') {
      await createAuthAuditRecorder(getDb()).record({
        kind: 'sign_out',
        email: state.actor.email,
        subjectId: state.actor.subjectId,
        occurredAt: systemClock.now(),
        traceId,
      });
    }

    // 200 with a body rather than a redirect: the client decides where to go,
    // and a fetch following a redirect to HTML is a confusing failure.
    return NextResponse.json({ status: 'signed_out' });
  } catch {
    return internalErrorResponse(traceId);
  }
}
