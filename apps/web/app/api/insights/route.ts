/**
 * `/api/insights` — the deterministic battery's output (§2.1, §10.6).
 *
 * The endpoint exists in the MVP; the `/insights` *route* does not — §3.2 marks
 * it V2 and gives the MVP one place for a finding, `/today`'s "Today's signal —
 * at most ONE insight card". This serves that card, and the adherence figures
 * themselves appear where they are actionable.
 *
 * ## The response includes what did not fire, on purpose
 *
 * `insufficient` and `baseline` travel with `surfaced`. §10.6 control 1: "Below
 * the gate, the detector reports *insufficient data* — which is itself
 * displayed, because 'not enough data yet' is honest and builds trust." A
 * surface that showed nothing would be indistinguishable from one that was
 * broken.
 */

import { NextResponse, type NextRequest } from 'next/server';

import {
  errorResponse,
  guard,
  internalErrorResponse,
  isGuardFailure,
} from '@/lib/platform/context';
import { loadInsights, topFinding } from '@/lib/platform/insights';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const guarded = await guard(request, 'observation:read');
  if (isGuardFailure(guarded)) return guarded.response;
  const { traceId, platform } = guarded.context;

  const toDayKey = new URL(request.url).searchParams.get('toDayKey');
  if (toDayKey === null || !/^\d{4}-\d{2}-\d{2}$/u.test(toDayKey)) {
    return errorResponse(
      { kind: 'validation', code: 'invalid_day', message: 'toDayKey must be YYYY-MM-DD.', issues: [] },
      traceId,
    );
  }

  try {
    const result = await loadInsights(platform.db, { toDayKey, zone: platform.zone });
    if (!result.ok) return errorResponse(result.error, traceId);

    return NextResponse.json({
      /* §3.2's cap, applied server-side so no client can widen it. */
      signal: topFinding(result.value),
      surfaced: result.value.surfaced,
      insufficient: result.value.insufficient,
      baseline: result.value.baseline,
      /*
       * The comparison count and the FDR threshold, in the response.
       *
       * §10.6 requires every insight to be auditable. The number of comparisons
       * the night made is part of what makes a p-value interpretable, and
       * omitting it would leave the operator with a finding they cannot check.
       */
      comparisons: result.value.comparisons,
      fdrThreshold: result.value.fdrThreshold,
    });
  } catch (error: unknown) {
    platform.observability.logger.error('unhandled error in insights.get', {
      traceId,
      component: 'insights.get',
      identifiers: { name: error instanceof Error ? error.name : 'unknown' },
    });
    return internalErrorResponse(traceId);
  }
}
