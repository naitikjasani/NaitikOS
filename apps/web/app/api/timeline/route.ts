/**
 * GET /api/timeline
 *
 * §3.3 R5: "Timeline is the escape hatch. Any entity anywhere links to its
 * position on the timeline; the timeline links back to every entity."
 *
 * One indexed scan over the projection. No joins to domain tables — that is what
 * the denormalised entry is for, and it is safe because ADR 0005's payload rule
 * means the denormalised fields are labels and references, never values that
 * could drift out of agreement with a number.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { timelineQuerySchema } from '@naitikos/api';

import {
  errorResponse,
  guard,
  isGuardFailure,
  parseQuery,
  traceIdFor,
  unhandledErrorResponse,
  withoutUndefined,
} from '../../../lib/platform/context';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const traceId = traceIdFor(request);

  try {
    const guarded = await guard(request, 'observation:read');
    if (isGuardFailure(guarded)) return guarded.response;
    const { platform } = guarded.context;

    const parsed = parseQuery(request, timelineQuerySchema, traceId);
    if ('response' in parsed) return parsed.response;
    const query = parsed.data;

    const page = await platform.observability.metrics.time(
      'timeline.query.duration',
      { route: '/api/timeline' },
      () =>
        platform.timeline.query(
          {
            ...withoutUndefined(query),
            // Recombined here rather than in the schema: `core`'s query takes one
            // entity object, and the wire has to be two flat parameters.
            ...(query.entityType === undefined || query.entityId === undefined
              ? {}
              : { entity: { type: query.entityType, id: query.entityId } }),
          },
          platform.zone,
        ),
    );

    if (!page.ok) return errorResponse(page.error, traceId);

    return NextResponse.json(page.value, {
      headers: {
        // Never cached. A timeline is the user's own record and a shared cache
        // holding it is the §5.5 privacy boundary leaking through HTTP.
        'cache-control': 'private, no-store',
      },
    });
  } catch (error: unknown) {
    return unhandledErrorResponse('timeline.get', traceId, error);
  }
}
