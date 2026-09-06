/**
 * `/api/social` — every People and Places write.
 *
 * ## One permission, and it is `observation:write`
 *
 * Nothing here changes how any other record is interpreted. A person is a name,
 * a visit is a fortnight in London; neither is a definition the way a metric or
 * a nutrition target is. §5.4 splits permissions by blast radius and both
 * pillars sit on the narrow side.
 *
 * ## The handler derives the day key, and the contract has no field for it
 *
 * Same rule `/api/learning` applies to a focus session and `/api/work` to a
 * task's completion: a client that could send the instant and the day key
 * separately could send them disagreeing, and a contact pointing at two
 * different days is invisible to the per-day joins it exists to feed.
 *
 * ## Validation happens twice, and the two are not the same check
 *
 * Zod rejects a *shape*; `core` rejects a *fact*. `--02-30` satisfies the
 * pattern and is not a day; `Europe/Londen` is a string and is not a zone. §5.0
 * puts that second judgement below transport, which is also what keeps it
 * testable without a server.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { socialWriteSchema } from '@naitikos/api';
import {
  dayKeyInZone,
  isoFromMillis,
  systemClock,
  validateInteraction,
  validatePerson,
  validatePlace,
  validateTrip,
  validateVisit,
} from '@naitikos/core';
import { createSocialRepository } from '@naitikos/db';

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

  const parsed = await parseJson(request, socialWriteSchema, traceId);
  if ('response' in parsed) return parsed.response;

  const social = createSocialRepository(platform.db);
  const nowIso = isoFromMillis(systemClock.nowMillis());

  try {
    switch (parsed.data.kind) {
      case 'person': {
        const input = parsed.data.person;
        const validated = validatePerson({
          id: input.id,
          name: input.name,
          relationship: input.relationship,
          context: input.context ?? null,
          birthday: input.birthday ?? null,
          cadenceDays: input.cadenceDays ?? null,
        });
        if (!validated.ok) return errorResponse(validated.error, traceId);

        const saved = await social.savePerson(validated.value);
        if (!saved.ok) return errorResponse(saved.error, traceId);
        return NextResponse.json({ person: saved.value }, { status: 201 });
      }

      case 'person_delete': {
        const removed = await social.deletePerson(
          parsed.data.delete.id,
          parsed.data.delete.reason ?? null,
          nowIso,
        );
        if (!removed.ok) return errorResponse(removed.error, traceId);
        return NextResponse.json({ deleted: parsed.data.delete.id });
      }

      case 'interaction': {
        const input = parsed.data.interaction;
        const validated = validateInteraction({
          id: input.id,
          personId: input.personId,
          kind: input.kind,
          occurredAt: input.occurredAt,
          zone: input.zone,
          /* Derived here. See the header. */
          dayKey: dayKeyInZone(input.occurredAt, input.zone),
          note: input.note ?? null,
        });
        if (!validated.ok) return errorResponse(validated.error, traceId);

        const saved = await social.recordInteraction(validated.value);
        if (!saved.ok) return errorResponse(saved.error, traceId);
        return NextResponse.json({ interaction: saved.value }, { status: 201 });
      }

      case 'interaction_delete': {
        const removed = await social.deleteInteraction(
          parsed.data.delete.id,
          parsed.data.delete.reason ?? null,
          nowIso,
        );
        if (!removed.ok) return errorResponse(removed.error, traceId);
        return NextResponse.json({ deleted: parsed.data.delete.id });
      }

      case 'place': {
        const input = parsed.data.place;
        const validated = validatePlace({
          id: input.id,
          name: input.name,
          kind: input.kind,
          countryCode: input.countryCode ?? null,
          zone: input.zone ?? null,
          latitude: input.latitude ?? null,
          longitude: input.longitude ?? null,
          notes: input.notes ?? null,
        });
        if (!validated.ok) return errorResponse(validated.error, traceId);

        const saved = await social.savePlace(validated.value);
        if (!saved.ok) return errorResponse(saved.error, traceId);
        return NextResponse.json({ place: saved.value }, { status: 201 });
      }

      case 'place_delete': {
        const removed = await social.deletePlace(parsed.data.delete.id, parsed.data.delete.reason ?? null, nowIso);
        if (!removed.ok) return errorResponse(removed.error, traceId);
        return NextResponse.json({ deleted: parsed.data.delete.id });
      }

      case 'trip': {
        const input = parsed.data.trip;
        const validated = validateTrip({
          id: input.id,
          title: input.title,
          purpose: input.purpose,
          startedOn: input.startedOn,
          endedOn: input.endedOn ?? null,
          notes: input.notes ?? null,
        });
        if (!validated.ok) return errorResponse(validated.error, traceId);

        const saved = await social.saveTrip(validated.value);
        if (!saved.ok) return errorResponse(saved.error, traceId);
        return NextResponse.json({ trip: saved.value }, { status: 201 });
      }

      case 'trip_delete': {
        const removed = await social.deleteTrip(parsed.data.delete.id, parsed.data.delete.reason ?? null, nowIso);
        if (!removed.ok) return errorResponse(removed.error, traceId);
        return NextResponse.json({ deleted: parsed.data.delete.id });
      }

      case 'visit': {
        const input = parsed.data.visit;
        const validated = validateVisit({
          id: input.id,
          placeId: input.placeId,
          tripId: input.tripId ?? null,
          arrivedOn: input.arrivedOn,
          departedOn: input.departedOn ?? null,
          notes: input.notes ?? null,
        });
        if (!validated.ok) return errorResponse(validated.error, traceId);

        const saved = await social.saveVisit(validated.value);
        if (!saved.ok) return errorResponse(saved.error, traceId);
        return NextResponse.json({ visit: saved.value }, { status: 201 });
      }

      default: {
        const removed = await social.deleteVisit(parsed.data.delete.id, parsed.data.delete.reason ?? null, nowIso);
        if (!removed.ok) return errorResponse(removed.error, traceId);
        return NextResponse.json({ deleted: parsed.data.delete.id });
      }
    }
  } catch (error: unknown) {
    platform.observability.logger.error('unhandled error in social.post', {
      traceId,
      component: 'social.post',
      identifiers: { name: error instanceof Error ? error.name : 'unknown' },
    });
    return internalErrorResponse(traceId);
  }
}
