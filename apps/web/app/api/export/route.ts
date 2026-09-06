/**
 * `/api/export` — the complete archive (§9.10).
 *
 * ## Step-up, and where it actually happens
 *
 * §5.4: "sensitive operations — export, encryption-key access, deletion —
 * require step-up re-authentication regardless of session age." Export is named
 * first in that list, and the reason is what this endpoint returns: one request
 * yields the entire medical history in a form that needs no credentials to
 * read. A thirty-day sliding session is the right trade for reading a mood
 * score and the wrong one for that.
 *
 * **There is no second guard in this file, and that is deliberate.**
 * `export:execute` is in `STEP_UP_PERMISSIONS`, and `core`'s `authorize` checks
 * the fifteen-minute window as part of granting it — so the ordinary
 * `guard(request, 'export:execute')` already refuses a stale session with
 * `step_up_required`. Adding an explicit check here would be a *second*
 * authorization site, which §5.4 permits exactly one of, and the second one
 * would be the one that drifted.
 *
 * ## Why the whole archive is built in memory
 *
 * The alternative is a streamed ZIP, which is possible but requires either
 * data-descriptor records (poorly supported by older tools) or knowing every
 * entry's size in advance (which means reading everything anyway).
 *
 * The bound that makes this acceptable is arithmetic from §9.7: the human
 * record reaches "under 400,000 rows" over twenty years. At a generous 500
 * bytes a row that is 200 MB of NDJSON, and media is excluded from this
 * endpoint for exactly this reason — §9.10's monthly automated export runs as a
 * job with a filesystem, and that is where media belongs. This endpoint is the
 * operator asking for their record now.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { buildExportBundle, isoFromMillis, systemClock } from '@naitikos/core';
import { createExportRepository, createMetricRepository } from '@naitikos/db';

import { errorResponse, guard, internalErrorResponse, isGuardFailure } from '@/lib/platform/context';

export const dynamic = 'force-dynamic';

/**
 * The archive is not cached, anywhere, ever.
 *
 * `no-store` rather than `no-cache`: the second permits storing the response and
 * revalidating, and a complete medical record sitting in a shared proxy's disk
 * cache is precisely the disclosure §5.14 exists to prevent.
 */
const NO_STORE = 'no-store, no-cache, must-revalidate, private';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const guarded = await guard(request, 'export:execute');
  if (isGuardFailure(guarded)) return guarded.response;
  const { traceId, platform, actor } = guarded.context;

  try {
    const exports = createExportRepository(platform.db);
    const registry = await createMetricRepository(platform.db).registry();
    if (!registry.ok) return errorResponse(registry.error, traceId);

    /*
     * `includeOperational` is opt-in from the query string.
     *
     * §9.10's export is of *the record*, and an idempotency key is not a fact
     * about a person — so the default omits the operational tables. The flag
     * exists because a full-fidelity backup drill wants everything, and that is
     * a different job from an export. Defaulting the other way would put sync
     * bookkeeping into the archive a stranger reads in 2046.
     */
    const includeOperational = new URL(request.url).searchParams.get('operational') === 'true';

    const [tables, timeline] = await Promise.all([
      exports.tables({ includeOperational }),
      exports.medicalTimelineMarkdown(),
    ]);
    if (!tables.ok) return errorResponse(tables.error, traceId);
    if (!timeline.ok) return errorResponse(timeline.error, traceId);

    const generatedAt = isoFromMillis(systemClock.nowMillis());

    const bundle = buildExportBundle({
      generatedAt,
      tables: tables.value,
      metrics: registry.value.all(),
      // Empty by design at this endpoint — see the file header.
      media: [],
      medicalTimelineMarkdown: timeline.value,
    });

    if (!bundle.ok) {
      platform.observability.logger.error('export bundle could not be built', {
        traceId,
        component: 'export',
        identifiers: { failure: bundle.failure },
      });
      return internalErrorResponse(traceId);
    }

    /*
     * §9.4 records the export in the audit trail.
     *
     * An export is the one operation that removes data from the system's
     * control, so "when was the record last taken out, and by whom" has to be
     * answerable. Recorded before the response is returned, so a crash mid-send
     * still leaves the attempt logged.
     */
    await platform.observability.audit.recordDomainEvent({
      entityType: 'archive',
      entityId: generatedAt,
      // The closest operation in the closed set: an export creates an artifact
      // that leaves the system. There is no `read` in the enum by design (§9.4
      // audits changes), and inventing one for this would widen the vocabulary
      // for a single call site.
      operation: 'insert',
      actor: actor.subjectId,
      // Counts only. §5.11: "Event names and numeric measurements only. No
      // payloads, ever."
      changeReason: `Export: ${String(bundle.bundle.manifest.tables.length)} tables, ${String(bundle.bundle.manifest.totalRows)} rows`,
      traceId,
    });

    const filename = `naitikos-export-${generatedAt.slice(0, 10)}.zip`;

    return new NextResponse(bundle.bundle.bytes as unknown as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(bundle.bundle.bytes.length),
        'Cache-Control': NO_STORE,
        /*
         * The manifest, in a header, so a caller can verify the archive without
         * unzipping it — which is what §9.10's quarterly drill needs: "asserts
         * row-count and checksum equality".
         */
        'X-Export-Manifest': JSON.stringify(bundle.bundle.manifest),
      },
    });
  } catch (error: unknown) {
    platform.observability.logger.error('unhandled error in export', {
      traceId,
      component: 'export',
      identifiers: { name: error instanceof Error ? error.name : 'unknown' },
    });
    return internalErrorResponse(traceId);
  }
}
