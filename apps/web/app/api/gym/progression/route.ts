/**
 * `/api/gym/progression` — one exercise's history, and the prefill.
 *
 * Two things in one response because they come from one read. §4.1's design
 * note makes the prefill the primary interaction — "confirming or nudging
 * rather than typing" — and a second round trip to fetch it would put the
 * network between the operator and the field they are about to tap.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { progressionQuerySchema } from '@naitikos/api';
import { formatDecimal } from '@naitikos/core';

import {
  errorResponse,
  guard,
  internalErrorResponse,
  isGuardFailure,
  parseQuery,
} from '@/lib/platform/context';
import { loadProgression } from '@/lib/platform/gym';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const guarded = await guard(request, 'observation:read');
  if (isGuardFailure(guarded)) return guarded.response;
  const { traceId, platform } = guarded.context;

  const parsed = parseQuery(request, progressionQuerySchema, traceId);
  if ('response' in parsed) return parsed.response;

  const url = new URL(request.url);
  const excludeSessionId = url.searchParams.get('excludeSessionId');
  const setIndex = Number(url.searchParams.get('setIndex') ?? '0');

  try {
    const result = await loadProgression(platform.db, parsed.data.exerciseId, {
      ...(excludeSessionId === null ? {} : { excludeSessionId }),
      setIndex: Number.isInteger(setIndex) && setIndex >= 0 ? setIndex : 0,
    });
    if (!result.ok) return errorResponse(result.error, traceId);

    return NextResponse.json({
      exercise: result.value.exercise,
      prefill: result.value.prefill,
      /*
       * Decimals are formatted here rather than sent as `{ unscaled, scale }`.
       *
       * The chart consumes numbers and the table consumes strings; sending the
       * internal representation over the wire would put `bigint` in JSON, which
       * does not survive `JSON.stringify` at all.
       */
      points: result.value.points.map((point) => ({
        sessionId: point.sessionId,
        dayKey: point.dayKey,
        topLoad: point.topLoad === null ? null : formatDecimal(point.topLoad, { trim: true }),
        topLoadReps: point.topLoadReps,
        relativeTopLoad:
          point.relativeTopLoad === null ? null : formatDecimal(point.relativeTopLoad, { trim: true }),
        bestEstimatedMax:
          point.bestEstimatedMax === null ? null : formatDecimal(point.bestEstimatedMax, { trim: true }),
        volume: point.volume === null ? null : formatDecimal(point.volume, { trim: true }),
        workingSets: point.workingSets,
        totalReps: point.totalReps,
      })),
    });
  } catch (error: unknown) {
    platform.observability.logger.error('unhandled error in gym.progression.get', {
      traceId,
      component: 'gym.progression.get',
      identifiers: { name: error instanceof Error ? error.name : 'unknown' },
    });
    return internalErrorResponse(traceId);
  }
}
