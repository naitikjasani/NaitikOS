/**
 * `/api/nutrition/parse` — a POST that reads.
 *
 * Returns candidates and writes nothing. A GET with a body is not a thing, and
 * a page of pasted nutrition-panel text does not belong in a query string — or
 * in an access log.
 *
 * `observation:read`, not a write permission, because that is what it is.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { parseRequestSchema } from '@naitikos/api';

import {
  errorResponse,
  guard,
  internalErrorResponse,
  isGuardFailure,
  parseJson,
} from '@/lib/platform/context';
import { parseLabel, parseMeal } from '@/lib/platform/nutrition';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const guarded = await guard(request, 'observation:read');
  if (isGuardFailure(guarded)) return guarded.response;
  const { traceId, platform } = guarded.context;

  const parsed = await parseJson(request, parseRequestSchema, traceId);
  if ('response' in parsed) return parsed.response;

  try {
    if (parsed.data.kind === 'label') {
      return NextResponse.json(await parseLabel(parsed.data.text));
    }

    const result = await parseMeal(platform.db, parsed.data.text);
    if (!result.ok) return errorResponse(result.error, traceId);
    return NextResponse.json(result.value);
  } catch (error: unknown) {
    platform.observability.logger.error('unhandled error in nutrition.parse', {
      traceId,
      component: 'nutrition.parse',
      identifiers: { name: error instanceof Error ? error.name : 'unknown' },
    });
    return internalErrorResponse(traceId);
  }
}
