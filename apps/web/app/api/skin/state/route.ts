/**
 * `/api/skin/state` — the daily skin log.
 *
 * A POST **upserts the day**. Unlike a set, a skin log is a judgement the
 * operator revises: they log in the morning and count lesions properly that
 * evening. The service reads the day first so the second write edits the row
 * and supersedes the observations rather than adding a contradictory second
 * reading — see `lib/platform/skin.ts`.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { uuidV7 } from '@naitikos/shared';
import { systemClock } from '@naitikos/core';
import { logSkinStateRequestSchema, skinWindowSchema } from '@naitikos/api';

import {
  errorResponse,
  guard,
  internalErrorResponse,
  isGuardFailure,
  parseJson,
  parseQuery,
  withoutUndefined,
} from '@/lib/platform/context';
import { withIdempotency } from '@/lib/platform/idempotent';
import { loadSkinOverview, logSkinDay } from '@/lib/platform/skin';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const guarded = await guard(request, 'observation:read');
  if (isGuardFailure(guarded)) return guarded.response;
  const { traceId, platform } = guarded.context;

  const parsed = parseQuery(request, skinWindowSchema, traceId);
  if ('response' in parsed) return parsed.response;

  try {
    const result = await loadSkinOverview(platform.db, { ...parsed.data, zone: platform.zone });
    if (!result.ok) return errorResponse(result.error, traceId);
    return NextResponse.json(result.value);
  } catch (error: unknown) {
    platform.observability.logger.error('unhandled error in skin.state.get', {
      traceId,
      component: 'skin.state.get',
      identifiers: { name: error instanceof Error ? error.name : 'unknown' },
    });
    return internalErrorResponse(traceId);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const guarded = await guard(request, 'observation:write');
  if (isGuardFailure(guarded)) return guarded.response;
  const { traceId, platform } = guarded.context;

  const parsed = await parseJson(request, logSkinStateRequestSchema, traceId);
  if ('response' in parsed) return parsed.response;

  try {
    return await withIdempotency(
      platform.db,
      parsed.data.idempotencyKey,
      'POST /api/skin/state',
      parsed.data,
      traceId,
      async () => {
        const result = await logSkinDay(
          platform.db,
          withoutUndefined({ deviceId: parsed.data.deviceId, clientHlc: parsed.data.clientHlc }),
          withoutUndefined({
            id: parsed.data.id,
            observedOn: parsed.data.observedOn,
            observedAt: parsed.data.observedAt,
            zone: parsed.data.zone,
            overallState: parsed.data.overallState,
            note: parsed.data.note,
            isFlare: parsed.data.isFlare,
            suspectedTrigger: parsed.data.suspectedTrigger,
            regions: (parsed.data.regions ?? []).map((region) => withoutUndefined(region)),
          }),
          () => uuidV7(systemClock.nowMillis()),
        );

        if (!result.ok) {
          const response = errorResponse(result.error, traceId);
          return { status: response.status, body: await response.json() };
        }
        return { status: 201, body: { state: result.value } };
      },
    );
  } catch (error: unknown) {
    platform.observability.logger.error('unhandled error in skin.state.post', {
      traceId,
      component: 'skin.state.post',
      identifiers: { name: error instanceof Error ? error.name : 'unknown' },
    });
    return internalErrorResponse(traceId);
  }
}
