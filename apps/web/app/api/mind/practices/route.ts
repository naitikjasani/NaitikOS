/**
 * `/api/mind/practices` — meditation, breathwork, grounding (§4.7).
 */

import type { NextRequest, NextResponse } from 'next/server';
import { uuidV7 } from '@naitikos/shared';
import { systemClock } from '@naitikos/core';
import { logPracticeRequestSchema } from '@naitikos/api';

import {
  errorResponse,
  guard,
  internalErrorResponse,
  isGuardFailure,
  parseJson,
  withoutUndefined,
} from '@/lib/platform/context';
import { withIdempotency } from '@/lib/platform/idempotent';
import { logPracticeSession } from '@/lib/platform/mind';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const guarded = await guard(request, 'observation:write');
  if (isGuardFailure(guarded)) return guarded.response;
  const { traceId, platform } = guarded.context;

  const parsed = await parseJson(request, logPracticeRequestSchema, traceId);
  if ('response' in parsed) return parsed.response;

  try {
    return await withIdempotency(
      platform.db,
      parsed.data.idempotencyKey,
      'POST /api/mind/practices',
      parsed.data,
      traceId,
      async () => {
        const result = await logPracticeSession(
          platform.db,
          withoutUndefined({ deviceId: parsed.data.deviceId, clientHlc: parsed.data.clientHlc }),
          withoutUndefined({
            id: parsed.data.id,
            kind: parsed.data.kind,
            startedAt: parsed.data.startedAt,
            zone: parsed.data.zone,
            durationMinutes: parsed.data.durationMinutes,
            method: parsed.data.method,
            stateBefore: parsed.data.stateBefore,
            stateAfter: parsed.data.stateAfter,
            note: parsed.data.note,
          }),
          () => uuidV7(systemClock.nowMillis()),
        );

        if (!result.ok) {
          const response = errorResponse(result.error, traceId);
          return { status: response.status, body: await response.json() };
        }
        return { status: 201, body: { practice: result.value } };
      },
    );
  } catch (error: unknown) {
    platform.observability.logger.error('unhandled error in mind.practices.post', {
      traceId,
      component: 'mind.practices.post',
      identifiers: { name: error instanceof Error ? error.name : 'unknown' },
    });
    return internalErrorResponse(traceId);
  }
}
