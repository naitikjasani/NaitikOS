/**
 * The upload outbox endpoint — §5.7's durability requirement, for bytes.
 *
 *   POST   — reserve a slot and get a signed upload target
 *   PATCH  — report the outcome (uploaded, or failed)
 *   GET    — the unsynced list §5.7 requires be visible
 *
 * ## Why the server reserves a slot rather than receiving the bytes
 *
 * §5.5 puts skin and physique photos in the sensitive tier and requires that "the
 * storage provider holds ciphertext it cannot read". The client has therefore
 * already hashed, compressed, thumbnailed, and encrypted before it gets here —
 * so this endpoint takes a *description* of an object and hands back somewhere to
 * put it. Routing the bytes through Node would put a 12 MB body on a serverless
 * function for no benefit, and for the sensitive tier the server could not read
 * them anyway.
 *
 * ## The failure mode this shape is designed around
 *
 * A row is created before the upload starts, so an upload that dies mid-flight
 * leaves a visible `pending` entry rather than nothing at all. §5.7: "A failed
 * drain must never silently discard a write."
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { completeUploadSchema, failUploadSchema, requestUploadSchema } from '@naitikos/api';
import { buildStorageKey, systemClock, urlTtlForTier } from '@naitikos/core';

import { createSupabaseStorageProvider } from '../../../../lib/storage/supabase-storage-provider';
import {
  errorResponse,
  guard,
  isGuardFailure,
  parseJson,
  traceIdFor,
  unhandledErrorResponse,
} from '../../../../lib/platform/context';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const traceId = traceIdFor(request);

  try {
    const guarded = await guard(request, 'media:write');
    if (isGuardFailure(guarded)) return guarded.response;
    const { platform } = guarded.context;

    const parsed = await parseJson(request, requestUploadSchema, traceId);
    if ('response' in parsed) return parsed.response;
    const input = parsed.data;

    const storageKey = buildStorageKey({
      tier: input.tier,
      contentHash: input.contentHash,
      capturedOn: input.capturedOn,
      extension: input.contentType.split('/')[1] ?? 'bin',
    });

    if (storageKey === null) {
      return NextResponse.json(
        {
          error: {
            code: 'invalid_storage_key',
            message: 'Could not derive a storage key from the supplied hash and capture date.',
            traceId,
          },
        },
        { status: 400 },
      );
    }

    const reserved = await platform.outbox.enqueue({
      idempotencyKey: input.idempotencyKey,
      storageKey,
      tier: input.tier,
      contentType: input.contentType,
      expectedByteSize: input.byteSize,
      expectedContentHash: input.contentHash,
      ...(input.deviceId === undefined ? {} : { deviceId: input.deviceId }),
    });
    if (!reserved.ok) return errorResponse(reserved.error, traceId);

    // Already finished. A replayed request must not hand out a second upload URL
    // for an object that exists — §5.7 replays freely, so this is the normal path
    // rather than an edge case.
    if (reserved.value.status === 'uploaded') {
      return NextResponse.json(
        { status: 'already_uploaded' as const, entry: reserved.value },
        { status: 200, headers: { 'cache-control': 'private, no-store' } },
      );
    }

    const storage = createSupabaseStorageProvider({ clock: systemClock });
    const signed = await storage.createSignedUrl(storageKey, {
      expiresInSeconds: urlTtlForTier(input.tier),
    });
    if (!signed.ok) return errorResponse(signed.error, traceId);

    return NextResponse.json(
      { status: 'reserved' as const, entry: reserved.value, upload: signed.value },
      { status: 201, headers: { 'cache-control': 'private, no-store' } },
    );
  } catch (error: unknown) {
    /*
     * Logged before the generic 500. The reservation may or may not have landed
     * before the throw — §5.7 makes that survivable, because a replay of the
     * same `idempotencyKey` finds the row rather than creating a second — but
     * the operator can only reason about which happened if the failure left a
     * trace id in the log to join against `upload_outbox`.
     */
    return unhandledErrorResponse('media.uploads.post', traceId, error);
  }
}

/**
 * Report the outcome.
 *
 * Both branches leave a durable record. There is deliberately no branch that
 * deletes the row: an upload the user abandons is marked with a reason (§9.4),
 * and one that failed stays visible and retryable.
 */
export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const traceId = traceIdFor(request);

  try {
    const guarded = await guard(request, 'media:write');
    if (isGuardFailure(guarded)) return guarded.response;
    const { platform } = guarded.context;

    const body: unknown = await request.clone().json().catch(() => null);
    const isFailure =
      typeof body === 'object' && body !== null && 'errorCode' in body;

    if (isFailure) {
      const parsed = await parseJson(request, failUploadSchema, traceId);
      if ('response' in parsed) return parsed.response;

      const entry = await platform.outbox.byIdempotencyKey(parsed.data.idempotencyKey);
      if (entry === null) {
        return NextResponse.json(
          { error: { code: 'not_found', message: 'No such outbox entry.', traceId } },
          { status: 404 },
        );
      }

      await platform.outbox.markFailed(
        entry.id,
        parsed.data.errorCode,
        systemClock.now().toISOString(),
      );
      platform.observability.metrics.increment('sync.failed', { outcome: 'failure' });

      return NextResponse.json({ status: 'failed' as const }, { headers: { 'cache-control': 'private, no-store' } });
    }

    const parsed = await parseJson(request, completeUploadSchema, traceId);
    if ('response' in parsed) return parsed.response;

    const entry = await platform.outbox.byIdempotencyKey(parsed.data.idempotencyKey);
    if (entry === null) {
      return NextResponse.json(
        { error: { code: 'not_found', message: 'No such outbox entry.', traceId } },
        { status: 404 },
      );
    }

    const marked = await platform.outbox.markUploaded(entry.id, parsed.data.mediaObjectId);
    if (!marked.ok) return errorResponse(marked.error, traceId);

    if (entry.expectedByteSize !== null) {
      platform.observability.metrics.observe('media.upload.bytes', entry.expectedByteSize);
    }

    return NextResponse.json(
      { status: 'uploaded' as const },
      { headers: { 'cache-control': 'private, no-store' } },
    );
  } catch (error: unknown) {
    return unhandledErrorResponse('media.uploads.patch', traceId, error);
  }
}

/**
 * The unsynced list.
 *
 * §5.7: "entries that fail repeatedly surface in a visible 'unsynced' state with
 * a manual retry." This is what that surface reads. `health` comes with it
 * because the number a user needs is "is anything stuck", not a list of rows.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const traceId = traceIdFor(request);

  try {
    const guarded = await guard(request, 'media:read');
    if (isGuardFailure(guarded)) return guarded.response;
    const { platform } = guarded.context;

    const now = systemClock.now().toISOString();
    const [entries, health] = await Promise.all([
      platform.outbox.unsynced(),
      platform.outbox.health(now),
    ]);

    /*
     * The `sync.` prefix is wrong, and the comment that used to sit here made
     * the mistake it describes.
     *
     * `platform.outbox` is `createUploadOutboxRepository` — `upload_outbox`,
     * photographs waiting for a signed URL. §5.7's capture outbox, the one
     * holding a Daily Close made in aeroplane mode, is IndexedDB in
     * `lib/offline/outbox.ts` and contributes nothing to these numbers. The
     * previous note here — "§5.16 alerts on this: an entry older than 24 hours
     * means data the user believes is saved is not" — quoted §5.16 correctly
     * and pointed it at the wrong queue.
     *
     * The rename to `media.outbox.*` is the real fix and is not made here: the
     * names are a closed union in `packages/core` and a client wire contract in
     * `packages/api`, with a cross-package test asserting the two agree. See
     * the long note on `verify-media-integrity` in `app/api/jobs/nightly` and
     * `docs/background-jobs.md` §8.
     *
     * The `route` dimension is added so the two server emitters are at least
     * separable in `app_event`, which has a `route` column and no column for
     * any other dimension.
     */
    platform.observability.metrics.gauge('media.outbox.depth', health.pending + health.failed, {
      route: '/api/media/uploads',
    });
    if (health.oldestAgeSeconds !== null) {
      platform.observability.metrics.gauge(
        'media.outbox.oldest_age_seconds',
        health.oldestAgeSeconds,
        { route: '/api/media/uploads' },
      );
    }

    return NextResponse.json(
      { entries, health },
      { headers: { 'cache-control': 'private, no-store' } },
    );
  } catch (error: unknown) {
    return unhandledErrorResponse('media.uploads.get', traceId, error);
  }
}
