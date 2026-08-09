/**
 * `/api/gym/program` — the active program and how the fortnight is going.
 *
 * §12 lists "program definition and adherence" for this week. **Adherence is
 * built; definition is not** — authoring a program is a form-heavy surface, and
 * §12's exit criterion is about the logger being usable under fatigue. So this
 * reads a program the operator has (for now) inserted directly, and answers the
 * question that matters day to day: am I training as often as I said I would?
 *
 * `programAdherence` is uncapped upwards on purpose. A fortnight with ten
 * sessions against a target of six reports 1.67, not 1 — clamping would hide the
 * case worth noticing, which is training more than planned, the usual prelude to
 * the injury a deload was supposed to prevent.
 */

import { NextResponse, type NextRequest } from 'next/server';
import {
  dayKeyInZone,
  isoFromMillis,
  nextBlock,
  programAdherence,
  shiftDayKey,
  systemClock,
  zonedDayBounds,
} from '@naitikos/core';
import { createProgramRepository, createWorkoutRepository } from '@naitikos/db';

import {
  DEFAULT_PROFILE_ZONE,
  errorResponse,
  guard,
  internalErrorResponse,
  isGuardFailure,
} from '@/lib/platform/context';

export const dynamic = 'force-dynamic';

/** Two weeks. Long enough for a frequency target to mean something. */
const WINDOW_DAYS = 14;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const guarded = await guard(request, 'observation:read');
  if (isGuardFailure(guarded)) return guarded.response;
  const { traceId, platform } = guarded.context;

  try {
    const programs = createProgramRepository(platform.db);
    const active = await programs.active();
    if (!active.ok) return errorResponse(active.error, traceId);

    // No program is a normal state, not an error. Most weeks of most people's
    // training are not run against a written plan.
    if (active.value === null) {
      return NextResponse.json({ program: null, adherence: null, nextBlock: null });
    }

    const zone = DEFAULT_PROFILE_ZONE;
    const toDayKey = dayKeyInZone(isoFromMillis(systemClock.nowMillis()), zone);
    const fromDayKey = shiftDayKey(toDayKey, -(WINDOW_DAYS - 1)) ?? toDayKey;

    const start = zonedDayBounds(fromDayKey, zone);
    const end = zonedDayBounds(toDayKey, zone);
    if (start === null || end === null) return internalErrorResponse(traceId);

    const days = await createWorkoutRepository(platform.db).sessionDays(start.start, end.end);
    if (!days.ok) return errorResponse(days.error, traceId);

    const blocks = await programs.blocksFor(active.value.id);
    if (!blocks.ok) return errorResponse(blocks.error, traceId);

    const lastBlock = await programs.lastPerformedBlockId(active.value.id);
    if (!lastBlock.ok) return errorResponse(lastBlock.error, traceId);

    return NextResponse.json({
      program: active.value,
      adherence: programAdherence(active.value, days.value, { fromDayKey, toDayKey }),
      nextBlock: nextBlock(blocks.value, lastBlock.value),
    });
  } catch (error: unknown) {
    platform.observability.logger.error('unhandled error in gym.program.get', {
      traceId,
      component: 'gym.program.get',
      identifiers: { name: error instanceof Error ? error.name : 'unknown' },
    });
    return internalErrorResponse(traceId);
  }
}
