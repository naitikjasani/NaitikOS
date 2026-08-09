/**
 * `/api/mind/overview` — everything `/mind` renders, in one read.
 *
 * One endpoint rather than six, and this is the one place in the API where that
 * is the right call. The Mind overview needs three metric series, the episode
 * list, the practice list, the crisis evaluation, today's prompt and the
 * medication annotations — and the *crisis evaluation depends on two of the
 * series*, so splitting them would either duplicate the read or move the
 * evaluation into the client, where §4.7's rules about it are unenforceable.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { mindWindowSchema } from '@naitikos/api';

import {
  errorResponse,
  guard,
  internalErrorResponse,
  isGuardFailure,
  parseQuery,
} from '@/lib/platform/context';
import { loadMindOverview } from '@/lib/platform/mind';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const guarded = await guard(request, 'observation:read');
  if (isGuardFailure(guarded)) return guarded.response;
  const { traceId, platform } = guarded.context;

  const parsed = parseQuery(request, mindWindowSchema, traceId);
  if ('response' in parsed) return parsed.response;

  try {
    const result = await loadMindOverview(platform.db, parsed.data);
    if (!result.ok) return errorResponse(result.error, traceId);
    return NextResponse.json(result.value);
  } catch (error: unknown) {
    platform.observability.logger.error('unhandled error in mind.overview.get', {
      traceId,
      component: 'mind.overview.get',
      identifiers: { name: error instanceof Error ? error.name : 'unknown' },
    });
    return internalErrorResponse(traceId);
  }
}
