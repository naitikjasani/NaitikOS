/**
 * GET /api/auth/session
 *
 * The client's view of who it is. Safe method, no CSRF token required, and
 * deliberately readable while signed out — the sign-in page calls it to decide
 * whether to redirect.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { visiblePermissions } from '@naitikos/api';

import { getAuthState } from '../../../../lib/auth/session';
import {
  internalErrorResponse,
  rateLimitGuard,
  traceIdFor,
} from '../../../../lib/auth/handler-context';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const traceId = traceIdFor(request);

  try {
    // Loose limit — this is hit on nearly every navigation. It exists to bound
    // a runaway client, not to police the user.
    const limited = await rateLimitGuard(request, 'session', traceId);
    if (limited !== null) return limited;

    const state = await getAuthState();

    if (state.status !== 'authenticated') {
      // 200, not 401. "You are signed out" is a successful answer to this
      // question; a 401 would make the sign-in page log an error on every load.
      return NextResponse.json(
        { status: 'anonymous' },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    }

    return NextResponse.json(
      {
        status: 'authenticated' as const,
        email: state.actor.email,
        role: state.actor.role,
        strategy: state.actor.strategy,
        authenticatedAt: state.actor.authenticatedAt.toISOString(),
        permissions: visiblePermissions(state),
      },
      // §5.6: personal data is never cached. A shared cache holding this would
      // be a correctness bug even at n=1.
      { headers: { 'Cache-Control': 'no-store, private' } },
    );
  } catch {
    return internalErrorResponse(traceId);
  }
}
