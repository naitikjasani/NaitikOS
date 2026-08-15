/**
 * `/api/health/labs/:analyte` — one analyte's history.
 *
 * Its own route rather than a query parameter on `/api/health`, because it is
 * the one Health read with a genuinely different shape: a series plus the
 * printed-range shifts that make the series legible. §4.4 calls it "per-analyte
 * trends", and it is the endpoint the vitamin D loop terminates in.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { errorResponse, guard, internalErrorResponse, isGuardFailure } from '@/lib/platform/context';
import { loadAnalyteHistory } from '@/lib/platform/health';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ analyte: string }> },
): Promise<NextResponse> {
  const guarded = await guard(request, 'observation:read');
  if (isGuardFailure(guarded)) return guarded.response;
  const { traceId, platform } = guarded.context;

  const { analyte } = await params;

  try {
    const history = await loadAnalyteHistory(platform.db, analyte);
    if (!history.ok) return errorResponse(history.error, traceId);
    return NextResponse.json(history.value);
  } catch (error: unknown) {
    platform.observability.logger.error('unhandled error in health.labs.get', {
      traceId,
      component: 'health.labs.get',
      identifiers: { name: error instanceof Error ? error.name : 'unknown' },
    });
    return internalErrorResponse(traceId);
  }
}
