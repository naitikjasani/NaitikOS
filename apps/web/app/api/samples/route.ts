/**
 * `/api/samples` — wearable batch ingestion (§2.3).
 *
 * ## The handler translates, because the client must not
 *
 * §5.2 says "route handlers are transport, not logic", and this one holds to
 * that: it parses, resolves provenance, calls `normaliseBatch`, and serialises.
 * Every judgement — which identifier is which metric, which units convert,
 * which readings are out of range — belongs to `core` and is tested there
 * without a server.
 *
 * What the handler *does* own is the refusal to let a client name a metric key.
 * §9.2 makes the registry the single vocabulary; a client that could write
 * `body.weight` directly could write a heart rate into it, and the resulting
 * row would be indistinguishable from a real one forever.
 *
 * ## `observation:write`, not a wider permission
 *
 * A sample is a reading. It does not change how any other reading is
 * interpreted, the way a metric definition or a nutrition target would. §5.4
 * splits permissions by blast radius, and this sits on the narrow side even
 * though the row count is the largest in the system.
 *
 * ## The response says what was refused
 *
 * Skipped identifiers, rejected rows with reasons, in-batch duplicates, and
 * rows the database already had. §8.9 requires missing data be shown as
 * missing; an importer reporting "12,000 imported" while having dropped 4,000
 * would be the same lie in a place nobody would think to check.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { sampleImportRequestSchema } from '@naitikos/api';
import { normaliseBatch, skippedTotal, systemClock } from '@naitikos/core';
import { createMetricRepository, createSampleRepository } from '@naitikos/db';
import { uuidV7 } from '@naitikos/shared';

import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';
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

  const parsed = await parseJson(request, sampleImportRequestSchema, traceId);
  if ('response' in parsed) return parsed.response;

  const { platform: source, importerVersion, rows } = parsed.data;

  try {
    const metrics = createMetricRepository(platform.db);
    const registryResult = await metrics.registry();
    if (!registryResult.ok) return errorResponse(registryResult.error, traceId);

    const samples = createSampleRepository(platform.db);
    const sourceResult = await samples.sourceFor(source, importerVersion);
    if (!sourceResult.ok) return errorResponse(sourceResult.error, traceId);

    /*
     * Ids are minted here rather than by the client, unlike every capture path
     * in this system. §5.7 wants a client-minted UUIDv7 so a record has its
     * identity offline — but a sample has no offline identity to preserve: the
     * device already recorded it, the phone is replaying it, and the row's real
     * identity is `(source, metric, instant)`. Asking a client to mint ten
     * thousand ids per chunk would add bytes to every request in exchange for
     * a guarantee the natural key already provides.
     */
    const batch = normaliseBatch(rows, {
      platform: source,
      registry: registryResult.value,
      fallbackZone: DEFAULT_PROFILE_ZONE,
      newId: () => uuidV7(systemClock.nowMillis()),
    });

    const imported = await samples.importSamples(sourceResult.value, batch.rows);
    if (!imported.ok) return errorResponse(imported.error, traceId);

    return NextResponse.json({
      received: rows.length,
      inserted: imported.value.inserted,
      /** Already present — a re-import, which is the intended shape (§2.3). */
      alreadyPresent: imported.value.duplicates,
      /** Repeated within this chunk, before the database saw them. */
      duplicatesInBatch: batch.duplicates,
      /** Identifiers with no registered metric, and how many rows each had. */
      skipped: batch.skipped,
      skippedTotal: skippedTotal(batch),
      rejectedTotal: batch.rejectedTotal,
      rejected: batch.rejected,
    });
  } catch (error: unknown) {
    platform.observability.logger.error('unhandled error in samples.post', {
      traceId,
      component: 'samples.post',
      identifiers: { name: error instanceof Error ? error.name : 'unknown' },
    });
    return internalErrorResponse(traceId);
  }
}
