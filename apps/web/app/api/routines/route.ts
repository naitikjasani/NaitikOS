/**
 * `/api/routines` — the shared routine engine (§9.2).
 *
 * Not under `/api/skin`, because it is not Skin's. §9.2: "A generic routine
 * engine reused by skincare, dental hygiene, and supplements. One
 * implementation, three consumers." The `kind` query parameter is the whole
 * difference between the three, and putting the route under one consumer's
 * namespace would guarantee the other two grow their own copy.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { clearRoutineStepRequestSchema, logRoutineStepRequestSchema, routineQuerySchema } from '@naitikos/api';

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
import { clearRoutineStep, loadRoutines, logRoutineStep } from '@/lib/platform/skin';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const guarded = await guard(request, 'observation:read');
  if (isGuardFailure(guarded)) return guarded.response;
  const { traceId, platform } = guarded.context;

  const parsed = parseQuery(request, routineQuerySchema, traceId);
  if ('response' in parsed) return parsed.response;

  try {
    const result = await loadRoutines(platform.db, withoutUndefined(parsed.data));
    if (!result.ok) return errorResponse(result.error, traceId);
    return NextResponse.json({ routines: result.value });
  } catch (error: unknown) {
    platform.observability.logger.error('unhandled error in routines.get', {
      traceId,
      component: 'routines.get',
      identifiers: { name: error instanceof Error ? error.name : 'unknown' },
    });
    return internalErrorResponse(traceId);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const guarded = await guard(request, 'observation:write');
  if (isGuardFailure(guarded)) return guarded.response;
  const { traceId, platform } = guarded.context;

  const parsed = await parseJson(request, logRoutineStepRequestSchema, traceId);
  if ('response' in parsed) return parsed.response;

  try {
    return await withIdempotency(
      platform.db,
      parsed.data.idempotencyKey,
      'POST /api/routines',
      parsed.data,
      traceId,
      async () => {
        const result = await logRoutineStep(
          platform.db,
          withoutUndefined({
            id: parsed.data.id,
            routineId: parsed.data.routineId,
            stepId: parsed.data.stepId ?? null,
            occurredOn: parsed.data.occurredOn,
            completedAt: parsed.data.completedAt ?? null,
            zone: parsed.data.zone,
            status: parsed.data.status,
            note: parsed.data.note,
          }),
        );

        if (!result.ok) {
          const response = errorResponse(result.error, traceId);
          return { status: response.status, body: await response.json() };
        }
        return { status: 201, body: result.value };
      },
    );
  } catch (error: unknown) {
    platform.observability.logger.error('unhandled error in routines.post', {
      traceId,
      component: 'routines.post',
      identifiers: { name: error instanceof Error ? error.name : 'unknown' },
    });
    return internalErrorResponse(traceId);
  }
}

/** Un-tapping a step. A hard delete — see the note on `routine.repository.ts`. */
export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const guarded = await guard(request, 'observation:write');
  if (isGuardFailure(guarded)) return guarded.response;
  const { traceId, platform } = guarded.context;

  const parsed = await parseJson(request, clearRoutineStepRequestSchema, traceId);
  if ('response' in parsed) return parsed.response;

  try {
    const result = await clearRoutineStep(
      platform.db,
      parsed.data.routineId,
      parsed.data.stepId,
      parsed.data.occurredOn,
    );
    if (!result.ok) return errorResponse(result.error, traceId);
    return NextResponse.json(result.value);
  } catch (error: unknown) {
    platform.observability.logger.error('unhandled error in routines.delete', {
      traceId,
      component: 'routines.delete',
      identifiers: { name: error instanceof Error ? error.name : 'unknown' },
    });
    return internalErrorResponse(traceId);
  }
}
