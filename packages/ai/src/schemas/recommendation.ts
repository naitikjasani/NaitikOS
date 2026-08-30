/**
 * The recommendation schema — §10.5.
 *
 *   "Deliberately conservative. Recommendations are rule-based, drawn from the
 *    user's own established protocols and their own historical data — not from
 *    population norms and not from model judgement."
 *
 * The model does not generate a recommendation. The *application* generates it
 * from a rule, and the model narrates it. That is why `category` is a closed
 * enum matching §10.5's four categories exactly: a recommendation outside them
 * is one the rules did not produce, which means the model invented it.
 *
 * There is no `dosage`, no `medication`, and no `stop`/`start` verb anywhere in
 * this type. §10.10 again: unrepresentable beats forbidden.
 */

import { z } from 'zod';

import { idSchema, narrationSchema } from './references';

/** §10.5's four categories, and no fifth. */
export const RECOMMENDATION_CATEGORIES = Object.freeze([
  /** A routine step consistently missed. */
  'protocol_adherence',
  /** A metric that has stopped being recorded. */
  'data_gap',
  /** An appointment cadence overdue, a lab worth repeating. */
  'timing',
  /** A variable held constant long enough that varying it would be informative. */
  'experiment',
] as const);

export type RecommendationCategory = (typeof RECOMMENDATION_CATEGORIES)[number];

export const recommendationSchema = z.object({
  /** The rule that produced this. The application owns the rule; the model does not. */
  ruleId: z.string().min(1).max(80),
  category: z.enum(RECOMMENDATION_CATEGORIES),

  headline: narrationSchema,
  detail: narrationSchema,

  /**
   * What the operator's own record says, cited.
   *
   * §10.5: "drawn from the user's own established protocols and their own
   * historical data". A recommendation with no basis is a population norm
   * wearing a personal one's clothes.
   */
  basis: z.array(idSchema).min(1).max(20),
});

export type Recommendation = z.infer<typeof recommendationSchema>;
