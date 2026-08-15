/**
 * `/api/documents/:id/confirm` — the moment a document becomes a record.
 *
 * This is the write §4.11 describes: "a lab PDF dropped into the vault becomes
 * structured lab observations with the source document permanently attached as
 * evidence". It writes a `lab_panel`, its `lab_result` rows with the ranges
 * exactly as printed, and the observations that make each one trend — in one
 * transaction, because a panel with results and no observations looks fine and
 * charts nothing.
 *
 * ## `settings:write`, not `observation:write`
 *
 * A confirmation can write eleven observations at once, backdated to a
 * collection date months ago, into an append-only log. §5.4 splits permissions
 * by blast radius and this is the widest write in Health.
 *
 * ## The response says what will not appear on a chart
 *
 * `withoutTrend` lists results that were stored structurally and produced no
 * observation — an unregistered unit, an uncatalogued analyte, an implausible
 * value. Reported rather than swallowed: a value the operator believes is being
 * tracked and is not is worse than one they know is only on the report.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { confirmLabResultsRequestSchema } from '@naitikos/api';

import {
  errorResponse,
  guard,
  internalErrorResponse,
  isGuardFailure,
  parseJson,
} from '@/lib/platform/context';
import { confirmLabResults } from '@/lib/platform/documents';

export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const guarded = await guard(request, 'settings:write');
  if (isGuardFailure(guarded)) return guarded.response;
  const { traceId, platform } = guarded.context;

  const { id } = await params;
  const parsed = await parseJson(request, confirmLabResultsRequestSchema, traceId);
  if ('response' in parsed) return parsed.response;

  try {
    const result = await confirmLabResults(platform.db, {
      documentId: id,
      panelId: parsed.data.panelId,
      panelName: parsed.data.panelName,
      laboratory: parsed.data.laboratory ?? null,
      collectedAt: parsed.data.collectedAt,
      zone: parsed.data.zone,
      decisions: parsed.data.decisions.map((decision) => ({
        key: decision.key,
        accept: decision.accept,
        correctedValue: decision.correctedValue ?? null,
        correctedUnit: decision.correctedUnit ?? null,
      })),
      envelope: { deviceId: 'server' },
    });
    if (!result.ok) return errorResponse(result.error, traceId);
    return NextResponse.json(result.value, { status: 201 });
  } catch (error: unknown) {
    platform.observability.logger.error('unhandled error in documents.confirm', {
      traceId,
      component: 'documents.confirm',
      identifiers: { name: error instanceof Error ? error.name : 'unknown' },
    });
    return internalErrorResponse(traceId);
  }
}
