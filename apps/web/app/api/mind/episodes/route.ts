/**
 * `/api/mind/episodes` — anxiety episodes.
 *
 * A POST is idempotent on the client-generated id, like every other write on
 * the offline path: an episode logged on a train, queued, and replayed twice
 * must be one episode with one anxiety observation.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { uuidV7 } from '@naitikos/shared';
import { systemClock } from '@naitikos/core';
import { closeEpisodeRequestSchema, logEpisodeRequestSchema } from '@naitikos/api';

import {
  errorResponse,
  guard,
  internalErrorResponse,
  isGuardFailure,
  parseJson,
  withoutUndefined,
} from '@/lib/platform/context';
import { withIdempotency } from '@/lib/platform/idempotent';
import { closeAnxietyEpisode, logAnxietyEpisode } from '@/lib/platform/mind';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const guarded = await guard(request, 'observation:write');
  if (isGuardFailure(guarded)) return guarded.response;
  const { traceId, platform } = guarded.context;

  const parsed = await parseJson(request, logEpisodeRequestSchema, traceId);
  if ('response' in parsed) return parsed.response;

  try {
    return await withIdempotency(
      platform.db,
      parsed.data.idempotencyKey,
      'POST /api/mind/episodes',
      parsed.data,
      traceId,
      async () => {
        const result = await logAnxietyEpisode(
          platform.db,
          withoutUndefined({ deviceId: parsed.data.deviceId, clientHlc: parsed.data.clientHlc }),
          withoutUndefined({
            id: parsed.data.id,
            startedAt: parsed.data.startedAt,
            endedAt: parsed.data.endedAt,
            zone: parsed.data.zone,
            intensity: parsed.data.intensity,
            physicalSymptoms: parsed.data.physicalSymptoms,
            trigger: parsed.data.trigger,
            copingResponse: parsed.data.copingResponse,
            outcome: parsed.data.outcome,
            note: parsed.data.note,
          }),
          () => uuidV7(systemClock.nowMillis()),
        );

        if (!result.ok) {
          const response = errorResponse(result.error, traceId);
          return { status: response.status, body: await response.json() };
        }
        return { status: 201, body: { episode: result.value } };
      },
    );
  } catch (error: unknown) {
    platform.observability.logger.error('unhandled error in mind.episodes.post', {
      traceId,
      component: 'mind.episodes.post',
      identifiers: { name: error instanceof Error ? error.name : 'unknown' },
    });
    return internalErrorResponse(traceId);
  }
}

/** Closing an open episode. Idempotent: a replay keeps the original end time. */
export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const guarded = await guard(request, 'observation:write');
  if (isGuardFailure(guarded)) return guarded.response;
  const { traceId, platform } = guarded.context;

  const parsed = await parseJson(request, closeEpisodeRequestSchema, traceId);
  if ('response' in parsed) return parsed.response;

  try {
    const result = await closeAnxietyEpisode(platform.db, parsed.data.id, parsed.data.endedAt);
    if (!result.ok) return errorResponse(result.error, traceId);
    return NextResponse.json({ episode: result.value });
  } catch (error: unknown) {
    platform.observability.logger.error('unhandled error in mind.episodes.patch', {
      traceId,
      component: 'mind.episodes.patch',
      identifiers: { name: error instanceof Error ? error.name : 'unknown' },
    });
    return internalErrorResponse(traceId);
  }
}
