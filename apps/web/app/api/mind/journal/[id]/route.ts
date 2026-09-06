/**
 * `/api/mind/journal/:id` — one entry, with its prose.
 *
 * The only endpoint in the system that returns journal content, which is why it
 * is its own route rather than a query parameter on the list. A single URL that
 * sometimes returns prose is a URL whose caching, logging and error-report
 * behaviour has to be reasoned about case by case; a separate one can be
 * excluded from the service-worker cache by path.
 *
 * ## `journal:read`, and the reason it is not `observation:read`
 *
 * `journal:read` exists for exactly one purpose, stated in `core/auth/roles.ts`:
 * a **clinician holding a shared export is deliberately not granted it**,
 * because §4.7's "therapist-shared export with granular consent" is about
 * therapy notes the operator chose to share, not standing access to a diary.
 *
 * This route guarded on `observation:read` — which a clinician *does* hold — so
 * the one permission designed to keep the diary out of a clinician's reach was
 * not checked on the diary's own endpoint. The list is safe by construction
 * (`journalList` does not select `content`); this is the endpoint that returns
 * the prose, and it was the gap.
 */

import { NextResponse, type NextRequest } from 'next/server';

import {
  errorResponse,
  guard,
  internalErrorResponse,
  isGuardFailure,
} from '@/lib/platform/context';
import { createMindRepository } from '@naitikos/db';
import { notFoundError } from '@naitikos/core';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  context: { readonly params: Promise<{ readonly id: string }> },
): Promise<NextResponse> {
  const guarded = await guard(request, 'journal:read');
  if (isGuardFailure(guarded)) return guarded.response;
  const { traceId, platform } = guarded.context;

  const { id } = await context.params;

  try {
    const entry = await createMindRepository(platform.db).journalEntryById(id);
    if (!entry.ok) return errorResponse(entry.error, traceId);
    if (entry.value === null) return errorResponse(notFoundError('journal_entry', id), traceId);

    const response = NextResponse.json({ entry: entry.value });
    /*
     * Never stored, anywhere, by anything. Belt and braces over the service
     * worker's own path exclusion — a cached journal entry is a copy of the
     * most sensitive data in the system sitting in a browser cache directory.
     */
    response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    return response;
  } catch (error: unknown) {
    platform.observability.logger.error('unhandled error in mind.journal.entry.get', {
      traceId,
      component: 'mind.journal.entry.get',
      identifiers: { name: error instanceof Error ? error.name : 'unknown' },
    });
    return internalErrorResponse(traceId);
  }
}
