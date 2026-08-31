/**
 * `/api/sleep` — every Sleep write.
 *
 * ## One permission, and it is `observation:write`
 *
 * §5.4 splits permissions by blast radius. A night is a record of something
 * that happened; unlike a food's macros or a nutrition target it does not
 * change how any *other* observation is interpreted, so it sits on the narrow
 * side alongside Work and the Daily Close.
 *
 * ## The server does not fill in a missing duration
 *
 * `bedAt`, `wokeAt` and `durationHours` arrive independently and are stored
 * independently. Deriving the third from the first two here would be one line
 * and it would be wrong on every row: time in bed is not time asleep, the
 * difference is the latency plus the wakings, and a computed duration
 * overstates every night by that amount. A fabricated figure is no more
 * defensible for having been computed server-side (P5, §10.0). The endpoints
 * are read back through `timeInBedHours` and `sleepEfficiency`, which are named
 * for what they actually measure.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { sleepWriteSchema } from '@naitikos/api';
import { isoFromMillis, systemClock, validateSleepNight } from '@naitikos/core';
import { createSleepRepository } from '@naitikos/db';

import {
  errorResponse,
  guard,
  internalErrorResponse,
  isGuardFailure,
  parseJson,
} from '@/lib/platform/context';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const guarded = await guard(request, 'observation:write');
  if (isGuardFailure(guarded)) return guarded.response;
  const { traceId, platform } = guarded.context;

  const parsed = await parseJson(request, sleepWriteSchema, traceId);
  if ('response' in parsed) return parsed.response;

  const sleep = createSleepRepository(platform.db);
  const nowIso = isoFromMillis(systemClock.nowMillis());

  try {
    switch (parsed.data.kind) {
      case 'night': {
        const input = parsed.data.night;
        /*
         * Validated in `core` as well as at the wire. The schema rejects a
         * shape; `validateSleepNight` rejects a night — a wake before a bed,
         * a duration longer than the time in bed, a disturbance note with no
         * disturbance. §5.0 puts that judgement below the transport.
         */
        const validated = validateSleepNight({
          id: input.id,
          dayKey: input.dayKey,
          zone: input.zone,
          bedAt: input.bedAt ?? null,
          wokeAt: input.wokeAt ?? null,
          durationHours: input.durationHours ?? null,
          quality: input.quality ?? null,
          latencyMinutes: input.latencyMinutes ?? null,
          wakings: input.wakings ?? null,
          disturbance: input.disturbance ?? null,
          disturbanceNote: input.disturbanceNote ?? null,
          note: input.note ?? null,
        });
        if (!validated.ok) return errorResponse(validated.error, traceId);

        const recorded = await sleep.recordNight(validated.value);
        if (!recorded.ok) return errorResponse(recorded.error, traceId);
        return NextResponse.json({ night: recorded.value }, { status: 201 });
      }

      default: {
        const input = parsed.data.night;
        /* Asked for, never required. An honest blank beats an invented reason. */
        const removed = await sleep.deleteNight(input.id, nowIso, input.reason ?? null);
        if (!removed.ok) return errorResponse(removed.error, traceId);
        return NextResponse.json({ deleted: removed.value });
      }
    }
  } catch (error: unknown) {
    platform.observability.logger.error('unhandled error in sleep.post', {
      traceId,
      component: 'sleep.post',
      identifiers: { name: error instanceof Error ? error.name : 'unknown' },
    });
    return internalErrorResponse(traceId);
  }
}
