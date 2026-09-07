/**
 * POST /api/events
 *
 * The one write path into the event log.
 *
 * §5.4 forbids client-direct-to-database access, so every event enters here.
 * That is what makes the payload rule enforceable: `validateEventPayload` runs
 * once, inside `publish`, and there is no second door.
 *
 * ## What this handler does not do
 *
 * It does not write the domain row. ADR 0005 rule 2 requires the domain write and
 * the event append to be in the same transaction, which means a *domain service*
 * emits — this endpoint exists for the events that have no domain row of their
 * own (a Daily Close completion, a media upload notification) and for the offline
 * outbox draining events the client already committed locally.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { publishEventsSchema } from '@naitikos/api';
import type { CorrelationId, EventDraft, EventId } from '@naitikos/core';

import {
  errorResponse,
  guard,
  isGuardFailure,
  parseJson,
  traceIdFor,
  unhandledErrorResponse,
  withoutUndefined,
} from '../../../lib/platform/context';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const traceId = traceIdFor(request);

  try {
    const guarded = await guard(request, 'observation:write');
    if (isGuardFailure(guarded)) return guarded.response;
    const { platform, actor } = guarded.context;

    const parsed = await parseJson(request, publishEventsSchema, traceId);
    if ('response' in parsed) return parsed.response;

    const drafts: EventDraft[] = parsed.data.events.map((event) => ({
      eventType: event.eventType,
      occurredAt: event.occurredAt,
      source: event.source,
      subject: event.subject,
      // Shape-checked by Zod, contents checked against the registered spec by
      // `validateEventPayload` inside `publish`. See the contract for why the
      // payload rule is not duplicated here.
      payload: event.payload as EventDraft['payload'],
      // From the verified session, never from the body. A caller-supplied actor
      // would make the audit trail a claim rather than a record (§9.4).
      actorId: actor.subjectId,
      // Spread rather than assigned: under `exactOptionalPropertyTypes` an
      // explicitly-undefined key is a different type from an absent one, and the
      // bus distinguishes "no correlation id supplied" from "correlation id is
      // undefined" when it allocates the batch's shared one.
      ...(event.correlationId === undefined
        ? {}
        : { correlationId: event.correlationId as CorrelationId }),
      ...(event.causationId === undefined || event.causationId === null
        ? {}
        : { causationId: event.causationId as EventId }),
      metadata: { ...withoutUndefined(event.metadata ?? {}), traceId },
    }));

    const published = await platform.bus.publish(drafts);
    if (!published.ok) return errorResponse(published.error, traceId);

    for (const event of published.value.events) {
      platform.observability.metrics.increment('event.published', {
        eventType: event.eventType,
      });
    }

    if (published.value.failures.length > 0) {
      // The publish succeeded; a projection handler did not. §5.12: "Failure never
      // loses user input" — the events are committed and a replay repairs the
      // projection, so this is a 201 with a warning rather than an error.
      platform.observability.metrics.increment(
        'event.dead_lettered',
        { outcome: 'failure' },
        published.value.failures.length,
      );
    }

    return NextResponse.json(
      {
        events: published.value.events.map((event) => ({
          eventId: event.eventId,
          sequence: event.sequence,
          eventType: event.eventType,
          correlationId: event.correlationId,
          createdAt: event.createdAt,
        })),
        // Surfaced rather than hidden: a client that just wrote something and got
        // back a dead-lettered handler should be able to say so in
        // `/settings/developer` without polling.
        deadLettered: published.value.failures.map((failure) => ({
          eventId: failure.eventId,
          handlerName: failure.handlerName,
          errorCode: failure.error.code,
        })),
      },
      { status: 201, headers: { 'cache-control': 'private, no-store' } },
    );
  } catch (error: unknown) {
    /*
     * Logged before the generic 500. A throw here is ambiguous in a way the
     * caller cannot resolve on its own: `publish` may have appended to
     * `event_log` before failing, and the offline outbox will replay the batch
     * on its next drain. The trace id is what lets an operator decide whether a
     * duplicate needs looking at.
     */
    return unhandledErrorResponse('events.post', traceId, error);
  }
}
