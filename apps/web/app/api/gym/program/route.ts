/**
 * `/api/gym/program` — the active program and how the fortnight is going.
 *
 * §12 lists "program definition and adherence". Adherence shipped in Week 3;
 * definition shipped later, deliberately — authoring a program is a form-heavy
 * surface and §12's exit criterion was about the logger being usable under
 * fatigue, so the read came first and the operator inserted a program directly
 * in the meantime.
 *
 * GET answers the question that matters day to day: am I training as often as I
 * said I would? POST is the definition path.
 *
 * `programAdherence` is uncapped upwards on purpose. A fortnight with ten
 * sessions against a target of six reports 1.67, not 1 — clamping would hide the
 * case worth noticing, which is training more than planned, the usual prelude to
 * the injury a deload was supposed to prevent.
 *
 * ## Activation is a kind, not a field
 *
 * `program_one_active` is a partial unique index, so making one program active
 * means standing another down — two rows, one transaction. A boolean on the
 * upsert would look like it expressed that and would instead produce a
 * constraint violation the first time two programs existed.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { programWriteSchema } from '@naitikos/api';
import {
  dayKeyInZone,
  isoFromMillis,
  nextBlock,
  programAdherence,
  shiftDayKey,
  systemClock,
  validateProgram,
  validateProgramBlock,
  zonedDayBounds,
} from '@naitikos/core';
import { createProgramRepository, createProgramWriter, createWorkoutRepository } from '@naitikos/db';

import {
  DEFAULT_PROFILE_ZONE,
  errorResponse,
  guard,
  internalErrorResponse,
  isGuardFailure,
  parseJson,
} from '@/lib/platform/context';

export const dynamic = 'force-dynamic';

/** Two weeks. Long enough for a frequency target to mean something. */
const WINDOW_DAYS = 14;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const guarded = await guard(request, 'observation:read');
  if (isGuardFailure(guarded)) return guarded.response;
  const { traceId, platform } = guarded.context;

  try {
    const programs = createProgramRepository(platform.db);
    const active = await programs.active();
    if (!active.ok) return errorResponse(active.error, traceId);

    // No program is a normal state, not an error. Most weeks of most people's
    // training are not run against a written plan.
    if (active.value === null) {
      return NextResponse.json({ program: null, adherence: null, nextBlock: null });
    }

    const zone = DEFAULT_PROFILE_ZONE;
    const toDayKey = dayKeyInZone(isoFromMillis(systemClock.nowMillis()), zone);
    const fromDayKey = shiftDayKey(toDayKey, -(WINDOW_DAYS - 1)) ?? toDayKey;

    const start = zonedDayBounds(fromDayKey, zone);
    const end = zonedDayBounds(toDayKey, zone);
    if (start === null || end === null) return internalErrorResponse(traceId);

    const days = await createWorkoutRepository(platform.db).sessionDays(start.start, end.end);
    if (!days.ok) return errorResponse(days.error, traceId);

    const blocks = await programs.blocksFor(active.value.id);
    if (!blocks.ok) return errorResponse(blocks.error, traceId);

    const lastBlock = await programs.lastPerformedBlockId(active.value.id);
    if (!lastBlock.ok) return errorResponse(lastBlock.error, traceId);

    return NextResponse.json({
      program: active.value,
      adherence: programAdherence(active.value, days.value, { fromDayKey, toDayKey }),
      nextBlock: nextBlock(blocks.value, lastBlock.value),
    });
  } catch (error: unknown) {
    platform.observability.logger.error('unhandled error in gym.program.get', {
      traceId,
      component: 'gym.program.get',
      identifiers: { name: error instanceof Error ? error.name : 'unknown' },
    });
    return internalErrorResponse(traceId);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const guarded = await guard(request, 'observation:write');
  if (isGuardFailure(guarded)) return guarded.response;
  const { traceId, platform } = guarded.context;

  const parsed = await parseJson(request, programWriteSchema, traceId);
  if ('response' in parsed) return parsed.response;

  const writer = createProgramWriter(platform.db);
  const nowIso = isoFromMillis(systemClock.nowMillis());

  try {
    switch (parsed.data.kind) {
      case 'program': {
        const input = parsed.data.program;
        /*
         * Validated in `core` as well as at the wire. The schema rejects a
         * shape; `validateProgram` rejects a program — an end before a start, a
         * finished plan claiming to be the active one. §5.0 puts that judgement
         * below transport.
         */
        const validated = validateProgram({
          id: input.id,
          name: input.name,
          description: input.description ?? null,
          startedAt: input.startedAt ?? null,
          endedAt: input.endedAt ?? null,
          targetFrequency: input.targetFrequency ?? null,
        });
        if (!validated.ok) return errorResponse(validated.error, traceId);

        const saved = await writer.saveProgram(validated.value);
        if (!saved.ok) return errorResponse(saved.error, traceId);
        return NextResponse.json({ program: saved.value }, { status: 201 });
      }

      case 'program_activate': {
        const activated = await writer.activate(parsed.data.id, nowIso);
        if (!activated.ok) return errorResponse(activated.error, traceId);
        return NextResponse.json({ program: activated.value });
      }

      case 'program_retire': {
        const retired = await writer.retire(parsed.data.id, parsed.data.endedAt);
        if (!retired.ok) return errorResponse(retired.error, traceId);
        return NextResponse.json({ program: retired.value });
      }

      case 'program_delete': {
        const removed = await writer.deleteProgram(
          parsed.data.delete.id,
          parsed.data.delete.reason ?? null,
          nowIso,
        );
        if (!removed.ok) return errorResponse(removed.error, traceId);
        return NextResponse.json({ deleted: parsed.data.delete.id });
      }

      case 'block': {
        const input = parsed.data.block;
        const validated = validateProgramBlock({
          id: input.id,
          programId: input.programId,
          name: input.name,
          orderIndex: input.orderIndex,
          prescription: (input.prescription ?? []).map((entry) => ({
            exerciseId: entry.exerciseId,
            sets: entry.sets ?? null,
            repRange: entry.repRange ?? null,
            targetRpe: entry.targetRpe ?? null,
            notes: entry.notes ?? null,
          })),
          notes: input.notes ?? null,
        });
        if (!validated.ok) return errorResponse(validated.error, traceId);

        const saved = await writer.saveBlock(validated.value);
        if (!saved.ok) return errorResponse(saved.error, traceId);
        return NextResponse.json({ block: saved.value }, { status: 201 });
      }

      default: {
        const removed = await writer.deleteBlock(
          parsed.data.delete.id,
          parsed.data.delete.reason ?? null,
          nowIso,
        );
        if (!removed.ok) return errorResponse(removed.error, traceId);
        return NextResponse.json({ deleted: parsed.data.delete.id });
      }
    }
  } catch (error: unknown) {
    platform.observability.logger.error('unhandled error in gym.program.post', {
      traceId,
      component: 'gym.program.post',
      identifiers: { name: error instanceof Error ? error.name : 'unknown' },
    });
    return internalErrorResponse(traceId);
  }
}
