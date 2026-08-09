/**
 * `/api/gym/sets` — one set, written the moment it is finished.
 *
 * One set per request rather than a batch, and §12's exit criterion is the
 * reason: "a real training session logged in the gym, on a phone, without
 * friction." A batch endpoint invites the client to accumulate, and a client
 * that accumulates loses the session when the phone dies between the fourth set
 * and the fifth.
 *
 * The set is durable in the outbox before this endpoint is called at all, so
 * from the operator's point of view the write cannot fail — it is queued, the
 * banner says so, and it lands when there is signal.
 */

// Type-only: this handler never constructs a response itself. Every exit is
// through `errorResponse`, `internalErrorResponse`, or `withIdempotency` —
// which is §5.2's "a handler parses, authenticates, delegates, and serialises"
// taken literally enough that the import shape shows it.
import type { NextRequest, NextResponse } from 'next/server';
import { logSetRequestSchema } from '@naitikos/api';

import {
  errorResponse,
  guard,
  internalErrorResponse,
  isGuardFailure,
  parseJson,
  withoutUndefined,
} from '@/lib/platform/context';
import { withIdempotency } from '@/lib/platform/idempotent';
import { logWorkoutSet } from '@/lib/platform/gym';
import { draftForSetLogged } from '@/lib/platform/capture-events';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const guarded = await guard(request, 'observation:write');
  if (isGuardFailure(guarded)) return guarded.response;
  const { traceId, platform } = guarded.context;

  const parsed = await parseJson(request, logSetRequestSchema, traceId);
  if ('response' in parsed) return parsed.response;

  try {
    return await withIdempotency(
      platform.db,
      parsed.data.idempotencyKey,
      'POST /api/gym/sets',
      parsed.data,
      traceId,
      async () => {
        const result = await logWorkoutSet(
          platform.db,
          {
            sessionId: parsed.data.sessionId,
            performedAt: parsed.data.performedAt,
            zone: parsed.data.zone,
            set: withoutUndefined(parsed.data.set),
          },
          withoutUndefined({ deviceId: parsed.data.deviceId, clientHlc: parsed.data.clientHlc }),
        );

        if (!result.ok) {
          const response = errorResponse(result.error, traceId);
          return { status: response.status, body: await response.json() };
        }

        // Only on the write that actually landed. A replay must not put a second
        // set on the timeline, and must not celebrate the same PR twice.
        if (result.value.written) {
          const published = await platform.bus.publish([
            draftForSetLogged(result.value.set, result.value.exercise.name, guarded.context.actor.subjectId),
          ]);
          if (!published.ok) {
            platform.observability.logger.warn('set event was not published', {
              traceId,
              component: 'gym.sets',
              identifiers: { code: published.error.code },
            });
          }
        }

        return {
          status: 201,
          body: {
            set: result.value.set,
            /*
             * The records this set broke, and whether it was the first ever.
             *
             * Both, because they render differently: §4.1's PR badge fires on
             * `kinds`, while `isFirst` renders "first logged" — everything is a
             * record the first time, and badging that as a PR is the noise that
             * teaches the operator to ignore the badge.
             */
            records: result.value.records.kinds,
            isFirstEver: result.value.records.isFirst,
            estimatedOneRepMax:
              result.value.records.estimatedOneRepMax === null
                ? null
                : formatEstimate(result.value.records.estimatedOneRepMax),
            hlc: result.value.hlc,
          },
        };
      },
    );
  } catch (error: unknown) {
    platform.observability.logger.error('unhandled error in gym.sets.post', {
      traceId,
      component: 'gym.sets.post',
      identifiers: { name: error instanceof Error ? error.name : 'unknown' },
    });
    return internalErrorResponse(traceId);
  }
}

/** Two places is enough for an estimate that is itself approximate. */
function formatEstimate(value: { readonly unscaled: bigint; readonly scale: number }): string {
  const scaled = Number(value.unscaled) / 10 ** value.scale;
  return scaled.toFixed(1);
}
