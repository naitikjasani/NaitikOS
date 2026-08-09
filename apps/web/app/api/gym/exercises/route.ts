/**
 * `/api/gym/exercises` — the library, and the fuzzy search over it.
 *
 * The client loads the whole library once and ranks locally
 * (`core`'s `searchExercises`), because §4.1's picker has to work in a basement
 * with no signal. This endpoint exists for the first load and for the library
 * screen, where the Postgres trigram index (§9.6) does the ranking instead.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { exerciseSearchSchema } from '@naitikos/api';
import { createExerciseRepository } from '@naitikos/db';

import {
  errorResponse,
  guard,
  internalErrorResponse,
  isGuardFailure,
  parseQuery,
} from '@/lib/platform/context';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const guarded = await guard(request, 'observation:read');
  if (isGuardFailure(guarded)) return guarded.response;
  const { traceId, platform } = guarded.context;

  const parsed = parseQuery(request, exerciseSearchSchema, traceId);
  if ('response' in parsed) return parsed.response;

  try {
    const exercises = createExerciseRepository(platform.db);
    const term = parsed.data.q ?? '';

    /*
     * An empty term returns the whole library rather than nothing.
     *
     * The picker opens before anything is typed, and the operator's next
     * movement is usually one of the four they did last week — so the useful
     * default is "everything, ranked by name", not an empty box waiting for
     * input from someone who is out of breath.
     */
    const result = term === '' ? await exercises.all() : await exercises.search(term, parsed.data.limit);
    if (!result.ok) return errorResponse(result.error, traceId);

    return NextResponse.json({ exercises: result.value });
  } catch (error: unknown) {
    platform.observability.logger.error('unhandled error in gym.exercises.get', {
      traceId,
      component: 'gym.exercises.get',
      identifiers: { name: error instanceof Error ? error.name : 'unknown' },
    });
    return internalErrorResponse(traceId);
  }
}
