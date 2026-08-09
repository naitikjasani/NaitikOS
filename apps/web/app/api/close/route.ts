/**
 * `/api/close` — the Daily Close.
 *
 * §12 calls the Close "the week's actual deliverable and everything else is
 * supporting", so this is the endpoint the whole product turns on. It is also
 * the shortest one, which is what §5.2 asks for: every rule it enforces lives in
 * `core/close/plan.ts` where it can be tested without a database.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { dailyCloseQuerySchema, dailyCloseRequestSchema } from '@naitikos/api';
import { decodeValue } from '@naitikos/core';

import {
  errorResponse,
  guard,
  internalErrorResponse,
  isGuardFailure,
  parseJson,
  parseQuery,
  withoutUndefined,
} from '@/lib/platform/context';
import { withIdempotency } from '@/lib/platform/idempotent';
import { loadDailyClose, recordDailyClose } from '@/lib/platform/capture';
import { draftForClose, draftsForObservations } from '@/lib/platform/capture-events';

export const dynamic = 'force-dynamic';

/**
 * The form for a day, plus whatever is already recorded on it.
 *
 * Both in one response. A form with no current values renders every field empty
 * on a re-close, which is how an operator overwrites a morning's answers by
 * accident — and §4.0's whole design assumes re-closing the same day is normal.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const guarded = await guard(request, 'observation:read');
  if (isGuardFailure(guarded)) return guarded.response;
  const { traceId, platform } = guarded.context;

  const parsed = parseQuery(request, dailyCloseQuerySchema, traceId);
  if ('response' in parsed) return parsed.response;

  try {
    const loaded = await loadDailyClose(platform.db, parsed.data.dayKey, parsed.data.zone);
    if (!loaded.ok) return errorResponse(loaded.error, traceId);

    const { form, answers, note, isClosed, registry } = loaded.value;

    return NextResponse.json({
      dayKey: form.dayKey,
      zone: form.zone,
      isClosed,
      fields: form.fields,
      // Surfaced rather than silent: §4.0's "if it does not fit, something must
      // be cut" is an instruction to a person, so the person has to be told.
      budget: { count: form.elementCount, limit: form.budget, withinBudget: form.withinBudget },
      overflow: form.overflow,
      answers: Object.fromEntries(
        Object.entries(answers).map(([metricKey, stored]) => {
          const metric = registry.get(metricKey);
          return [
            metricKey,
            {
              ...stored,
              decoded: metric === null ? null : decodeValue(metric, { ...stored, unit: metric.canonicalUnit }),
            },
          ];
        }),
      ),
      note,
    });
  } catch (error: unknown) {
    /*
     * Reported before the generic 500. `internalErrorResponse` deliberately
     * returns nothing but a trace id (§5.12: an unexpected error must not
     * leak its shape to the caller), which means the *only* record of what
     * actually happened is this call.
     */
    platform.observability.logger.error('unhandled error in close.get', {
      traceId,
      component: 'close.get',
      identifiers: { name: error instanceof Error ? error.name : 'unknown' },
    });
    return internalErrorResponse(traceId);
  }
}

/** Record a Close. Idempotent, replay-safe, and a partial close is a close. */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const guarded = await guard(request, 'observation:write');
  if (isGuardFailure(guarded)) return guarded.response;
  const { traceId, platform } = guarded.context;

  const parsed = await parseJson(request, dailyCloseRequestSchema, traceId);
  if ('response' in parsed) return parsed.response;

  try {
    return await withIdempotency(
      platform.db,
      parsed.data.idempotencyKey,
      'POST /api/close',
      parsed.data,
      traceId,
      async () => {
        const result = await recordDailyClose(
          platform.db,
          { dayKey: parsed.data.dayKey, zone: parsed.data.zone, answers: parsed.data.answers },
          withoutUndefined({ deviceId: parsed.data.deviceId, clientHlc: parsed.data.clientHlc }),
        );

        if (!result.ok) {
          const response = errorResponse(result.error, traceId);
          return { status: response.status, body: await response.json() };
        }

        if (result.value.anomalies.length > 0) {
          platform.observability.logger.warn('clock anomaly during close', {
            traceId,
            component: 'daily-close',
            identifiers: { anomalies: result.value.anomalies.join(',') },
          });
        }

        /*
         * The Close's events, published after the transaction committed.
         *
         * This is the whole claim of ADR 0005 under test: the timeline gains a
         * Daily Close today without one line of timeline code being written in
         * this milestone. The projector registered in `createPlatformContext`
         * consumes whatever arrives.
         *
         * Swallowed on failure for the reason at the observations route: the
         * record must not depend on the timeline being able to render it.
         */
        const { plan } = result.value;
        const drafts = [
          ...draftsForObservations(result.value.committedObservations, guarded.context.actor.subjectId),
          ...(plan.isFirstCloseOfDay
            ? [
                draftForClose(
                  plan.dayKey,
                  plan.observedAt,
                  plan.completionObservationId,
                  // Counts, not values (ADR 0005). The marker is excluded from
                  // the numerator because it is not a field the operator filled.
                  plan.observations.filter((o) => o.metricKey !== 'system.daily_close.completed').length +
                    plan.unchanged.length,
                  result.value.fieldsAvailable,
                  guarded.context.actor.subjectId,
                ),
              ]
            : []),
        ];

        const published = await platform.bus.publish(drafts);
        if (!published.ok) {
          platform.observability.logger.warn('close events were not published', {
            traceId,
            component: 'daily-close',
            identifiers: { code: published.error.code },
          });
        }

        return {
          status: 202,
          body: {
            dayKey: plan.dayKey,
            observedAt: plan.observedAt,
            written: plan.observations.length,
            /*
             * Returned so the UI can say "nothing changed" rather than "saved"
             * on a no-op re-submission. §P1's honesty applied to feedback: a
             * confirmation for a write that did not happen is a small lie the
             * operator will eventually catch.
             */
            unchanged: plan.unchanged,
            isFirstCloseOfDay: plan.isFirstCloseOfDay,
            hlc: result.value.hlc,
          },
        };
      },
    );
  } catch (error: unknown) {
    /*
     * Reported before the generic 500. `internalErrorResponse` deliberately
     * returns nothing but a trace id (§5.12: an unexpected error must not
     * leak its shape to the caller), which means the *only* record of what
     * actually happened is this call.
     */
    platform.observability.logger.error('unhandled error in close.post', {
      traceId,
      component: 'close.post',
      identifiers: { name: error instanceof Error ? error.name : 'unknown' },
    });
    return internalErrorResponse(traceId);
  }
}
