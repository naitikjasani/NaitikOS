/**
 * `/api/reviews` — every Review write.
 *
 * ## One permission, and it is `observation:write`
 *
 * All three kinds sit behind the same scope. §5.4 splits permissions by blast
 * radius, and a review has none: it records what happened in a period that has
 * already ended. It does not change how a future observation is interpreted the
 * way a food's macros, a metric definition or a nutrition target does, and
 * nothing downstream is derived from it. Drafting is a read of the record
 * written back into one row; editing is prose; deleting is a tombstone §9.4
 * keeps. Every one of them is on the narrow side of §5.4's line.
 *
 * ## The server assembles the draft, and the client cannot
 *
 * `draft` carries a period and no content. The route reads the record, calls
 * `assembleDraft` — an ordinary deterministic function in `core` — and stores
 * the Markdown. No model is on this path, no API key, and nothing to be down;
 * §10.0 keeps the model out of the way of any figure a person reads, and the
 * Consultation Pack (`lib/platform/consultation-pack.ts`) records the same
 * decision at greater length.
 *
 * ## A period that has not ended cannot be drafted
 *
 * Enforced here, not only in the UI. §4.12 makes a review a permanent archived
 * document, and a document describing four days of a week as the week is a lie
 * the archive keeps. The screen disables the button and says why; this refuses
 * the request that arrives anyway.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { reviewWriteSchema } from '@naitikos/api';
import {
  assembleDraft,
  dayKeyInZone,
  draftToMarkdown,
  isPeriodClosed,
  isoFromMillis,
  periodContaining,
  preconditionFailedError,
  systemClock,
  validationError,
  zonedDayBounds,
} from '@naitikos/core';
import { createReviewRepository } from '@naitikos/db';

import {
  errorResponse,
  guard,
  internalErrorResponse,
  isGuardFailure,
  parseJson,
} from '@/lib/platform/context';
import { buildReviewInputs } from '@/lib/platform/reviews';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const guarded = await guard(request, 'observation:write');
  if (isGuardFailure(guarded)) return guarded.response;
  const { traceId, platform } = guarded.context;

  const parsed = await parseJson(request, reviewWriteSchema, traceId);
  if ('response' in parsed) return parsed.response;

  const reviews = createReviewRepository(platform.db);
  const nowIso = isoFromMillis(systemClock.nowMillis());

  try {
    switch (parsed.data.kind) {
      case 'draft': {
        const input = parsed.data.draft;

        /*
         * The period is recomputed from the day key rather than trusted as
         * sent. `periodContaining` is the single definition of a boundary
         * (§4.12), so a client that named a Wednesday gets that Wednesday's
         * week — and a client that named a date no calendar has gets refused,
         * because the window is what every figure in the draft is drawn from.
         */
        const period = periodContaining(input.reviewKind, input.periodStartDayKey);
        if (period === null) {
          return errorResponse(
            validationError('review_period_unresolvable', 'That is not a real date.', [
              { path: ['draft', 'periodStartDayKey'], message: 'Not a real date.' },
            ]),
            traceId,
          );
        }

        const todayDayKey = dayKeyInZone(nowIso, input.zone);
        if (!isPeriodClosed(period, todayDayKey)) {
          return errorResponse(
            preconditionFailedError(
              'period_closed',
              `${period.label} has not ended yet. A review of a period still being lived is a review of a partial record, and none of its figures would say so.`,
              'review_period_open',
            ),
            traceId,
          );
        }

        const bounds = periodBoundsOf(period.fromDayKey, period.toDayKey, input.zone);
        if (bounds === null) {
          return errorResponse(
            validationError('review_period_unresolvable', 'That period cannot be placed in that zone.'),
            traceId,
          );
        }

        /* Every figure below came from a query. See the file header. */
        const inputs = await buildReviewInputs(platform.db, period, input.zone);
        if (!inputs.ok) return errorResponse(inputs.error, traceId);

        const written = await reviews.upsertDraft({
          id: input.id,
          kind: period.kind,
          periodStart: bounds.start,
          periodEnd: bounds.end,
          draftContent: draftToMarkdown(assembleDraft(inputs.value)),
          at: nowIso,
        });
        if (!written.ok) return errorResponse(written.error, traceId);

        /*
         * 200, not 201. `upsertDraft` conflicts on `(kind, period_start)`, so a
         * re-draft of an already-drafted period updates in place — and it
         * leaves `editedContent` exactly where it was. Reporting a creation for
         * a row that already existed would be the response lying about which of
         * the two happened.
         */
        return NextResponse.json({ review: written.value });
      }

      case 'edit': {
        const input = parsed.data.edit;
        /*
         * `state` is the client's, and the schema already refuses `drafted`
         * here. Whether `complete` is *earned* is `core`'s judgement
         * (`isReviewComplete`) and the database's (`review_complete_requires_
         * edit`); the contract's `min(1)` is the third. §4.12, three times.
         */
        const saved = await reviews.saveEdit({
          id: input.id,
          editedContent: input.editedContent,
          state: input.state,
          at: nowIso,
        });
        if (!saved.ok) return errorResponse(saved.error, traceId);
        return NextResponse.json({ review: saved.value });
      }

      default: {
        const input = parsed.data.remove;
        /*
         * Soft (§9.4). The reason is optional on the wire and required by the
         * repository, so an unexplained deletion is recorded as unexplained
         * rather than given an invented one — the same rule a dropped task
         * follows.
         */
        const removed = await reviews.remove(input.id, nowIso, input.reason ?? '');
        if (!removed.ok) return errorResponse(removed.error, traceId);
        return NextResponse.json({ removed: true });
      }
    }
  } catch (error: unknown) {
    platform.observability.logger.error('unhandled error in reviews.post', {
      traceId,
      component: 'reviews.post',
      identifiers: { name: error instanceof Error ? error.name : 'unknown' },
    });
    return internalErrorResponse(traceId);
  }
}

/**
 * The period as a pair of stored instants.
 *
 * Half-open — `[start of the first day, start of the day after the last)` —
 * which is how §9.6's ranges are expressed everywhere else in this system. An
 * inclusive `23:59:59.999` end is wrong by a millisecond every day and by an
 * hour on the two days a DST rule moves, and `review_period_ordered` is
 * satisfied either way.
 */
function periodBoundsOf(
  fromDayKey: string,
  toDayKey: string,
  zone: string,
): { readonly start: string; readonly end: string } | null {
  const first = zonedDayBounds(fromDayKey, zone);
  const last = zonedDayBounds(toDayKey, zone);
  if (first === null || last === null) return null;
  return { start: first.start, end: last.end };
}
