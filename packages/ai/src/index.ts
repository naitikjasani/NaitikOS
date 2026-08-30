/**
 * @naitikos/ai
 *
 * The AI layer, governed by §10.0:
 *
 *   "The model never computes, discovers, or asserts. It retrieves, explains,
 *    ranks, and drafts."
 *
 * §5.0 places this in the *replaceable* tier. Everything durable — the
 * statistics, the detectors, the domain model — is in `@naitikos/core`, which
 * has no idea this package exists. If the model catalogue changes beyond
 * recognition, this package is rewritten and nothing below it moves.
 *
 * The order below is the order of authority. Schemas first, because §10.10's
 * strongest control is that the harmful output is unrepresentable; guardrails
 * second, because they are what runs when the schemas are not enough.
 */

/* -------------------------------------------------------------------------
 * Schemas — the structural control (§10.10)
 * ---------------------------------------------------------------------- */
export {
  idSchema,
  observationRefSchema,
  statisticRefSchema,
  metricRefSchema,
  entityRefSchema,
  documentRefSchema,
  referenceSchema,
  narrationSchema,
  slotsIn,
  TEMPLATE_FORBIDS_DIGITS,
} from './schemas/references';
export type { Reference, Narration } from './schemas/references';

export {
  INSIGHT_KINDS,
  insightKindSchema,
  provenanceSchema,
  insightSchema,
  insightBatchSchema,
  MAX_NIGHTLY_INSIGHTS,
} from './schemas/insight';
export type { Insight, InsightKind, InsightBatch } from './schemas/insight';

export { RECOMMENDATION_CATEGORIES, recommendationSchema } from './schemas/recommendation';
export type { Recommendation, RecommendationCategory } from './schemas/recommendation';

export {
  consultationQuestionSchema,
  consultationPackSchema,
  MAX_PACK_QUESTIONS,
} from './schemas/consultation';
export type { ConsultationQuestion, ConsultationPack } from './schemas/consultation';

export { QUESTION_KINDS, answerSchema } from './schemas/ask';
export type { Answer, QuestionKind } from './schemas/ask';

/* -------------------------------------------------------------------------
 * Guardrails — the boundary (§10.10)
 * ---------------------------------------------------------------------- */
export {
  CONSENT_SCOPES,
  NO_CONSENT,
  RETRIEVAL_CLASSES,
  CRISIS_PLAN_IS_NEVER_RETRIEVABLE,
  fromStoredScope,
  canRetrieve,
  permittedClasses,
} from './guardrails/consent';
export type { ConsentGrant, ConsentScopeName, RetrievalClass, StoredConsentScope } from './guardrails/consent';

export { PROHIBITIONS, PASSED, scanForProhibited, scanAll } from './guardrails/prohibited';
export type { Prohibition, ProhibitionCategory, BlockVerdict } from './guardrails/prohibited';

export {
  MONTHLY_CAP_MINOR,
  WARN_FRACTION,
  checkBudget,
  estimateCostMinor,
} from './guardrails/budget';
export type { BudgetState, BudgetVerdict } from './guardrails/budget';

export {
  SEVERE_MOOD_MAX,
  SEVERE_ANXIETY_MIN,
  SUSTAINED_DAYS,
  ROUTE_TO_MODEL,
  CRISIS_PLAN_PREFACE,
  routeForReadings,
} from './guardrails/crisis';
export type { CrisisRouting, DayReading } from './guardrails/crisis';

/* -------------------------------------------------------------------------
 * The Context Engine (§10.4) — "the highest-value engineering in the AI layer"
 * ---------------------------------------------------------------------- */
export {
  DEFAULT_QUESTION_KIND,
  RETRIEVAL_PLAN,
  DEFAULT_WINDOW_DAYS,
  classifyQuestion,
  resolveWindowDays,
} from './context/classify';

export type { DailyPoint, SeriesSummary } from './context/summarise';
export { summariseSeries, estimateTokens } from './context/summarise';

export type { ContextItem, RankedItem, ContextPack, AssembleInput, AssembleResult } from './context/assemble';
export { RANK_WEIGHTS, scoreItem, stableBlockProblems, assemble } from './context/assemble';

/* -------------------------------------------------------------------------
 * Routing (§10.11)
 * ---------------------------------------------------------------------- */
export { MODELS, AI_TASKS, ROUTES, PRICING, TASK_PURPOSE } from './client/routing';
export type { AiTask, Effort, ModelId, Pricing, Route } from './client/routing';
