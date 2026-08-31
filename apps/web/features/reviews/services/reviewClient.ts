'use client';

/**
 * The Reviews feature's client service (§7.3).
 *
 * Writes only — every review surface is server-rendered. A review is opened
 * deliberately, once a week at most, and polling one would add exactly the
 * background request §1.4's counter-metric exists to discourage.
 *
 * **Nothing here queues through the outbox.** A review is not an observation:
 * `saveEdit` is a state transition on a row, and the outbox replays in queue
 * order rather than causal order. An edit replayed after a later edit would
 * silently restore older prose over newer, and the prose is the one thing in
 * this table nothing can reconstruct. So this path stays online-only, and the
 * screen says so rather than letting the operator discover it when a saved
 * review turns out not to have been saved.
 *
 * **`draft` sends no content.** The server assembles it from the record. See
 * the header of `contracts/reviews.ts` for why a client-supplied draft would be
 * a document asserting figures no query produced (§10.0).
 */

import type { ReviewKind, ReviewState } from '@naitikos/core';

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

async function post<T>(body: unknown): Promise<T> {
  const response = await fetch('/api/reviews', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as { readonly message?: string } | null;
    throw new HttpError(response.status, detail?.message ?? `Request failed (${String(response.status)}).`);
  }
  return (await response.json()) as T;
}

/** What every write returns: the row, as the server now holds it. */
export type ReviewResponse = {
  readonly review: {
    readonly id: string;
    readonly kind: ReviewKind;
    readonly periodStart: string;
    readonly periodEnd: string;
    readonly draftContent: string | null;
    readonly editedContent: string | null;
    readonly state: ReviewState;
    readonly completedAt: string | null;
  };
};

export type DraftRequest = {
  readonly id: string;
  readonly reviewKind: ReviewKind;
  readonly periodStartDayKey: string;
  readonly zone: string;
};

export async function draftReview(request: DraftRequest): Promise<ReviewResponse> {
  return post({ kind: 'draft', draft: request });
}

/**
 * Save the operator's own writing.
 *
 * `state` is `'editing'` for a save-and-keep-going and `'complete'` for a
 * finish. The server refuses `'complete'` with an unedited body, and so does
 * the screen — see `ReviewDetailScreen`, and §4.12.
 */
export async function saveReviewEdit(input: {
  readonly id: string;
  readonly editedContent: string;
  readonly state: 'editing' | 'complete';
}): Promise<ReviewResponse> {
  return post({ kind: 'edit', edit: input });
}

export async function deleteReview(
  id: string,
  reason: string | null,
): Promise<{ readonly removed: boolean }> {
  return post({ kind: 'delete', remove: { id, reason } });
}
