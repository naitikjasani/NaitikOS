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
import { z } from 'zod';
import { isoFromMillis, systemClock } from '@naitikos/core';
import { createInsightRepository } from '@naitikos/db';

import {
  errorResponse,
  guard,
  internalErrorResponse,
  isGuardFailure,
} from '@/lib/platform/context';
import { loadInsights, topFinding } from '@/lib/platform/insights';
import { parseJson } from '@/lib/platform/context';

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

/**
 * A disposition — §4.13's "dismissals train the ranking".
 *
 * There is no field here for anything the operator *thinks* about the finding
 * beyond a free-text reason, and no field at all for editing its content. An
 * insight is a record of what a detector found on a night; a surface that let it
 * be rewritten would make the audit trail a record of what the operator later
 * preferred it to have found.
 */
const dispositionSchema = z.object({
  id: z.string().uuid(),
  disposition: z.enum(['seen', 'acted_on', 'dismissed']),
  reason: z.string().max(500).nullish(),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  /*
   * `observation:write`, not `settings:write`. Marking an insight acted-on is a
   * statement about what happened, and §12's V2 gate is measured on exactly
   * this — "at least one insight the operator acted on" — so it belongs with
   * the permission that records facts rather than the one that changes
   * configuration.
   */
  const guarded = await guard(request, 'observation:write');
  if (isGuardFailure(guarded)) return guarded.response;
  const { traceId, platform } = guarded.context;

  const parsed = await parseJson(request, dispositionSchema, traceId);
  if ('response' in parsed) return parsed.response;

  try {
    const updated = await createInsightRepository(platform.db).setDisposition({
      id: parsed.data.id,
      disposition: parsed.data.disposition,
      reason: parsed.data.reason ?? null,
      nowIso: isoFromMillis(systemClock.nowMillis()),
    });
    if (!updated.ok) return errorResponse(updated.error, traceId);

    return NextResponse.json({ updated: updated.value });
  } catch (error: unknown) {
    platform.observability.logger.error('unhandled error in insights.post', {
      traceId,
      component: 'insights.post',
      identifiers: { name: error instanceof Error ? error.name : 'unknown' },
    });
    return internalErrorResponse(traceId);
  }
}
