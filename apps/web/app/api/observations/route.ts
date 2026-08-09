/**
 * `/api/observations` — the capture endpoint.
 *
 * §5.2 keeps a handler to "parse, authenticate, delegate, serialise". The
 * delegation is `lib/platform/capture.ts`; the idempotency is
 * `lib/platform/idempotent.ts`; the validation is `core`. What is left here is
 * transport, which is the point.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { createObservationsRequestSchema, observationQuerySchema } from '@naitikos/api';
import { decodeValue } from '@naitikos/core';
import { createMetricRepository, createObservationRepository } from '@naitikos/db';

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
import { captureObservations } from '@/lib/platform/capture';
import { draftsForObservations } from '@/lib/platform/capture-events';

export const dynamic = 'force-dynamic';

/**
 * Write observations.
 *
 * 202 rather than 201, deliberately. The write is committed by the time this
 * returns, but the *record* is not complete until the nightly job derives
 * rollups and adherence from it (§5.2). "Accepted" is the honest status for a
 * fact the system has taken and is not finished with.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const guarded = await guard(request, 'observation:write');
  if (isGuardFailure(guarded)) return guarded.response;
  const { traceId, platform } = guarded.context;

  const parsed = await parseJson(request, createObservationsRequestSchema, traceId);
  if ('response' in parsed) return parsed.response;

  try {
    return await withIdempotency(
      platform.db,
      parsed.data.idempotencyKey,
      'POST /api/observations',
      parsed.data,
      traceId,
      async () => {
        const result = await captureObservations(
          platform.db,
          parsed.data.observations.map((input) => withoutUndefined(input)),
          withoutUndefined({ deviceId: parsed.data.deviceId, clientHlc: parsed.data.clientHlc }),
        );

        if (!result.ok) {
          const response = errorResponse(result.error, traceId);
          return { status: response.status, body: await response.json() };
        }

        /*
         * Clock anomalies are logged, never returned as a failure.
         *
         * §5.8 asks for skew to be "flagged in diagnostics rather than silently
         * absorbed" — flagged, not fatal. The operator standing in a gym does
         * not need to know their phone's clock is fast; they need the set to be
         * recorded, in the right order, which it now is.
         */
        if (result.value.anomalies.length > 0) {
          platform.observability.logger.warn('clock anomaly during capture', {
            traceId,
            component: 'capture',
            identifiers: { anomalies: result.value.anomalies.join(',') },
          });
        }

        /*
         * Published after the write, not inside it.
         *
         * ADR 0005 makes the event log an *integration* log: the observation is
         * the fact and the event is the announcement. Publishing inside the
         * write transaction would make a projector failure roll back a
         * legitimate observation, which inverts the dependency — the record
         * must not depend on the timeline being able to render it.
         *
         * A publish failure is therefore logged and swallowed. The dead-letter
         * table holds the event and a replay reprojects it (§5.2's nightly
         * job), so the timeline heals without the operator losing a write.
         */
        const published = await platform.bus.publish(
          draftsForObservations(result.value.observations, guarded.context.actor.subjectId),
        );
        if (!published.ok) {
          platform.observability.logger.warn('capture events were not published', {
            traceId,
            component: 'capture',
            identifiers: { code: published.error.code },
          });
        }

        return {
          status: 202,
          body: {
            written: result.value.written,
            // Echoed so the client can store it and send it next time. Without
            // this the device's HLC never advances across requests.
            hlc: result.value.hlc,
            ids: result.value.observations.map((observation) => observation.id),
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
    platform.observability.logger.error('unhandled error in observations.post', {
      traceId,
      component: 'observations.post',
      identifiers: { name: error instanceof Error ? error.name : 'unknown' },
    });
    return internalErrorResponse(traceId);
  }
}

/** Read observations. Decoded against the registry, so a client renders values
 * without knowing the encoding (§9.2). */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const guarded = await guard(request, 'observation:read');
  if (isGuardFailure(guarded)) return guarded.response;
  const { traceId, platform } = guarded.context;

  const parsed = parseQuery(request, observationQuerySchema, traceId);
  if ('response' in parsed) return parsed.response;

  try {
    const registry = await createMetricRepository(platform.db).registry();
    if (!registry.ok) return errorResponse(registry.error, traceId);

    const result = await createObservationRepository(platform.db).query(withoutUndefined(parsed.data));
    if (!result.ok) return errorResponse(result.error, traceId);

    return NextResponse.json({
      observations: result.value.map((observation) => {
        const metric = registry.value.get(observation.metricKey);
        return {
          id: observation.id,
          metricKey: observation.metricKey,
          value: observation.value,
          valueText: observation.valueText,
          unit: observation.unit,
          observedAt: observation.observedAt,
          observedZone: observation.observedZone,
          recordedAt: observation.recordedAt,
          supersededById: observation.supersededById,
          // `null` when the row and its metric disagree — an ordinal past the
          // end of `allowedValues`, say. Honest, and a wrong label would not be.
          decoded: metric === null ? null : decodeValue(metric, observation),
          displayName: metric?.displayName ?? observation.metricKey,
        };
      }),

      /*
       * The registry entry for every metric in the response.
       *
       * §9.2's claim — "summing bodyweight over a week is nonsense and averaging
       * training volume hides a taper; **the registry is what stops a chart from
       * doing either**" — is only true if the chart can *see* the registry. The
       * client holds none, so without this a client-side rollup would have to
       * pick an aggregation itself, which is exactly the choice §9.2 removes.
       *
       * Only the fields a rollup needs. The full definition carries
       * `description`, which is long and already travels in the export, where a
       * reader in 2046 will actually look for it.
       */
      metrics: Object.fromEntries(
        [...new Set(result.value.map((observation) => observation.metricKey))].flatMap((key) => {
          const metric = registry.value.get(key);
          return metric === null
            ? []
            : [
                [
                  key,
                  {
                    key: metric.key,
                    displayName: metric.displayName,
                    canonicalUnit: metric.canonicalUnit,
                    valueType: metric.valueType,
                    aggregation: metric.aggregation,
                  },
                ],
              ];
        }),
      ),
    });
  } catch (error: unknown) {
    /*
     * Reported before the generic 500. `internalErrorResponse` deliberately
     * returns nothing but a trace id (§5.12: an unexpected error must not
     * leak its shape to the caller), which means the *only* record of what
     * actually happened is this call.
     */
    platform.observability.logger.error('unhandled error in observations.get', {
      traceId,
      component: 'observations.get',
      identifiers: { name: error instanceof Error ? error.name : 'unknown' },
    });
    return internalErrorResponse(traceId);
  }
}
