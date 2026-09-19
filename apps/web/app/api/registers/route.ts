/**
 * `/api/registers` — routine definition, medication registration, crisis plan.
 *
 * One route for three registers, discriminated on `kind`. That is unusual in
 * this codebase and it is deliberate: these are the *authoring* halves of three
 * features whose reading halves already have their own routes, they are used
 * once or twice a year each, and three near-identical thirty-line handlers
 * would be three places for the guard chain to drift.
 *
 * §2.1's definition of done is what they exist for:
 *
 *   "thirty consecutive days of real use ... and **no manual database
 *    intervention required**."
 *
 * Until week 4, defining an evening routine or putting Venlafaxine in the
 * register meant running SQL — and until that happens, routine and medication
 * adherence never fire, which means the MVP's only insight family produces
 * nothing for the whole validation window.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { uuidV7 } from '@naitikos/shared';
import {
  crisisPlanRequestSchema,
  defineRoutineRequestSchema,
  registerMedicationRequestSchema,
} from '@naitikos/api';
import { isoFromMillis, systemClock } from '@naitikos/core';
import { defineRoutine, registerMedication, writeCrisisPlan } from '@naitikos/db';

import {
  errorResponse,
  guard,
  internalErrorResponse,
  isGuardFailure,
  parseJson,
} from '@/lib/platform/context';

export const dynamic = 'force-dynamic';

const requestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('routine'), routine: defineRoutineRequestSchema }),
  z.object({ kind: z.literal('medication'), medication: registerMedicationRequestSchema }),
  z.object({ kind: z.literal('crisis_plan'), plan: crisisPlanRequestSchema }),
]);

export async function POST(request: NextRequest): Promise<NextResponse> {
  /*
   * `settings:write`, not `observation:write`.
   *
   * These change the *shape* of the record rather than adding to it — a routine
   * definition changes every future adherence denominator. §5.4's permission
   * split is about blast radius, and this is the wider one.
   */
  const guarded = await guard(request, 'settings:write');
  if (isGuardFailure(guarded)) return guarded.response;
  const { traceId, platform } = guarded.context;

  const parsed = await parseJson(request, requestSchema, traceId);
  if ('response' in parsed) return parsed.response;

  try {
    if (parsed.data.kind === 'routine') {
      const input = parsed.data.routine;
      const result = await defineRoutine(platform.db, {
        id: input.id,
        kind: input.kind,
        period: input.period,
        name: input.name,
        isActive: input.isActive ?? true,
        expectedAt: input.expectedAt ?? null,
        steps: input.steps.map((step) => ({
          id: step.id,
          label: step.label,
          orderIndex: step.orderIndex,
          isOptional: step.isOptional ?? false,
          instructions: step.instructions ?? null,
        })),
      });
      if (!result.ok) return errorResponse(result.error, traceId);
      return NextResponse.json({ routine: result.value }, { status: 201 });
    }

    if (parsed.data.kind === 'medication') {
      const input = parsed.data.medication;
      const result = await registerMedication(platform.db, {
        id: input.id,
        // The bitemporal event the medication row requires (§9.5). Minted here
        // rather than by the client: it is an implementation detail of the
        // register, not a thing the phone has an offline identity for.
        medicalEventId: uuidV7(systemClock.nowMillis()),
        scheduleId: input.schedule.id,
        substance: input.substance,
        brandName: input.brandName ?? null,
        form: input.form,
        strength: input.strength ?? null,
        strengthUnit: input.strengthUnit ?? null,
        indication: input.indication ?? null,
        prescriber: input.prescriber ?? null,
        startedAt: input.startedAt,
        isPsychiatric: input.isPsychiatric ?? false,
        zone: input.zone,
        dose: input.schedule.dose,
        doseUnit: input.schedule.doseUnit,
        frequency: input.schedule.frequency,
        times: input.schedule.times ?? [],
      });
      if (!result.ok) return errorResponse(result.error, traceId);
      return NextResponse.json({ medication: result.value }, { status: 201 });
    }

    const input = parsed.data.plan;
    const result = await writeCrisisPlan(platform.db, {
      id: input.id,
      warningSigns: input.warningSigns ?? null,
      copingStrategies: input.copingStrategies ?? null,
      reasonsToLive: input.reasonsToLive ?? null,
      /*
       * Forwarded only when the client actually sent them.
       *
       * `?? []` was here, and it is how an edit to the warning signs deleted
       * the operator's emergency contacts: the authoring screen has no editor
       * for `professionalContacts`, so it never sends the field, and an empty
       * array reaching the upsert is indistinguishable from a deliberate
       * clear. The contract marks both arrays optional precisely so that
       * absence can mean "unchanged" — this is where that has to be honoured.
       */
      ...(input.contacts === undefined
        ? {}
        : { contacts: input.contacts.map(normaliseContact) }),
      ...(input.professionalContacts === undefined
        ? {}
        : { professionalContacts: input.professionalContacts.map(normaliseContact) }),
      reviewedAt: isoFromMillis(systemClock.nowMillis()),
    });
    if (!result.ok) return errorResponse(result.error, traceId);
    /*
     * The plan is echoed back. Unlike a journal entry, it is content the
     * operator wrote *in order to be shown it later* — withholding it here
     * would mean the screen that just saved it could not render what it saved.
     */
    return NextResponse.json({ plan: result.value }, { status: 201 });
  } catch (error: unknown) {
    platform.observability.logger.error('unhandled error in registers.post', {
      traceId,
      component: 'registers.post',
      identifiers: { name: error instanceof Error ? error.name : 'unknown' },
    });
    return internalErrorResponse(traceId);
  }
}

function normaliseContact(contact: {
  readonly name: string;
  readonly relationship?: string | null | undefined;
  readonly phone?: string | null | undefined;
  readonly notes?: string | null | undefined;
}) {
  return {
    name: contact.name,
    relationship: contact.relationship ?? null,
    phone: contact.phone ?? null,
    notes: contact.notes ?? null,
  };
}
