/**
 * `/api/skin/products` — the product register (§4.2).
 *
 * Read-only in this milestone. Adding a product and logging an introduction are
 * both write paths that need a form, and §12's week-4 list puts "product
 * register" next to two whole domains and an encryption pipeline; the register
 * ships with its reads, its reaction history, and its "started 9 days ago"
 * context, and rows are inserted directly for now. `docs/skin.md` says so.
 */

import { NextResponse, type NextRequest } from 'next/server';

import {
  errorResponse,
  guard,
  internalErrorResponse,
  isGuardFailure,
} from '@/lib/platform/context';
import { loadProducts } from '@/lib/platform/skin';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const guarded = await guard(request, 'observation:read');
  if (isGuardFailure(guarded)) return guarded.response;
  const { traceId, platform } = guarded.context;

  const asOfDayKey = new URL(request.url).searchParams.get('asOfDayKey');
  if (asOfDayKey === null || !/^\d{4}-\d{2}-\d{2}$/u.test(asOfDayKey)) {
    return errorResponse(
      { kind: 'validation', code: 'invalid_day', message: 'asOfDayKey must be YYYY-MM-DD.', issues: [] },
      traceId,
    );
  }

  try {
    const result = await loadProducts(platform.db, { asOfDayKey, zone: platform.zone });
    if (!result.ok) return errorResponse(result.error, traceId);
    return NextResponse.json(result.value);
  } catch (error: unknown) {
    platform.observability.logger.error('unhandled error in skin.products.get', {
      traceId,
      component: 'skin.products.get',
      identifiers: { name: error instanceof Error ? error.name : 'unknown' },
    });
    return internalErrorResponse(traceId);
  }
}
