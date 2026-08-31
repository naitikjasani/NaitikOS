/**
 * `/api/learning` — every Learning, focus and calendar write.
 *
 * ## One permission, and it is `observation:write`
 *
 * Nothing here changes how a future observation is read. A learning item is a
 * queue entry, a focus session is a record of an afternoon, an imported meeting
 * is somebody else's decision about the operator's time; none of them is a
 * definition the way a food's macros or a nutrition target is. §5.4 splits
 * permissions by blast radius and this pillar sits entirely on the narrow side.
 *
 * ## The import reports what it did not import
 *
 * §4.8's import is read-only and this parser does not expand recurrence, so a
 * calendar can arrive with events this system will not represent. Both numbers
 * come back to the caller rather than being swallowed, because an import that
 * silently drops a third of a calendar produces a load series that is wrong in
 * a way nobody can see.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { learningWriteSchema } from '@naitikos/api';
import {
  dayKeyInZone,
  isoFromMillis,
  looksLikeTravel,
  parseIcs,
  systemClock,
  validateFocusSession,
  validateLearningItem,
} from '@naitikos/core';
import { createLearningRepository, type ImportEventInput } from '@naitikos/db';
import { uuidV7 } from '@naitikos/shared';

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

  const parsed = await parseJson(request, learningWriteSchema, traceId);
  if ('response' in parsed) return parsed.response;

  const learning = createLearningRepository(platform.db);
  const nowIso = isoFromMillis(systemClock.nowMillis());

  try {
    switch (parsed.data.kind) {
      case 'learning_item': {
        const input = parsed.data.item;
        /*
         * Validated in `core` as well as at the wire. The schema rejects a
         * shape; `validateLearningItem` rejects an item — a whitespace title, a
         * total that is not a count. §5.0 puts that judgement below transport.
         */
        const validated = validateLearningItem({
          id: input.id,
          kind: input.kind,
          title: input.title,
          author: input.author ?? null,
          url: input.url ?? null,
          totalUnits: input.totalUnits ?? null,
          unitLabel: input.unitLabel ?? null,
          skills: input.skills ?? [],
        });
        if (!validated.ok) return errorResponse(validated.error, traceId);

        const created = await learning.createItem(validated.value);
        if (!created.ok) return errorResponse(created.error, traceId);
        return NextResponse.json({ item: created.value }, { status: 201 });
      }

      case 'learning_progress': {
        const input = parsed.data.progress;
        const updated = await learning.setProgress({
          id: input.id,
          status: input.status,
          completedUnits: input.completedUnits ?? null,
          synthesis: input.synthesis ?? null,
          abandonedReason: input.abandonedReason ?? null,
          /* The repository dates `startedAt` and `finishedAt` from this one
           * instant, so the server owns both. */
          at: nowIso,
        });
        if (!updated.ok) return errorResponse(updated.error, traceId);
        return NextResponse.json({ item: updated.value });
      }

      case 'learning_note': {
        const input = parsed.data.note;
        const added = await learning.addNote({
          id: input.id,
          learningItemId: input.learningItemId,
          content: input.content,
        });
        if (!added.ok) return errorResponse(added.error, traceId);
        return NextResponse.json({ note: added.value }, { status: 201 });
      }

      case 'focus_start': {
        const input = parsed.data.session;
        const validated = validateFocusSession({
          id: input.id,
          startedAt: input.startedAt,
          endedAt: null,
          zone: input.zone,
          /*
           * Derived here, and the contract has no field for it. A client that
           * could send the instant and the day key separately could send them
           * disagreeing, and a session pointing at two different days is
           * invisible to exactly the per-day joins §4.8 exists for. Same rule
           * `/api/work` applies to a task's completion.
           */
          dayKey: dayKeyInZone(input.startedAt, input.zone),
          projectId: input.projectId ?? null,
          taskId: input.taskId ?? null,
          label: input.label ?? null,
          quality: null,
          interruptions: null,
          note: null,
        });
        if (!validated.ok) return errorResponse(validated.error, traceId);

        const recorded = await learning.recordSession(validated.value);
        if (!recorded.ok) return errorResponse(recorded.error, traceId);
        return NextResponse.json({ session: recorded.value }, { status: 201 });
      }

      case 'focus_end': {
        const input = parsed.data.end;
        const ended = await learning.endSession(
          input.id,
          nowIso,
          input.quality ?? null,
          input.interruptions ?? null,
        );
        if (!ended.ok) return errorResponse(ended.error, traceId);
        return NextResponse.json({ session: ended.value });
      }

      case 'calendar_import': {
        const input = parsed.data.import;
        const calendar = parseIcs(input.content);

        const rows: readonly ImportEventInput[] = calendar.events.map((event) => ({
          id: uuidV7(systemClock.nowMillis()),
          source: 'ics',
          externalId: event.externalId,
          calendarName: calendar.calendarName,
          title: event.title,
          location: event.location,
          startsAt: event.startsAt,
          endsAt: event.endsAt,
          zone: input.zone,
          isAllDay: event.isAllDay,
          isAccepted: event.isAccepted,
          attendeeCount: event.attendeeCount,
          /* A guess, written once and never overwritten by a later re-import,
           * because the operator is allowed to correct it (P5). */
          isTravel: looksLikeTravel(event.title, event.location),
        }));

        const imported = await learning.importEvents(rows, nowIso);
        if (!imported.ok) return errorResponse(imported.error, traceId);

        /*
         * The skipped list and the recurrence count are returned rather than
         * swallowed, because an import that silently drops a third of a
         * calendar produces a load series that is wrong in a way nobody can
         * see.
         */
        return NextResponse.json({
          imported: imported.value,
          skipped: calendar.skipped,
          unexpandedRecurrence: calendar.events.filter((event) => event.hasUnexpandedRecurrence).length,
        });
      }

      default: {
        const input = parsed.data.travel;
        const updated = await learning.setTravel(input.id, input.isTravel, nowIso);
        if (!updated.ok) return errorResponse(updated.error, traceId);
        return NextResponse.json({ event: updated.value });
      }
    }
  } catch (error: unknown) {
    platform.observability.logger.error('unhandled error in learning.post', {
      traceId,
      component: 'learning.post',
      identifiers: { name: error instanceof Error ? error.name : 'unknown' },
    });
    return internalErrorResponse(traceId);
  }
}
