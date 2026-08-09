/**
 * `/api/mind/journal` — write an entry, or list the headings.
 *
 * ## The response to a POST does not contain the entry
 *
 * §4.7 calls journal content the most sensitive data in the system. The client
 * already holds the text it just sent, so echoing it back buys nothing and puts
 * it into one more place — a response log, a service-worker cache, an error
 * report attached to a failed request. The id and the word count are what the
 * screen needs.
 *
 * ## GET returns headings, never prose
 *
 * `journalList` selects the columns a list needs and computes the word count in
 * SQL specifically so `content` never enters the result set. See the note on
 * `mind.repository.ts`.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { journalEntrySchema } from '@naitikos/api';

import {
  errorResponse,
  guard,
  internalErrorResponse,
  isGuardFailure,
  parseJson,
  withoutUndefined,
} from '@/lib/platform/context';
import { withIdempotency } from '@/lib/platform/idempotent';
import { writeJournal } from '@/lib/platform/mind';
import { createMindRepository } from '@naitikos/db';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const guarded = await guard(request, 'observation:read');
  if (isGuardFailure(guarded)) return guarded.response;
  const { traceId, platform } = guarded.context;

  try {
    const mind = createMindRepository(platform.db);
    const [entries, prompts] = await Promise.all([mind.journalList(60), mind.prompts()]);
    if (!entries.ok) return errorResponse(entries.error, traceId);
    if (!prompts.ok) return errorResponse(prompts.error, traceId);

    return NextResponse.json({ entries: entries.value, prompts: prompts.value });
  } catch (error: unknown) {
    platform.observability.logger.error('unhandled error in mind.journal.get', {
      traceId,
      component: 'mind.journal.get',
      identifiers: { name: error instanceof Error ? error.name : 'unknown' },
    });
    return internalErrorResponse(traceId);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const guarded = await guard(request, 'observation:write');
  if (isGuardFailure(guarded)) return guarded.response;
  const { traceId, platform } = guarded.context;

  const parsed = await parseJson(request, journalEntrySchema, traceId);
  if ('response' in parsed) return parsed.response;

  try {
    return await withIdempotency(
      platform.db,
      parsed.data.idempotencyKey,
      'POST /api/mind/journal',
      /*
       * The fingerprint is the id and the length, not the payload.
       *
       * `withIdempotency` hashes what it is given, and hashing the prose would
       * put a digest of the operator's journal into `idempotency_key`, where it
       * outlives the request by the TTL. A digest is not the text, but it is
       * derived from it and it is stored somewhere the text is not.
       */
      { id: parsed.data.id, length: parsed.data.content.length },
      traceId,
      async () => {
        const result = await writeJournal(
          platform.db,
          withoutUndefined({
            id: parsed.data.id,
            writtenAt: parsed.data.writtenAt,
            zone: parsed.data.zone,
            title: parsed.data.title,
            content: parsed.data.content,
            promptId: parsed.data.promptId,
            moodAtWriting: parsed.data.moodAtWriting,
            aiConsent: parsed.data.aiConsent,
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
    platform.observability.logger.error('unhandled error in mind.journal.post', {
      traceId,
      component: 'mind.journal.post',
      identifiers: { name: error instanceof Error ? error.name : 'unknown' },
    });
    return internalErrorResponse(traceId);
  }
}
