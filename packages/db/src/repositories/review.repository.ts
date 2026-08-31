/**
 * Reviews, persisted — §4.12.
 *
 * Two columns and one rule between them:
 *
 *   "The draft is the labour-saving part; the editing is the value. A review the
 *    user did not edit is a review they did not do, and the system should treat
 *    an unedited draft as incomplete rather than as a completed review."
 *
 * `draftContent` is the system's; `editedContent` is the operator's. Everything
 * below follows from the fact that only one of those two is replaceable.
 *
 * ## A re-draft never touches the edit
 *
 * `review_period_unique` on `(kind, period_start)` means a period has exactly
 * one review forever, so {@link ReviewRepository.upsertDraft} updates in place.
 * It writes `draftContent` and nothing else. The operator may re-draft August
 * after correcting a March bodyweight, get better figures, and still have every
 * word they wrote — because the alternative is a re-draft button that silently
 * destroys an hour of writing, and nobody presses that button twice.
 *
 * This is P5 and it is the same rule the calendar import follows when it refuses
 * to overwrite `is_travel`: the operator's work is not the system's to revert.
 *
 * ## Completion is guarded twice
 *
 * `review_complete_requires_edit` rejects `state = 'complete'` with a null
 * `editedContent` at the database, and `core`'s `isReviewComplete` additionally
 * rejects whitespace. The CHECK stops the impossible state reaching the archive;
 * the domain function stops the empty gesture counting as a review.
 */

import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Result } from '@naitikos/shared';
import { ok } from '@naitikos/shared';
import type { DomainError, ReviewKind, ReviewState } from '@naitikos/core';
import { notFoundError } from '@naitikos/core';

import type { Database } from '../client';
import { review } from '../schema/crosscutting';

export type ReviewRow = {
  readonly id: string;
  readonly kind: ReviewKind;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly draftContent: string | null;
  readonly editedContent: string | null;
  readonly state: ReviewState;
  readonly completedAt: string | null;
  readonly deletedAt: string | null;
};

function toReview(row: typeof review.$inferSelect): ReviewRow {
  return {
    id: row.id,
    kind: row.kind,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    draftContent: row.draftContent,
    editedContent: row.editedContent,
    state: row.state,
    completedAt: row.completedAt,
    deletedAt: row.deletedAt,
  };
}

export type UpsertDraftInput = {
  readonly id: string;
  readonly kind: ReviewKind;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly draftContent: string;
  readonly at: string;
};

export type SaveEditInput = {
  readonly id: string;
  readonly editedContent: string;
  readonly state: ReviewState;
  readonly at: string;
};

export type ReviewRepository = {
  /** Every review, newest period first. Optionally of one kind. */
  all(kind?: ReviewKind): Promise<Result<readonly ReviewRow[], DomainError>>;
  byId(id: string): Promise<Result<ReviewRow | null, DomainError>>;
  /** The single review of a period, by the natural key the archive is organised on. */
  forPeriod(kind: ReviewKind, periodStart: string): Promise<Result<ReviewRow | null, DomainError>>;
  /** Write or refresh the draft. **Never touches `editedContent`.** */
  upsertDraft(input: UpsertDraftInput): Promise<Result<ReviewRow, DomainError>>;
  saveEdit(input: SaveEditInput): Promise<Result<ReviewRow, DomainError>>;
  remove(id: string, at: string, reason: string): Promise<Result<ReviewRow, DomainError>>;
};

export function createReviewRepository(db: Database): ReviewRepository {
  return {
    async all(kind) {
      const rows = await db
        .select()
        .from(review)
        .where(kind === undefined ? isNull(review.deletedAt) : and(isNull(review.deletedAt), eq(review.kind, kind)))
        /* Newest period first. The archive is read backwards from now, and
         * `periodStart` rather than `createdAt` because a review written late
         * is still a review of its own period. */
        .orderBy(desc(review.periodStart));
      return ok(rows.map(toReview));
    },

    async byId(id) {
      const rows = await db
        .select()
        .from(review)
        .where(and(eq(review.id, id), isNull(review.deletedAt)))
        .limit(1);
      const row = rows[0];
      return ok(row === undefined ? null : toReview(row));
    },

    async forPeriod(kind, periodStart) {
      const rows = await db
        .select()
        .from(review)
        .where(and(eq(review.kind, kind), eq(review.periodStart, periodStart), isNull(review.deletedAt)))
        .limit(1);
      const row = rows[0];
      return ok(row === undefined ? null : toReview(row));
    },

    async upsertDraft(input) {
      const rows = await db
        .insert(review)
        .values({
          id: input.id,
          kind: input.kind,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          draftContent: input.draftContent,
        })
        .onConflictDoUpdate({
          /* The natural key, not the id. A re-draft arrives with a fresh UUIDv7
           * from a surface that does not know one already exists, and the period
           * is what makes them the same review. */
          target: [review.kind, review.periodStart],
          set: {
            draftContent: input.draftContent,
            periodEnd: input.periodEnd,
            updatedAt: input.at,
            /*
             * `review_period_unique` is not a partial index, so a tombstoned
             * review still owns its period. Clearing the tombstone here makes a
             * re-draft the undo §9.4 promises, rather than a write that cannot
             * happen against a row nothing can see.
             */
            deletedAt: null,
            deleteReason: null,
          },
        })
        .returning();

      const row = rows[0];
      /*
       * `editedContent`, `state` and `completedAt` appear in neither the insert
       * nor the update. That omission is the feature — see the file header. A
       * future contributor adding them here to "keep the row consistent" would
       * be deleting the only part of the review that took effort.
       */
      return row === undefined ? { ok: false, error: notFoundError('review', input.id) } : ok(toReview(row));
    },

    async saveEdit(input) {
      const rows = await db
        .update(review)
        .set({
          editedContent: input.editedContent,
          state: input.state,
          /*
           * Dated only on completion, and cleared when the state moves back.
           * A review reopened for editing is not a completed review, and a
           * `completedAt` left behind would date a completion that was
           * withdrawn — in a permanent archive, where nobody will remember.
           */
          completedAt: input.state === 'complete' ? input.at : null,
          updatedAt: input.at,
        })
        .where(and(eq(review.id, input.id), isNull(review.deletedAt)))
        .returning();

      const row = rows[0];
      return row === undefined ? { ok: false, error: notFoundError('review', input.id) } : ok(toReview(row));
    },

    async remove(id, at, reason) {
      const rows = await db
        .update(review)
        /* Soft, per §9.4. The draft and the edit both survive: §4.12 archives
         * reviews permanently, and a deleted review is one the operator no
         * longer wants shown, not one that never happened. */
        .set({ deletedAt: at, deleteReason: reason, updatedAt: at })
        .where(and(eq(review.id, id), isNull(review.deletedAt)))
        .returning();

      const row = rows[0];
      return row === undefined ? { ok: false, error: notFoundError('review', id) } : ok(toReview(row));
    },
  };
}
