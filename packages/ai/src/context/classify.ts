/**
 * Step 1 of §10.4 — classification, and it is deliberately not a model call.
 *
 *   "1. CLASSIFY — What kind of question is this?
 *       (temporal · causal · status · comparative · clinical · reflective)"
 *
 * ## Why a keyword classifier rather than Haiku
 *
 * The classification drives *retrieval*, and retrieval is where §10.10's
 * consent boundary is enforced. A model call here would put a model in the path
 * that decides which data classes get fetched — which is the one place in the
 * architecture where a model must not be, because a misclassification would not
 * be a worse answer, it would be a retrieval the operator did not consent to.
 *
 * It is also the wrong tool. The classes below are distinguished by a handful
 * of interrogatives and tense markers, a rule set fits on a screen, and the
 * whole thing runs in microseconds inside a latency-sensitive path.
 *
 * ## Ambiguity resolves to the *widest* class, not the narrowest
 *
 * A question matching both `causal` and `status` is treated as causal, because
 * causal retrieval is a superset — it pulls the graph neighbourhood as well as
 * the current values. Guessing narrow produces an answer assembled from too
 * little, which reads as confident and is missing the thing that mattered.
 * Guessing wide costs tokens, which the budget step already handles.
 */

import type { QuestionKind } from '../schemas/ask';

/**
 * Ordered by width, widest first.
 *
 * The order *is* the tie-break: the first matching class wins, so a question
 * that looks causal and temporal is treated as causal. Reordering this array
 * changes behaviour, which is why it is a single list rather than a switch
 * spread over sixty lines.
 */
const RULES: readonly { readonly kind: QuestionKind; readonly pattern: RegExp }[] = Object.freeze([
  {
    /* Widest: pulls graph neighbours as well as values. */
    kind: 'causal',
    pattern:
      /\b(?:why|because of|related to|linked to|affect|affects|affected|influence|driving|down to|to do with)\b/iu,
  },
  {
    kind: 'comparative',
    pattern: /\b(?:compared|versus|vs\.?|better|worse|more than|less than|than last|difference between)\b/iu,
  },
  {
    kind: 'temporal',
    pattern: /\b(?:when|since|before|after|during|last (?:week|month|year)|over the (?:last|past)|trend|history)\b/iu,
  },
  {
    kind: 'clinical',
    pattern:
      /\b(?:lab|labs|blood|vitamin|deficien\w*|medication|meds?|dose|prescri\w*|appointment|doctor|symptom|condition|test result)\b/iu,
  },
  {
    kind: 'reflective',
    pattern: /\b(?:how (?:have|am|do) i|feel|feeling|felt|mood|journal|wrote|thinking about|notice)\b/iu,
  },
]);

/**
 * `status` is the fallback, not a match.
 *
 * "What is my protein today" has no interrogative worth pattern-matching, and a
 * question the rules do not recognise is far more often a request for a current
 * value than anything else. It is also the *cheapest* retrieval, which is the
 * right thing to default to when the classifier is guessing.
 */
export const DEFAULT_QUESTION_KIND: QuestionKind = 'status';

export function classifyQuestion(question: string): QuestionKind {
  for (const rule of RULES) {
    if (rule.pattern.test(question)) return rule.kind;
  }
  return DEFAULT_QUESTION_KIND;
}

/**
 * Which retrieval classes each question kind wants.
 *
 * Wants, not gets — {@link import('../guardrails/consent').canRetrieve}
 * intersects this with the operator's grant, and the grant always wins. A
 * clinical question asked without the clinical scope granted retrieves nothing
 * clinical and the answer says so, rather than the request being refused.
 */
export const RETRIEVAL_PLAN = Object.freeze({
  temporal: Object.freeze(['observation', 'aggregate', 'finding'] as const),
  causal: Object.freeze(['observation', 'aggregate', 'finding', 'condition', 'medication', 'symptom'] as const),
  status: Object.freeze(['observation', 'aggregate'] as const),
  comparative: Object.freeze(['observation', 'aggregate', 'finding'] as const),
  clinical: Object.freeze(['condition', 'medication', 'lab', 'symptom', 'appointment', 'document'] as const),
  reflective: Object.freeze(['observation', 'aggregate', 'journal'] as const),
});

/**
 * How far back each kind reads by default, in days.
 *
 * A status question wants today; a causal one wants long enough for a lag to be
 * visible. These are *defaults* — an explicit window in the question overrides
 * them, and {@link resolveWindowDays} is where that happens.
 */
export const DEFAULT_WINDOW_DAYS: Readonly<Record<QuestionKind, number>> = Object.freeze({
  status: 7,
  temporal: 90,
  causal: 90,
  comparative: 180,
  clinical: 365,
  reflective: 30,
});

const EXPLICIT_WINDOW: readonly { readonly pattern: RegExp; readonly days: number }[] = Object.freeze([
  { pattern: /\btoday\b/iu, days: 1 },
  { pattern: /\bthis week\b|\blast (?:seven|7) days\b/iu, days: 7 },
  { pattern: /\blast month\b|\bpast month\b|\blast (?:thirty|30) days\b/iu, days: 30 },
  { pattern: /\blast three months\b|\bpast quarter\b/iu, days: 90 },
  { pattern: /\blast six months\b/iu, days: 180 },
  { pattern: /\blast year\b|\bpast year\b/iu, days: 365 },
  /* Deliberately last, so "last year" is not read as "ever". */
  { pattern: /\bever\b|\ball time\b|\bsince the start\b/iu, days: 3650 },
]);

export function resolveWindowDays(question: string, kind: QuestionKind): number {
  for (const rule of EXPLICIT_WINDOW) {
    if (rule.pattern.test(question)) return rule.days;
  }
  return DEFAULT_WINDOW_DAYS[kind];
}
