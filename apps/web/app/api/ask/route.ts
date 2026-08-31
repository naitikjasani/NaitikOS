/**
 * `/api/ask` — §4.13's conversational surface.
 *
 * A POST that reads. The question is user content and does not belong in a
 * query string, in a browser history, or in an access log — the same reasoning
 * `/api/nutrition/parse` records for pasted label text, and it matters more
 * here because a question can contain anything.
 *
 * `observation:read`, not `medical:read`. What is actually retrieved is decided
 * by the consent grant (§10.10) rather than by the route's permission, and
 * requiring the clinical permission here would gate a metrics-only question
 * behind an authorisation it does not need.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import {
  errorResponse,
  guard,
  internalErrorResponse,
  isGuardFailure,
  parseJson,
} from '@/lib/platform/context';
import { ask } from '@/lib/platform/ask';

export const dynamic = 'force-dynamic';

/** A question, not an essay. Long enough for the hardest one §4.13 gives. */
const askSchema = z.object({ question: z.string().min(3).max(600) });

export async function POST(request: NextRequest): Promise<NextResponse> {
  const guarded = await guard(request, 'observation:read');
  if (isGuardFailure(guarded)) return guarded.response;
  const { traceId, platform } = guarded.context;

  const parsed = await parseJson(request, askSchema, traceId);
  if ('response' in parsed) return parsed.response;

  try {
    const result = await ask(platform.db, { question: parsed.data.question, zone: platform.zone });
    if (!result.ok) return errorResponse(result.error, traceId);

    return NextResponse.json(result.value);
  } catch (error: unknown) {
    platform.observability.logger.error('unhandled error in ask.post', {
      traceId,
      component: 'ask.post',
      /* The question is never logged. §5.11's rule is names and numbers only,
       * and a question is the most content-bearing string in the system. */
      identifiers: { name: error instanceof Error ? error.name : 'unknown' },
    });
    return internalErrorResponse(traceId);
  }
}
