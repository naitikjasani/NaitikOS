/**
 * The Consultation Pack schema — §10.7, and V2's highest-value deliverable.
 *
 *   "The questions are model-drafted from detector output and the user's own
 *    record, then user-edited. They are framed as **questions, always** — *'my
 *    Vitamin D was 18 ng/mL in March and I've been supplementing since; should
 *    we retest?'* This is P5 as a deliverable rather than a disclaimer: the
 *    system's clinical output is a better conversation with a qualified human."
 *
 * ## The question mark is enforced, not requested
 *
 * `question` must end in `?`. That looks like a trivial validation and it is
 * the whole safety model of this artifact: a sentence framed as a question is
 * something the operator asks their doctor, and the same sentence framed as a
 * statement is the system making a clinical claim. There is no prompt wording
 * that guarantees the first; a schema does.
 *
 * ## The model drafts the question and none of the numbers
 *
 * "18 ng/mL in March" is two references. The application renders both from the
 * lab row, so a pack printed in June and reprinted in July after a correction
 * shows the corrected figure — and a model that hallucinated a value could not
 * have got it onto the page.
 */

import { z } from 'zod';

import { idSchema, narrationSchema } from './references';

/**
 * A drafted question.
 *
 * `rationale` is for the operator deciding whether to keep it, not for the
 * clinician — it is why the system thought this was worth asking, and it is
 * shown while editing and printed nowhere.
 */
export const consultationQuestionSchema = z.object({
  /** Stable across regeneration, so an edited question is not resurrected. */
  id: z.string().min(1).max(120),

  /**
   * The question itself, as narration.
   *
   * Digits refused by `narrationSchema`; the `?` enforced here. Both checks are
   * on the template rather than on the rendered string, because rendering
   * happens after validation and a check that runs after the guardrail is not a
   * guardrail.
   */
  question: narrationSchema.refine(
    (value) => value.template.trimEnd().endsWith('?'),
    'A pack item must be framed as a question (§10.7). A statement here would be the system making a clinical claim rather than starting a conversation.',
  ),

  rationale: z.string().min(10).max(400),

  /**
   * Where this came from. A question with no basis in the record is one the
   * model invented, and this field is what makes that detectable.
   */
  basis: z.array(idSchema).min(1).max(20),
});

export type ConsultationQuestion = z.infer<typeof consultationQuestionSchema>;

/**
 * How many questions a pack carries.
 *
 * Eight, the same cap `deriveQuestions` uses for an appointment. A
 * consultation is ten minutes and a list of twenty questions is a list nobody
 * gets through — the cap is what forces the ranking to mean something.
 */
export const MAX_PACK_QUESTIONS = 8;

/**
 * The narrated sections of the pack.
 *
 * Every *fact* in a pack — the medications, the labs, the symptom timeline — is
 * rendered by the application from the record. What the model contributes is
 * the connective prose and the questions. So this schema carries summaries and
 * questions, and carries no clinical content of its own.
 */
export const consultationPackSchema = z.object({
  /** The specialty and window this was assembled for. Echoed back, not chosen. */
  packId: idSchema,

  /**
   * A paragraph orienting the clinician. Digits refused.
   *
   * This is the one place the model writes continuous prose in the whole
   * system's clinical output, and it is bounded to a paragraph for that reason.
   */
  summary: narrationSchema,

  questions: z.array(consultationQuestionSchema).max(MAX_PACK_QUESTIONS),

  /**
   * What the pack does not contain — §10.6's limitation field, at document
   * scale.
   *
   * A pack is assembled from one person's self-recorded data over a chosen
   * window. Saying so on the page is what stops it being read as a medical
   * record.
   */
  limitation: z.string().min(20).max(600),
});

export type ConsultationPack = z.infer<typeof consultationPackSchema>;
