/**
 * The Ask schema — §10.4's consumer and §10.0's hardest case.
 *
 * Ask is conversational, which is exactly where the temptation to let the model
 * speak freely is strongest and where §10.0 matters most:
 *
 *   "The model never computes, discovers, or asserts. It retrieves, explains,
 *    ranks, and drafts."
 *
 * So an answer is not a string. It is a list of narrated paragraphs, each with
 * its references, plus a required statement of what was *not* retrieved.
 *
 * ## `omitted` is required for the reason §10.4 gives
 *
 *   "BUDGET — Fit to the token budget. Prefer structured summaries over raw
 *    rows. **Never silently truncate — state what was omitted.**"
 *
 * An answer assembled from a partial context pack that does not say so is an
 * answer the operator will read as complete. This is the field that stops that,
 * and it is required so that "nothing was omitted" has to be stated rather than
 * inferred from an absence.
 */

import { z } from 'zod';

import { narrationSchema } from './references';

/** §10.4's classification, closed. Drives retrieval, so it cannot be open. */
export const QUESTION_KINDS = Object.freeze([
  'temporal',
  'causal',
  'status',
  'comparative',
  'clinical',
  'reflective',
] as const);

export type QuestionKind = (typeof QUESTION_KINDS)[number];

export const answerSchema = z.object({
  kind: z.enum(QUESTION_KINDS),

  /** The answer, as narrated paragraphs. Digits refused in each. */
  paragraphs: z.array(narrationSchema).min(1).max(8),

  /**
   * What the context pack did not include, in plain words.
   *
   * The empty string is not permitted — "nothing was omitted" is a claim worth
   * making explicitly, and an empty field is indistinguishable from a model
   * that forgot.
   */
  omitted: z.string().min(1).max(400),

  /**
   * Whether the question could be answered from the record at all.
   *
   * §10.9's principle generalised: degrade to "insufficient data" rather than
   * guessing. A model that cannot answer says so in this field instead of
   * producing a fluent paragraph about what is generally true of people.
   */
  answerable: z.boolean(),
});

export type Answer = z.infer<typeof answerSchema>;
