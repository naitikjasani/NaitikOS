/**
 * `/api/enquiry` — creating, renaming and removing saved lines of enquiry.
 *
 * ## There is no way to write a turn here
 *
 * Turns come into existence exactly one way: by asking, through `/api/ask` with
 * a `threadId`. A client able to POST an answer could POST one containing a
 * number, and every structural control in `schemas/references.ts` would be
 * bypassed by a request. §10.10's guarantee holds only if the answer and the
 * row that stores it are produced by the same server-side call.
 *
 * Deleting a turn *is* here, because removing a record of something that
 * happened is the operator's call and nothing about it can be forged.
 *
 * ## `observation:read` for the write path, and it is not a mistake
 *
 * A thread is a question the operator wants to keep. It writes no observation,
 * changes no definition, and alters nothing any other surface reads. §5.4
 * splits permissions by blast radius; this one is narrower than every other
 * write in the system, and giving it `observation:write` would overstate what
 * it can do.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { enquiryWriteSchema } from '@naitikos/api';
import { isoFromMillis, systemClock } from '@naitikos/core';
import { createEnquiryRepository } from '@naitikos/db';

import {
  errorResponse,
  guard,
  internalErrorResponse,
  isGuardFailure,
  parseJson,
} from '@/lib/platform/context';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const guarded = await guard(request, 'observation:read');
  if (isGuardFailure(guarded)) return guarded.response;
  const { traceId, platform } = guarded.context;

  const parsed = await parseJson(request, enquiryWriteSchema, traceId);
  if ('response' in parsed) return parsed.response;

  const enquiry = createEnquiryRepository(platform.db);
  const nowIso = isoFromMillis(systemClock.nowMillis());

  try {
    switch (parsed.data.kind) {
      case 'thread': {
        const input = parsed.data.thread;
        const saved = await enquiry.saveThread({
          id: input.id,
          title: input.title.trim(),
          note: input.note?.trim() === '' ? null : (input.note ?? null),
        });
        if (!saved.ok) return errorResponse(saved.error, traceId);
        return NextResponse.json({ thread: saved.value }, { status: 201 });
      }

      case 'thread_delete': {
        const removed = await enquiry.deleteThread(
          parsed.data.delete.id,
          parsed.data.delete.reason ?? null,
          nowIso,
        );
        if (!removed.ok) return errorResponse(removed.error, traceId);
        return NextResponse.json({ deleted: parsed.data.delete.id });
      }

      default: {
        const removed = await enquiry.deleteTurn(
          parsed.data.delete.id,
          parsed.data.delete.reason ?? null,
          nowIso,
        );
        if (!removed.ok) return errorResponse(removed.error, traceId);
        return NextResponse.json({ deleted: parsed.data.delete.id });
      }
    }
  } catch (error: unknown) {
    platform.observability.logger.error('unhandled error in enquiry.post', {
      traceId,
      component: 'enquiry.post',
      /* The title is never logged. §5.11 is names and numbers only, and a
       * thread title is as content-bearing as the question that made it. */
      identifiers: { name: error instanceof Error ? error.name : 'unknown' },
    });
    return internalErrorResponse(traceId);
  }
}
