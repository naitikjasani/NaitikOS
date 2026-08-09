/**
 * `/api/telemetry` — §5.11's usage telemetry, in our own Postgres.
 *
 * > "**No third-party analytics. Ever.** (P7.) ... What is genuinely needed is
 * > *usage telemetry to protect the metrics in §1.4*."
 *
 * That framing is the whole design. This is not product analytics — there is one
 * user and they can be asked. It exists so that §1.4's health metrics and §12's
 * V1 gate are measured rather than guessed.
 *
 * ## Three things this handler deliberately does not do
 *
 * **It does not fail loudly.** A telemetry write that returns 500 makes the
 * client retry, and a client retrying telemetry is a client spending the
 * operator's battery measuring how slow it is. Every failure here is swallowed
 * and logged; the response is 202 either way.
 *
 * **It does not go through the outbox.** §5.7's queue is for facts, and a route
 * transition is not one. Telemetry lost to a dropped connection is telemetry
 * lost, which is fine — the metrics are medians over thirty days, and a queue
 * that persisted route transitions across sessions would put usage traces in
 * IndexedDB where the record's own writes live.
 *
 * **It does not trust the client's timestamp.** `at` is accepted and ignored for
 * ordering; `occurred_at` is the server's `now()`. A device with a wrong clock
 * would otherwise put events in the wrong day and quietly corrupt the
 * counter-metric.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { telemetryBatchSchema } from '@naitikos/api';
import { isIanaZone } from '@naitikos/core';

import { guard, isGuardFailure, parseJson } from '@/lib/platform/context';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  /*
   * Guarded like everything else. Telemetry about a signed-out visitor would be
   * telemetry about somebody who is not the operator, and §5.4 has one
   * authorization site per data path — including this one.
   */
  const guarded = await guard(request, 'observation:write');
  if (isGuardFailure(guarded)) return guarded.response;
  const { traceId, platform } = guarded.context;

  const parsed = await parseJson(request, telemetryBatchSchema, traceId);
  if ('response' in parsed) return parsed.response;

  const zone = parsed.data.zone !== null && parsed.data.zone !== undefined && isIanaZone(parsed.data.zone)
    ? parsed.data.zone
    : platform.zone;

  try {
    for (const event of parsed.data.events) {
      /*
       * Through the metrics port rather than a direct insert.
       *
       * `createPostgresMetrics` already owns the `app_event` write, its
       * failure handling, and the "never recurse into the table that just
       * failed" rule. A second writer would be a second place for that logic to
       * drift.
       */
      if (event.value === null || event.value === undefined) {
        platform.observability.metrics.increment(event.name, {
          ...(event.route === null || event.route === undefined ? {} : { route: event.route }),
          ...(event.deviceClass === null || event.deviceClass === undefined
            ? {}
            : { deviceClass: event.deviceClass }),
        });
      } else {
        platform.observability.metrics.observe(event.name, event.value, {
          ...(event.route === null || event.route === undefined ? {} : { route: event.route }),
          ...(event.deviceClass === null || event.deviceClass === undefined
            ? {}
            : { deviceClass: event.deviceClass }),
        });
      }
    }

    // 202: recorded on a best-effort basis, and the client must not care.
    return NextResponse.json({ accepted: parsed.data.events.length, zone }, { status: 202 });
  } catch (error: unknown) {
    platform.observability.logger.warn('telemetry batch was dropped', {
      traceId,
      component: 'telemetry.post',
      identifiers: { name: error instanceof Error ? error.name : 'unknown' },
    });
    /*
     * Still 202. See the header: a client that retries telemetry is a client
     * spending battery measuring how slow it is.
     */
    return NextResponse.json({ accepted: 0, zone }, { status: 202 });
  }
}
