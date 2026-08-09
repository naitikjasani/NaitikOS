/**
 * `/api/medications` — the register, its adherence, and a dose log.
 *
 * The register lives in Health (§4.7: "Medication data lives in Health; Mind
 * reads it"), so the route is not under `/api/mind`. `/mind/meds` is a lens
 * over it, filtered to psychiatric medications — §3.3(3)'s "one row, three
 * lenses" made literal by a query parameter rather than by a second table.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { adherenceQuerySchema, logDoseRequestSchema } from '@naitikos/api';

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
import { loadMedicationLens, logDose } from '@/lib/platform/mind';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const guarded = await guard(request, 'observation:read');
  if (isGuardFailure(guarded)) return guarded.response;
  const { traceId, platform } = guarded.context;

  const parsed = parseQuery(request, adherenceQuerySchema, traceId);
  if ('response' in parsed) return parsed.response;

  const psychiatricOnly = new URL(request.url).searchParams.get('lens') === 'psychiatric';

  try {
    const result = await loadMedicationLens(
      platform.db,
      withoutUndefined({
        toDayKey: parsed.data.toDayKey,
        zone: parsed.data.zone,
        windowDays: parsed.data.windowDays,
        psychiatricOnly,
      }),
    );
    if (!result.ok) return errorResponse(result.error, traceId);
    return NextResponse.json(result.value);
  } catch (error: unknown) {
    platform.observability.logger.error('unhandled error in medications.get', {
      traceId,
      component: 'medications.get',
      identifiers: { name: error instanceof Error ? error.name : 'unknown' },
    });
    return internalErrorResponse(traceId);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const guarded = await guard(request, 'observation:write');
  if (isGuardFailure(guarded)) return guarded.response;
  const { traceId, platform } = guarded.context;

  const parsed = await parseJson(request, logDoseRequestSchema, traceId);
  if ('response' in parsed) return parsed.response;

  try {
    return await withIdempotency(
      platform.db,
      parsed.data.idempotencyKey,
      'POST /api/medications',
      parsed.data,
      traceId,
      async () => {
        const result = await logDose(
          platform.db,
          withoutUndefined({
            id: parsed.data.id,
            medicationId: parsed.data.medicationId,
            scheduleId: parsed.data.scheduleId ?? null,
            kind: parsed.data.kind,
            scheduledFor: parsed.data.scheduledFor,
            takenAt: parsed.data.takenAt ?? null,
            zone: parsed.data.zone,
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
    platform.observability.logger.error('unhandled error in medications.post', {
      traceId,
      component: 'medications.post',
      identifiers: { name: error instanceof Error ? error.name : 'unknown' },
    });
    return internalErrorResponse(traceId);
  }
}
