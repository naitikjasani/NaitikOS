/**
 * `/api/gym/volume` — §4.1's "volume/intensity/frequency analysis by muscle
 * group", over a calendar window.
 *
 * The window is a pair of day keys plus a zone, not a pair of instants, because
 * "this month" is a calendar range in the operator's zone (§5.3) and the
 * difference between the two framings is a day at each end.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { volumeQuerySchema } from '@naitikos/api';
import { MUSCLE_GROUP_LABELS, SECONDARY_MUSCLE_SHARE, formatDecimal, type MuscleGroup } from '@naitikos/core';

import {
  errorResponse,
  guard,
  internalErrorResponse,
  isGuardFailure,
  parseQuery,
} from '@/lib/platform/context';
import { loadVolume } from '@/lib/platform/gym';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const guarded = await guard(request, 'observation:read');
  if (isGuardFailure(guarded)) return guarded.response;
  const { traceId, platform } = guarded.context;

  const parsed = parseQuery(request, volumeQuerySchema, traceId);
  if ('response' in parsed) return parsed.response;

  try {
    const result = await loadVolume(
      platform.db,
      parsed.data.fromDayKey,
      parsed.data.toDayKey,
      parsed.data.zone,
    );
    if (!result.ok) return errorResponse(result.error, traceId);

    return NextResponse.json({
      fromDayKey: result.value.fromDayKey,
      toDayKey: result.value.toDayKey,
      byMuscle: result.value.byMuscle.map((entry) => ({
        muscle: entry.muscle,
        label: MUSCLE_GROUP_LABELS[entry.muscle as MuscleGroup] ?? entry.muscle,
        volume: entry.volume,
        sets: entry.sets,
      })),
      total: {
        volume: formatDecimal(result.value.total.total, { trim: true }),
        countedSets: result.value.total.countedSets,
        totalReps: result.value.total.totalReps,
        excluded: result.value.total.excluded,
      },
      sessionDays: result.value.sessionDays,
      /*
       * The attribution convention travels with the numbers.
       *
       * `volume.ts` calls this "the least defensible number in the file", and
       * a chart that shows attributed volume without saying how it was
       * attributed is exactly the kind of authoritative-looking figure §8.9
       * warns about. The UI renders it under the axis.
       */
      method: {
        secondaryMuscleShare: SECONDARY_MUSCLE_SHARE,
        note: 'A set counts fully towards its primary muscle and at a fixed share towards each secondary. Totals across muscles therefore exceed the session total; this is a convention, not a measurement.',
      },
    });
  } catch (error: unknown) {
    platform.observability.logger.error('unhandled error in gym.volume.get', {
      traceId,
      component: 'gym.volume.get',
      identifiers: { name: error instanceof Error ? error.name : 'unknown' },
    });
    return internalErrorResponse(traceId);
  }
}
