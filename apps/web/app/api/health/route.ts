/**
 * `/api/health` — the Health core read, and every Health core write.
 *
 * One POST for eleven write shapes, discriminated on `kind`, for the reason
 * `/api/registers` gives: they share one guard chain, one trace and one error
 * map, and eleven near-identical handlers is eleven places for that chain to
 * drift over twenty years.
 *
 * ## Two permissions, not one
 *
 * A vital reading and a symptom are observations — `observation:write`. A
 * condition, a medication register entry and an appointment change the *shape*
 * of the clinical record, and they take `settings:write`. §5.4 splits
 * permissions by blast radius, and the difference here is real: a mistyped
 * blood pressure is one row, a refuted diagnosis rewrites what the register
 * says about a year.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { healthWriteSchema } from '@naitikos/api';
import { isoFromMillis, planSymptom, planVitalReading, systemClock } from '@naitikos/core';
import { createHealthRepository, createLabRepository, createMetricRepository } from '@naitikos/db';

import {
  errorResponse,
  guard,
  internalErrorResponse,
  isGuardFailure,
  parseJson,
} from '@/lib/platform/context';
import { healthWriteContext, loadHealthOverview } from '@/lib/platform/health';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const guarded = await guard(request, 'observation:read');
  if (isGuardFailure(guarded)) return guarded.response;
  const { traceId, platform } = guarded.context;

  try {
    const overview = await loadHealthOverview(platform.db);
    if (!overview.ok) return errorResponse(overview.error, traceId);
    return NextResponse.json(overview.value);
  } catch (error: unknown) {
    platform.observability.logger.error('unhandled error in health.get', {
      traceId,
      component: 'health.get',
      identifiers: { name: error instanceof Error ? error.name : 'unknown' },
    });
    return internalErrorResponse(traceId);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = await request.clone().json().catch(() => null);
  const kind = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['kind'] : null;
  const permission = REGISTER_KINDS.has(String(kind)) ? 'settings:write' : 'observation:write';

  const guarded = await guard(request, permission);
  if (isGuardFailure(guarded)) return guarded.response;
  const { traceId, platform } = guarded.context;

  const parsed = await parseJson(request, healthWriteSchema, traceId);
  if ('response' in parsed) return parsed.response;

  const health = createHealthRepository(platform.db);
  const nowIso = isoFromMillis(systemClock.nowMillis());

  try {
    switch (parsed.data.kind) {
      case 'vitals': {
        const input = parsed.data.reading;
        const planned = planVitalReading({
          id: input.id,
          observedAt: input.observedAt,
          observedZone: input.observedZone,
          systolic: input.systolic ?? null,
          diastolic: input.diastolic ?? null,
          restingHeartRate: input.restingHeartRate ?? null,
          temperatureCelsius: input.temperatureCelsius ?? null,
          oxygenSaturation: input.oxygenSaturation ?? null,
        });
        if (!planned.ok) return errorResponse(planned.error, traceId);

        const registry = await createMetricRepository(platform.db).registry();
        if (!registry.ok) return errorResponse(registry.error, traceId);

        const written = await health.recordVitals(
          [...planned.value],
          healthWriteContext(registry.value, {
            deviceId: input.deviceId,
            ...(input.clientHlc === undefined ? {} : { clientHlc: input.clientHlc }),
          }),
        );
        if (!written.ok) return errorResponse(written.error, traceId);
        return NextResponse.json({ written: written.value }, { status: 201 });
      }

      case 'condition': {
        const input = parsed.data.condition;
        const result = await health.addCondition(
          {
            id: input.id,
            name: input.name,
            code: input.code ?? null,
            codeSystem: input.codeSystem ?? null,
            status: input.status,
            severity: input.severity ?? null,
            diagnosedBy: input.diagnosedBy ?? null,
            onsetAt: input.onsetAt,
            zone: input.zone,
            note: input.note ?? null,
          },
          nowIso,
        );
        if (!result.ok) return errorResponse(result.error, traceId);
        return NextResponse.json({ condition: result.value }, { status: 201 });
      }

      case 'condition_status': {
        const input = parsed.data.change;
        const result = await health.reviseCondition(
          input.id,
          input.status,
          input.note ?? null,
          nowIso,
          input.successorId,
        );
        if (!result.ok) return errorResponse(result.error, traceId);
        return NextResponse.json({ condition: result.value }, { status: 201 });
      }

      case 'symptom': {
        const input = parsed.data.symptom;
        const planned = planSymptom({
          id: input.id,
          name: input.name,
          bodySite: input.bodySite ?? null,
          severity: input.severity ?? null,
          intensity: input.intensity ?? null,
          startedAt: input.startedAt,
          endedAt: input.endedAt ?? null,
          zone: input.zone,
          suspectedTrigger: input.suspectedTrigger ?? null,
          note: input.note ?? null,
        });
        if (!planned.ok) return errorResponse(planned.error, traceId);

        const registry = await createMetricRepository(platform.db).registry();
        if (!registry.ok) return errorResponse(registry.error, traceId);

        const result = await health.logSymptom(
          planned.value,
          healthWriteContext(registry.value, {
            deviceId: input.deviceId,
            ...(input.clientHlc === undefined ? {} : { clientHlc: input.clientHlc }),
          }),
        );
        if (!result.ok) return errorResponse(result.error, traceId);
        return NextResponse.json({ symptom: result.value }, { status: 201 });
      }

      case 'symptom_end': {
        const result = await health.endSymptom(parsed.data.end.id, parsed.data.end.endedAt);
        if (!result.ok) return errorResponse(result.error, traceId);
        return NextResponse.json({ ended: true });
      }

      case 'side_effect': {
        const input = parsed.data.sideEffect;
        const result = await health.recordSideEffect(
          {
            id: input.id,
            effect: input.effect,
            suspectedMedicationId: input.suspectedMedicationId ?? null,
            severity: input.severity ?? null,
            onsetAt: input.onsetAt,
            zone: input.zone,
            note: input.note ?? null,
          },
          nowIso,
        );
        if (!result.ok) return errorResponse(result.error, traceId);
        return NextResponse.json({ sideEffect: result.value }, { status: 201 });
      }

      case 'side_effect_reported': {
        const result = await health.markReported(parsed.data.reported.id);
        if (!result.ok) return errorResponse(result.error, traceId);
        return NextResponse.json({ reported: true });
      }

      case 'appointment': {
        const input = parsed.data.appointment;
        const result = await health.scheduleAppointment({
          id: input.id,
          title: input.title,
          provider: input.provider ?? null,
          specialty: input.specialty ?? null,
          location: input.location ?? null,
          scheduledFor: input.scheduledFor,
          zone: input.zone,
        });
        if (!result.ok) return errorResponse(result.error, traceId);
        return NextResponse.json({ appointment: result.value }, { status: 201 });
      }

      case 'appointment_questions': {
        const input = parsed.data.questions;
        const result = await health.saveQuestions(input.id, input.questions);
        if (!result.ok) return errorResponse(result.error, traceId);
        return NextResponse.json({ saved: input.questions.length });
      }

      case 'visit_notes': {
        const input = parsed.data.notes;
        const result = await health.recordVisit({
          id: input.id,
          attendedAt: input.attendedAt ?? null,
          postVisitNotes: input.postVisitNotes ?? null,
          outcome: input.outcome ?? null,
          followUpDue: input.followUpDue ?? null,
        });
        if (!result.ok) return errorResponse(result.error, traceId);
        return NextResponse.json({ recorded: true });
      }

      case 'procedure': {
        const input = parsed.data.procedure;
        const result = await health.recordProcedure(
          {
            id: input.id,
            name: input.name,
            toothNotation: input.toothNotation ?? null,
            performedBy: input.performedBy ?? null,
            location: input.location ?? null,
            performedAt: input.performedAt,
            zone: input.zone,
            outcome: input.outcome ?? null,
            complications: input.complications ?? null,
            costMinor: input.costMinor ?? null,
            currency: input.currency ?? null,
          },
          nowIso,
        );
        if (!result.ok) return errorResponse(result.error, traceId);
        return NextResponse.json({ procedure: result.value }, { status: 201 });
      }

      default: {
        const input = parsed.data.panel;
        const registry = await createMetricRepository(platform.db).registry();
        if (!registry.ok) return errorResponse(registry.error, traceId);

        const result = await createLabRepository(platform.db).recordPanel(
          {
            id: input.id,
            panelName: input.panelName,
            laboratory: input.laboratory ?? null,
            orderedBy: input.orderedBy ?? null,
            collectedAt: input.collectedAt,
            reportedAt: input.reportedAt ?? null,
            zone: input.zone,
            documentId: input.documentId ?? null,
            results: input.results.map((result) => ({
              id: result.id,
              analyteSlug: result.analyteSlug,
              printedName: result.printedName,
              value: result.value,
              valueText: result.valueText ?? null,
              unit: result.unit,
              referenceLow: result.referenceLow ?? null,
              referenceHigh: result.referenceHigh ?? null,
              referenceText: result.referenceText ?? null,
              flag: result.flag ?? null,
              confidence: result.confidence,
            })),
          },
          healthWriteContext(registry.value, { deviceId: 'server' }),
        );
        if (!result.ok) return errorResponse(result.error, traceId);
        return NextResponse.json(result.value, { status: 201 });
      }
    }
  } catch (error: unknown) {
    platform.observability.logger.error('unhandled error in health.post', {
      traceId,
      component: 'health.post',
      identifiers: { name: error instanceof Error ? error.name : 'unknown' },
    });
    return internalErrorResponse(traceId);
  }
}

/**
 * The write kinds that change the record's shape rather than adding to it.
 *
 * Read off the raw body before parsing, which is the one place in this codebase
 * that inspects an unvalidated payload. It is safe because the only thing taken
 * from it is a *set membership test* — an unrecognised value falls to the
 * narrower permission, and the schema rejects it a moment later anyway.
 */
const REGISTER_KINDS = new Set([
  'condition',
  'procedure',
  'condition_status',
  'side_effect',
  'side_effect_reported',
  'appointment',
  'appointment_questions',
  'visit_notes',
  'lab_panel',
]);
