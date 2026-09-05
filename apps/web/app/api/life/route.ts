/**
 * `/api/life` — every Life Timeline write (§10.8).
 *
 * ## One permission, and it is `observation:write`
 *
 * A chapter is a label on a stretch of time. It changes no interpretation of
 * any observation, sets no target and unlocks no clinical field, so by §5.4's
 * blast-radius split it sits on the narrow side alongside Work. The pillar with
 * the largest emotional weight has the smallest permission, which is the right
 * way round: the risk §5.4 measures is what a bad write *does*, not how much it
 * matters to read.
 *
 * ## Nothing here is inferred, including the dates
 *
 * The server supplies exactly one thing the client does not: `now`, for the
 * `updated_at` and `deleted_at` stamps. Every date that describes the *record* —
 * when a chapter began, when an era closed, when an event happened — arrives
 * from the operator, because §10.0 forbids the system deciding any of them and
 * a helpful default is a decision.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { lifeWriteSchema } from '@naitikos/api';
import { isoFromMillis, systemClock, validateEvent, validateSpan } from '@naitikos/core';
import { createLifeRepository } from '@naitikos/db';

import {
  errorResponse,
  guard,
  internalErrorResponse,
  isGuardFailure,
  parseJson,
} from '@/lib/platform/context';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const guarded = await guard(request, 'observation:write');
  if (isGuardFailure(guarded)) return guarded.response;
  const { traceId, platform } = guarded.context;

  const parsed = await parseJson(request, lifeWriteSchema, traceId);
  if ('response' in parsed) return parsed.response;

  const life = createLifeRepository(platform.db);
  const nowIso = isoFromMillis(systemClock.nowMillis());

  try {
    switch (parsed.data.kind) {
      case 'span': {
        const input = parsed.data.span;
        /*
         * Validated in `core` as well as at the wire. The schema rejects a
         * shape; `validateSpan` rejects a span — an end before a start on two
         * different offsets, a nested era. §5.0 puts that judgement below the
         * transport.
         */
        const validated = validateSpan({
          id: input.id,
          kind: input.kind,
          title: input.title,
          description: input.description ?? null,
          startedAt: input.startedAt,
          endedAt: input.endedAt ?? null,
          parentId: input.parentId ?? null,
          slot: input.slot ?? null,
        });
        if (!validated.ok) return errorResponse(validated.error, traceId);

        const saved = await life.saveSpan(validated.value);
        if (!saved.ok) return errorResponse(saved.error, traceId);
        return NextResponse.json({ span: saved.value }, { status: 201 });
      }

      case 'span_close': {
        const input = parsed.data.close;
        const closed = await life.closeSpan(input.id, input.endedAt, nowIso);
        if (!closed.ok) return errorResponse(closed.error, traceId);
        return NextResponse.json({ span: closed.value });
      }

      case 'event': {
        const input = parsed.data.event;
        const validated = validateEvent({
          id: input.id,
          title: input.title,
          description: input.description ?? null,
          occurredAt: input.occurredAt,
          spanId: input.spanId ?? null,
          significance: input.significance ?? null,
        });
        if (!validated.ok) return errorResponse(validated.error, traceId);

        const saved = await life.saveEvent(validated.value);
        if (!saved.ok) return errorResponse(saved.error, traceId);
        return NextResponse.json({ event: saved.value }, { status: 201 });
      }

      case 'span_delete': {
        const input = parsed.data.span;
        const removed = await life.removeSpan(input.id, nowIso, input.reason);
        if (!removed.ok) return errorResponse(removed.error, traceId);
        return NextResponse.json({ span: removed.value });
      }

      default: {
        const input = parsed.data.event;
        const removed = await life.removeEvent(input.id, nowIso, input.reason);
        if (!removed.ok) return errorResponse(removed.error, traceId);
        return NextResponse.json({ event: removed.value });
      }
    }
  } catch (error: unknown) {
    platform.observability.logger.error('unhandled error in life.post', {
      traceId,
      component: 'life.post',
      identifiers: { name: error instanceof Error ? error.name : 'unknown' },
    });
    return internalErrorResponse(traceId);
  }
}
