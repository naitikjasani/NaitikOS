/**
 * `/api/gym/sessions` — starting and ending a training session.
 *
 * Two verbs on one resource, both idempotent, because the offline outbox will
 * replay them (§5.7). The interesting property is that neither one *fails* in a
 * way the operator has to deal with mid-session: a replayed start returns the
 * session as it stands, and a replayed close returns it closed at its original
 * end time.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { closeSessionRequestSchema, startSessionRequestSchema } from '@naitikos/api';
import { formatDecimal, isoFromMillis, systemClock } from '@naitikos/core';
import { createWorkoutRepository } from '@naitikos/db';

import {
  errorResponse,
  guard,
  internalErrorResponse,
  isGuardFailure,
  parseJson,
  withoutUndefined,
} from '@/lib/platform/context';
import { withIdempotency } from '@/lib/platform/idempotent';
import { closeWorkoutSession, startWorkoutSession } from '@/lib/platform/gym';
import { draftForWorkoutCompleted, draftForWorkoutStarted } from '@/lib/platform/capture-events';

export const dynamic = 'force-dynamic';

/** The session currently open, if any. What the logger checks on load. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const guarded = await guard(request, 'observation:read');
  if (isGuardFailure(guarded)) return guarded.response;
  const { traceId, platform } = guarded.context;

  try {
    const workouts = createWorkoutRepository(platform.db);
    const active = await workouts.activeSession();
    if (!active.ok) return errorResponse(active.error, traceId);

    const recent = await workouts.recentSessions(20);
    if (!recent.ok) return errorResponse(recent.error, traceId);

    /*
     * The current bodyweight travels with the session list.
     *
     * The logger needs it *before* the first set, to say whether bodyweight
     * movements will count towards volume — `volume.ts` refuses to guess one,
     * and discovering that at the end of the session is too late. One round
     * trip, because the logger already makes this one.
     */
    const bodyweight = await workouts.bodyweightAt(isoFromMillis(systemClock.nowMillis()));
    if (!bodyweight.ok) return errorResponse(bodyweight.error, traceId);

    return NextResponse.json({
      active: active.value,
      recent: recent.value,
      bodyweightKg: bodyweight.value,
    });
  } catch (error: unknown) {
    platform.observability.logger.error('unhandled error in gym.sessions.get', {
      traceId,
      component: 'gym.sessions.get',
      identifiers: { name: error instanceof Error ? error.name : 'unknown' },
    });
    return internalErrorResponse(traceId);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const guarded = await guard(request, 'observation:write');
  if (isGuardFailure(guarded)) return guarded.response;
  const { traceId, platform } = guarded.context;

  const parsed = await parseJson(request, startSessionRequestSchema, traceId);
  if ('response' in parsed) return parsed.response;

  try {
    return await withIdempotency(
      platform.db,
      parsed.data.idempotencyKey,
      'POST /api/gym/sessions',
      parsed.data,
      traceId,
      async () => {
        const result = await startWorkoutSession(platform.db, {
          id: parsed.data.id,
          startedAt: parsed.data.startedAt,
          zone: parsed.data.zone,
          programId: parsed.data.programId ?? null,
          programBlockId: parsed.data.programBlockId ?? null,
          title: parsed.data.title ?? null,
          location: parsed.data.location ?? null,
          bodyweightKg: parsed.data.bodyweightKg ?? null,
        });

        if (!result.ok) {
          const response = errorResponse(result.error, traceId);
          return { status: response.status, body: await response.json() };
        }

        const published = await platform.bus.publish([
          draftForWorkoutStarted(
            result.value.id,
            result.value.startedAt,
            guarded.context.actor.subjectId,
            result.value.programId,
          ),
        ]);
        if (!published.ok) {
          // Swallowed: the session must not fail to start because the timeline
          // could not be told about it. Same reasoning as the close route.
          platform.observability.logger.warn('workout start event was not published', {
            traceId,
            component: 'gym.sessions',
            identifiers: { code: published.error.code },
          });
        }

        return {
          status: 201,
          body: {
            session: result.value,
            /*
             * Echoed so the logger can say "bodyweight 74.2 kg, from 16 August"
             * — or, when it is null, "no bodyweight recorded; bodyweight
             * movements will not count towards volume". The operator finding
             * that out at the end of the session is too late.
             */
            bodyweightKg: result.value.bodyweightAtSession,
          },
        };
      },
    );
  } catch (error: unknown) {
    platform.observability.logger.error('unhandled error in gym.sessions.post', {
      traceId,
      component: 'gym.sessions.post',
      identifiers: { name: error instanceof Error ? error.name : 'unknown' },
    });
    return internalErrorResponse(traceId);
  }
}

/** End a session, deriving its volume and duration. */
export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const guarded = await guard(request, 'observation:write');
  if (isGuardFailure(guarded)) return guarded.response;
  const { traceId, platform } = guarded.context;

  const parsed = await parseJson(request, closeSessionRequestSchema, traceId);
  if ('response' in parsed) return parsed.response;

  try {
    return await withIdempotency(
      platform.db,
      parsed.data.idempotencyKey,
      'PATCH /api/gym/sessions',
      parsed.data,
      traceId,
      async () => {
        const result = await closeWorkoutSession(
          platform.db,
          withoutUndefined({
            sessionId: parsed.data.sessionId,
            endedAt: parsed.data.endedAt,
            perceivedEffort: parsed.data.perceivedEffort ?? null,
            notes: parsed.data.notes ?? null,
          }),
          withoutUndefined({ deviceId: parsed.data.deviceId, clientHlc: parsed.data.clientHlc }),
        );

        if (!result.ok) {
          const response = errorResponse(result.error, traceId);
          return { status: response.status, body: await response.json() };
        }

        // Only on the write that actually closed it. A replay must not put a
        // second "session completed" entry on the timeline.
        if (result.value.written) {
          const published = await platform.bus.publish([
            draftForWorkoutCompleted(
              result.value.session.id,
              parsed.data.endedAt,
              result.value.setCount,
              result.value.exerciseCount,
              result.value.durationMinutes,
              guarded.context.actor.subjectId,
            ),
          ]);
          if (!published.ok) {
            platform.observability.logger.warn('workout completion event was not published', {
              traceId,
              component: 'gym.sessions',
              identifiers: { code: published.error.code },
            });
          }
        }

        return {
          status: 200,
          body: {
            session: result.value.session,
            durationMinutes: result.value.durationMinutes,
            volume: {
              total: formatDecimal(result.value.volume.total, { trim: true }),
              countedSets: result.value.volume.countedSets,
              totalReps: result.value.volume.totalReps,
              /*
               * Surfaced, never swallowed. A session whose bodyweight was never
               * recorded silently loses every pull-up set from its volume, and
               * §8.9(3)'s "missing data is shown as missing" applies to a number
               * as much as to a chart.
               */
              excluded: result.value.volume.excluded,
            },
            hlc: result.value.hlc,
          },
        };
      },
    );
  } catch (error: unknown) {
    platform.observability.logger.error('unhandled error in gym.sessions.patch', {
      traceId,
      component: 'gym.sessions.patch',
      identifiers: { name: error instanceof Error ? error.name : 'unknown' },
    });
    return internalErrorResponse(traceId);
  }
}
