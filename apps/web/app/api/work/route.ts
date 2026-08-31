/**
 * `/api/work` — every Work write.
 *
 * ## One permission, and it is `observation:write`
 *
 * Unlike `/api/nutrition`, nothing here changes the shape of the record. A
 * project is a container, a task is an intention, a career entry is a line in a
 * log; none of them determines how a future observation is interpreted the way
 * a food's macros or a nutrition target does. §5.4 splits permissions by blast
 * radius, and this pillar's whole surface sits on the narrow side.
 *
 * ## The server owns the completion pair
 *
 * The contract has no `completedDayKey` field. The client sends the zone and
 * the server derives both halves from one instant, because a client that could
 * supply them separately could supply them inconsistently — and a task closed
 * on an instant in one day and a day key in another is invisible to exactly the
 * cross-domain joins §4.8 exists for.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { workWriteSchema } from '@naitikos/api';
import {
  dayKeyInZone,
  isoFromMillis,
  systemClock,
  validateCareerEntry,
  validateProject,
  validateTask,
} from '@naitikos/core';
import { createWorkRepository } from '@naitikos/db';

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

  const parsed = await parseJson(request, workWriteSchema, traceId);
  if ('response' in parsed) return parsed.response;

  const work = createWorkRepository(platform.db);
  const nowIso = isoFromMillis(systemClock.nowMillis());

  try {
    switch (parsed.data.kind) {
      case 'project': {
        const input = parsed.data.project;
        /*
         * Validated in `core` as well as at the wire. The schema rejects a
         * shape; `validateProject` rejects a project — an end before a start.
         * §5.0 puts that judgement below the transport.
         */
        const validated = validateProject({
          id: input.id,
          name: input.name,
          description: input.description ?? null,
          startedAt: input.startedAt ?? null,
          endedAt: input.endedAt ?? null,
          context: input.context ?? null,
          goalId: input.goalId ?? null,
        });
        if (!validated.ok) return errorResponse(validated.error, traceId);

        const created = await work.createProject(validated.value);
        if (!created.ok) return errorResponse(created.error, traceId);
        return NextResponse.json({ project: created.value }, { status: 201 });
      }

      case 'project_status': {
        const input = parsed.data.status;
        const updated = await work.setProjectStatus(input.id, input.status, nowIso);
        if (!updated.ok) return errorResponse(updated.error, traceId);
        return NextResponse.json({ project: updated.value });
      }

      case 'task': {
        const input = parsed.data.task;
        const validated = validateTask({
          id: input.id,
          title: input.title,
          note: input.note ?? null,
          projectId: input.projectId ?? null,
          goalId: input.goalId ?? null,
          linkedEntityType: input.linkedEntityType ?? null,
          linkedEntityId: input.linkedEntityId ?? null,
          dueDayKey: input.dueDayKey ?? null,
        });
        if (!validated.ok) return errorResponse(validated.error, traceId);

        const created = await work.createTask(validated.value);
        if (!created.ok) return errorResponse(created.error, traceId);
        return NextResponse.json({ task: created.value }, { status: 201 });
      }

      case 'task_close': {
        const input = parsed.data.close;
        const closed = await work.closeTask({
          id: input.id,
          status: input.status,
          at: nowIso,
          /* Both halves from one instant. That is the point. */
          dayKey: dayKeyInZone(nowIso, input.zone),
          zone: input.zone,
          droppedReason: input.droppedReason ?? null,
        });
        if (!closed.ok) return errorResponse(closed.error, traceId);
        return NextResponse.json({ task: closed.value });
      }

      case 'task_reopen': {
        const reopened = await work.reopenTask(parsed.data.reopen.id, nowIso);
        if (!reopened.ok) return errorResponse(reopened.error, traceId);
        return NextResponse.json({ task: reopened.value });
      }

      default: {
        const input = parsed.data.entry;
        const validated = validateCareerEntry({
          id: input.id,
          kind: input.kind,
          title: input.title,
          detail: input.detail ?? null,
          occurredAt: input.occurredAt,
          projectId: input.projectId ?? null,
          attributedTo: input.attributedTo ?? null,
          artifactUrl: input.artifactUrl ?? null,
          isVisibleToLeadership: input.isVisibleToLeadership ?? null,
          skills: input.skills ?? [],
        });
        if (!validated.ok) return errorResponse(validated.error, traceId);

        const recorded = await work.recordCareerEntry(validated.value, input.zone);
        if (!recorded.ok) return errorResponse(recorded.error, traceId);
        return NextResponse.json({ entry: recorded.value }, { status: 201 });
      }
    }
  } catch (error: unknown) {
    platform.observability.logger.error('unhandled error in work.post', {
      traceId,
      component: 'work.post',
      identifiers: { name: error instanceof Error ? error.name : 'unknown' },
    });
    return internalErrorResponse(traceId);
  }
}
