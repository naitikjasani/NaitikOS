/**
 * Review contracts — §4.12.
 *
 * ## The client cannot supply draft content
 *
 * `draft` carries a period and nothing else. There is no `draftContent` field
 * on the wire, and its absence is the contract rather than an oversight.
 *
 * A draft is a *statement about the record*: so many days closed, so many gym
 * sessions, this mean mood over that many observations. The server assembles it
 * by reading those rows. A client-supplied draft would be a statement about
 * nothing checkable — prose that looks identical to the assembled kind, sits in
 * the same column, and asserts figures no query produced. §10.0 puts the model
 * outside the path of any number a person reads, and a text field a client can
 * fill is exactly that path with the guard removed.
 *
 * So the only content a client may send is `editedContent`, which is honestly
 * labelled: it is the operator's own writing, stored in its own column, and
 * never mistaken for a figure the record vouched for.
 *
 * ## `complete` requires content, in three places
 *
 * §4.12: "a review the user did not edit is a review they did not do." That is
 * enforced here (`editedContent` is required by the shape of the `edit` kind),
 * again in `core` (`isReviewComplete` refuses an empty or untouched body), and
 * a third time by the database — `review_complete_requires_edit` is a `CHECK`,
 * not a repository habit.
 *
 * Three enforcement points for one rule looks like duplication until the rule is
 * read as what it is: the only thing separating a completed review from a
 * document the operator never opened. A convention would be broken by the first
 * caller that forgot, and the row it produced would be indistinguishable from a
 * real one forever after.
 */

import { z } from 'zod';

import { dayKeySchema, uuidSchema, zoneSchema } from './timeline';

/** §4.12's four cadences. Matches the `review_kind` enum. */
export const reviewKindSchema = z.enum(['weekly', 'monthly', 'quarterly', 'annual']);

/**
 * The two states a client may write.
 *
 * `drafted` is missing on purpose: it is what the server writes when it
 * assembles a draft, and a client that could set it could walk a review
 * backwards from `complete` to "never touched" while leaving the edited text in
 * place. Regressing to `editing` is allowed — reopening a review is a real act.
 */
export const reviewEditStateSchema = z.enum(['editing', 'complete']);

/**
 * Ask the server to draft a review of one period.
 *
 * The period is named by its first day rather than by both ends, because the
 * end is a function of the kind and the start (§4.12's boundaries are ISO
 * weeks, calendar months, calendar quarters and calendar years). Accepting both
 * would let a client send a "weekly" review spanning eleven days, which every
 * per-period figure in the draft would then silently be wrong about.
 */
export const draftReviewRequestSchema = z.object({
  id: uuidSchema,
  reviewKind: reviewKindSchema,
  periodStartDayKey: dayKeySchema,
  /** The zone the period's day boundaries are drawn in (§5.3). */
  zone: zoneSchema,
});

/**
 * Save the operator's own writing.
 *
 * `min(1)` because an empty edit is not an edit, and the 100,000-character
 * ceiling is a transport bound rather than an editorial one — an annual review
 * is long, and a limit that cut one off mid-sentence would be worse than no
 * limit at all.
 */
export const editReviewRequestSchema = z.object({
  id: uuidSchema,
  editedContent: z.string().min(1).max(100000),
  state: reviewEditStateSchema,
});

/**
 * Retire a review.
 *
 * Soft, like everything else on this substrate (§9.3). The reason is asked for
 * and never required — an honest blank beats an invented explanation, the same
 * rule a dropped task follows.
 */
export const deleteReviewRequestSchema = z.object({
  id: uuidSchema,
  reason: z.string().max(200).nullish(),
});

export const reviewWriteSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('draft'), draft: draftReviewRequestSchema }),
  z.object({ kind: z.literal('edit'), edit: editReviewRequestSchema }),
  z.object({ kind: z.literal('delete'), remove: deleteReviewRequestSchema }),
]);

export type ReviewWriteRequest = z.infer<typeof reviewWriteSchema>;
export type DraftReviewRequest = z.infer<typeof draftReviewRequestSchema>;
export type EditReviewRequest = z.infer<typeof editReviewRequestSchema>;
export type DeleteReviewRequest = z.infer<typeof deleteReviewRequestSchema>;
