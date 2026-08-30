/**
 * The insight schema — §10.10's "makes the harmful output unrepresentable".
 *
 *   "Insight and recommendation schemas contain **no field capable of
 *    expressing a diagnosis, a dosage, or a treatment change.** The
 *    representation makes the harmful output unrepresentable, which is stronger
 *    than any instruction."
 *
 * So the interesting part of this file is what is absent. There is no
 * `diagnosis`, no `dose`, no `action`, no `severity`, and no free-text field
 * that a model could use as one — `narration` refuses digits and every figure
 * is a reference (`references.ts`).
 *
 * ## `limitation` is required, and that is the point
 *
 * §10.6: "Every insight displays its n, its effect size, its confidence, and —
 * **as a required field in the output schema** — an explicit statement of what
 * it does not prove."
 *
 * Optional would mean absent, and an insight without its limitation is an
 * insight the user cannot audit. Making the field required means a model that
 * has nothing honest to say there cannot emit the insight at all, which is the
 * correct outcome.
 */

import { z } from 'zod';

import { idSchema, narrationSchema } from './references';

/**
 * The detector families of §10.6, closed.
 *
 * Closed because an insight whose kind the application does not recognise
 * cannot be rendered with the right caveat, and rendering it with the wrong one
 * is worse than dropping it.
 */
export const INSIGHT_KINDS = Object.freeze([
  'changepoint',
  'correlation',
  'adherence',
  'streak',
  'threshold',
  'cycle',
  'anomaly',
  'stagnation',
  'divergence',
] as const);

export type InsightKind = (typeof INSIGHT_KINDS)[number];

export const insightKindSchema = z.enum(INSIGHT_KINDS);

/**
 * Whether the pair was pre-registered — §10.6 control 3.
 *
 *   "Exploratory all-pairs testing runs at a much stricter threshold and its
 *    output is **labelled exploratory wherever it appears**."
 *
 * Carried on the insight rather than looked up at render time, so the label
 * cannot be lost by a surface that forgot to join.
 */
export const provenanceSchema = z.enum(['pre_registered', 'exploratory']);

export const insightSchema = z.object({
  /** The finding this narrates. The application already holds its numbers. */
  findingId: idSchema,
  kind: insightKindSchema,
  provenance: provenanceSchema,

  /** One sentence. Digits refused; figures are references. */
  headline: narrationSchema,
  /** The body. Same rules. */
  detail: narrationSchema,

  /**
   * What this does not prove. Required (§10.6).
   *
   * Plain prose and no references, because a limitation is a statement about
   * epistemics rather than about a number — "this is an association over a
   * single person and says nothing about cause" contains no figure to get
   * wrong.
   */
  limitation: z.string().min(20).max(600),

  /**
   * How the model ranked it against the rest of tonight's battery, 0–1.
   *
   * §10.6 stage 2 lets the model "produce plain-language explanation **and
   * priority ordering**". Ranking is a judgement about salience, which is the
   * kind of thing a model is good at; it is not a claim about the data, which
   * is the kind it is not.
   */
  priority: z.number().min(0).max(1),
});

export type Insight = z.infer<typeof insightSchema>;

/**
 * A nightly batch.
 *
 * Capped at five. §3.2 gives the MVP surface one card and the V2 inbox is not
 * a feed — an inbox that produces five items a night for a year is 1,825 items
 * nobody reads, and §10.6's whole argument is that an untrustworthy insight
 * surface is worse than none.
 */
export const MAX_NIGHTLY_INSIGHTS = 5;

export const insightBatchSchema = z.object({
  insights: z.array(insightSchema).max(MAX_NIGHTLY_INSIGHTS),
});

export type InsightBatch = z.infer<typeof insightBatchSchema>;
