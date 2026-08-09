/**
 * The idempotent-mutation wrapper.
 *
 * §5.7 puts a hard requirement on every write endpoint: "the outbox may replay
 * any request any number of times; the server deduplicates. Retry safety is
 * structural, not hopeful." Structural means *not* per-handler — a handler that
 * has to remember to claim a key is a handler that will one day forget, and the
 * symptom is a duplicated Daily Close nobody notices for a month.
 *
 * So every mutation goes through this, and the handler underneath never sees an
 * idempotency key at all.
 *
 * ## The three outcomes
 *
 * - **fresh** — run the handler, store its response, return it.
 * - **replayed** — return the stored response verbatim, without running
 *   anything. This is what lets the client reconcile and drop the outbox entry;
 *   a `409 already done` would leave it queued forever.
 * - **in_flight** — `409` with `Retry-After`. Another drain holds the key and
 *   has not finished. Telling the client to wait is honest; guessing that the
 *   other one will succeed is not.
 *
 * ## Why the response is stored *after* the handler and not inside it
 *
 * The write and the idempotency record are not in one transaction, so there is a
 * window in which the write committed and the record did not. A replay landing
 * in that window re-runs the handler — which is why the write path is *also*
 * idempotent (client-generated UUIDv7 primary keys, `ON CONFLICT DO NOTHING`).
 * Two mechanisms, and the second one is the load-bearing one; this layer saves
 * the round trip and returns the original body.
 */

import 'server-only';

import { NextResponse } from 'next/server';
import { isErr } from '@naitikos/shared';
import type { Database } from '@naitikos/db';
import { createIdempotencyRepository, fingerprintRequest } from '@naitikos/db';

import { errorResponse } from '../auth/handler-context';

/** How long a client should wait before retrying an in-flight key. */
const IN_FLIGHT_RETRY_SECONDS = 2;

export type IdempotentOutcome = {
  readonly status: number;
  readonly body: unknown;
};

/**
 * Run `execute` at most once per idempotency key.
 *
 * @param key - the client's key, already parsed out of the validated body.
 * @param endpoint - `POST /api/close`. Part of the fingerprint, so the same key
 *   cannot be reused across two different endpoints.
 * @param body - the raw validated body, for the fingerprint. A client bug that
 *   reuses one key for two different submissions is caught here rather than
 *   silently returning the first one's answer for the second.
 */
export async function withIdempotency(
  db: Database,
  key: string,
  endpoint: string,
  body: unknown,
  traceId: string,
  execute: () => Promise<IdempotentOutcome>,
): Promise<NextResponse> {
  const idempotency = createIdempotencyRepository(db);
  const fingerprint = fingerprintRequest(endpoint, JSON.stringify(body));

  const claim = await idempotency.claim(key, endpoint, fingerprint);
  if (isErr(claim)) return errorResponse(claim.error, traceId);

  if (claim.value.state === 'replayed') {
    return NextResponse.json(claim.value.body, {
      status: claim.value.status,
      // So a client can tell a replay from a fresh execution in its own logs.
      // Nothing depends on it, which is why it is a header rather than a field
      // in the body — the body must be byte-identical to the original.
      headers: { 'X-Idempotent-Replay': 'true' },
    });
  }

  if (claim.value.state === 'in_flight') {
    return NextResponse.json(
      {
        error: {
          code: 'request_in_flight',
          message: 'An identical request is still being processed. Retry shortly.',
          traceId,
        },
      },
      { status: 409, headers: { 'Retry-After': String(IN_FLIGHT_RETRY_SECONDS) } },
    );
  }

  try {
    const outcome = await execute();

    /*
     * Only successful outcomes are recorded.
     *
     * A stored 4xx would make the failure permanent for the life of the key: the
     * client fixes its payload, retries with the same outbox entry, and gets the
     * original rejection back forever. Releasing instead means the retry runs.
     */
    if (outcome.status >= 200 && outcome.status < 300) {
      await idempotency.complete(key, outcome.status, outcome.body);
    } else {
      await idempotency.release(key);
    }

    return NextResponse.json(outcome.body, { status: outcome.status });
  } catch (error: unknown) {
    // The key must not stay claimed after a crash, or every retry for a week
    // is answered `in_flight` — a self-inflicted outage with a seven-day
    // recovery. Released before rethrowing, so the real error still surfaces.
    await idempotency.release(key);
    throw error;
  }
}
