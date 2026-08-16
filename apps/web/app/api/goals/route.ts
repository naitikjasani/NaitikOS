/**
 * `/api/goals` — the goal register.
 *
 * `settings:write`, not `observation:write`. A goal changes what every future
 * projection is measured against; §5.4 splits permissions by blast radius and
 * this is the wider one, the same call `/api/registers` makes for a routine
 * definition.
 *
 * There is no GET. Every goal surface is server-rendered through
 * `lib/platform/goals.ts`, because a goal page is opened deliberately and
 * rarely — polling it would add exactly the background request the counter
 * metric in §1.4 exists to discourage.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { goalWriteSchema } from '@naitikos/api';
import { isoFromMillis, systemClock, validateGoal } from '@naitikos/core';
import { createGoalRepository } from '@naitikos/db';

import {
  errorResponse,
  guard,
  internalErrorResponse,
  isGuardFailure,
  parseJson,
} from '@/lib/platform/context';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const guarded = await guard(request, 'settings:write');
  if (isGuardFailure(guarded)) return guarded.response;
  const { traceId, platform } = guarded.context;

  const parsed = await parseJson(request, goalWriteSchema, traceId);
  if ('response' in parsed) return parsed.response;

  const goals = createGoalRepository(platform.db);

  try {
    if (parsed.data.kind === 'create') {
      const input = parsed.data.goal;
      /*
       * Validated in `core` as well as at the wire.
       *
       * The schema rejects a *shape*; `validateGoal` rejects a *goal* — a
       * horizon before the start, a rate target with too short a window. §5.0
       * puts that judgement below the transport, and duplicating the cheap
       * checks is the price of the expensive one living in the right place.
       */
      const validated = validateGoal({
        id: input.id,
        title: input.title,
        description: input.description ?? null,
        startedAt: input.startedAt,
        horizonAt: input.horizonAt ?? null,
        targets: input.targets.map((target) => ({
          id: target.id,
          metricKey: target.metricKey,
          comparator: target.comparator,
          targetValue: target.targetValue,
          unit: target.unit,
          windowDays: target.windowDays ?? null,
        })),
      });
      if (!validated.ok) return errorResponse(validated.error, traceId);

      const created = await goals.create(validated.value);
      if (!created.ok) return errorResponse(created.error, traceId);
      return NextResponse.json({ goal: created.value }, { status: 201 });
    }

    const input = parsed.data.close;
    const closed = await goals.close({
      id: input.id,
      status: input.status,
      closingNote: input.closingNote ?? null,
      at: isoFromMillis(systemClock.nowMillis()),
    });
    if (!closed.ok) return errorResponse(closed.error, traceId);
    return NextResponse.json({ goal: closed.value });
  } catch (error: unknown) {
    platform.observability.logger.error('unhandled error in goals.post', {
      traceId,
      component: 'goals.post',
      identifiers: { name: error instanceof Error ? error.name : 'unknown' },
    });
    return internalErrorResponse(traceId);
  }
}
