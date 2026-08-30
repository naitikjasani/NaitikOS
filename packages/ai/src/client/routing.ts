/**
 * Model routing — §10.11.
 *
 *   "**Routing by task, not by preference.**"
 *
 * The table below is §10.11's, transcribed. It is data rather than a series of
 * `if` statements because the routing decision is a *policy* — it should be
 * readable in one screen and diffable when the catalogue changes, not spread
 * across the call sites that happen to need it.
 *
 * ## Two API facts this design depends on, recorded where they bite
 *
 * **`max_tokens` bounds thinking plus response together on Opus 5**, where
 * thinking is on by default. A limit carried over from a non-thinking model
 * truncates mid-answer — which for a Consultation Pack means a page of
 * questions that stops halfway and looks like a bug in the printer.
 *
 * **Sampling parameters are unavailable** on Opus 5 and Sonnet 5. Depth is
 * steered by `output_config.effort`, and any design assuming a temperature knob
 * is invalid. That is why `effort` is on this table and `temperature` is
 * nowhere in this package.
 */

/** The catalogue, as of the blueprint's date. */
export const MODELS = Object.freeze({
  opus: 'claude-opus-5',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5',
} as const);

export type ModelId = (typeof MODELS)[keyof typeof MODELS];

/** `output_config.effort`. Not a temperature, and not a synonym for one. */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh';

/** §10.11's task list, closed. A task not on it has no routing decision yet. */
export const AI_TASKS = Object.freeze([
  'parse_meal',
  'classify_journal',
  'extract_lab',
  'narrate_insight',
  'draft_weekly_review',
  'ask',
  'consultation_pack',
  'monthly_review',
] as const);

export type AiTask = (typeof AI_TASKS)[number];

export type Route = {
  readonly model: ModelId;
  readonly effort: Effort | null;
  /**
   * `max_tokens`, generous where thinking is on.
   *
   * See the note above: on Opus 5 this bounds thinking *and* response, so the
   * Ask and pack routes carry room for both. A tight number here does not save
   * money — output is billed on what is produced, not on the ceiling — it only
   * truncates.
   */
  readonly maxTokens: number;
  /** Whether this runs in the nightly batch, at §10.11's 50%. */
  readonly batch: boolean;
  /** §10.11's stated reason, kept beside the decision it justifies. */
  readonly why: string;
};

export const ROUTES: Readonly<Record<AiTask, Route>> = Object.freeze({
  parse_meal: {
    model: MODELS.haiku,
    effort: null,
    maxTokens: 2_000,
    batch: false,
    why: 'High volume, narrow, latency-sensitive, in the P1 capture path. The deterministic parser sits underneath it and is the offline fallback.',
  },
  classify_journal: {
    model: MODELS.haiku,
    effort: null,
    maxTokens: 2_000,
    batch: true,
    why: 'Bounded classification.',
  },
  extract_lab: {
    model: MODELS.sonnet,
    effort: 'medium',
    maxTokens: 8_000,
    batch: true,
    why: 'Accuracy matters; runs in batch.',
  },
  narrate_insight: {
    model: MODELS.sonnet,
    effort: 'medium',
    maxTokens: 8_000,
    batch: true,
    why: 'Quality prose over structured findings. The findings themselves are the detector battery’s; the model adds no data.',
  },
  draft_weekly_review: {
    model: MODELS.sonnet,
    effort: 'high',
    maxTokens: 16_000,
    batch: true,
    why: 'Longer synthesis, still bounded.',
  },
  ask: {
    model: MODELS.opus,
    effort: 'high',
    maxTokens: 32_000,
    batch: false,
    why: 'Multi-hop reasoning over the graph; the surface where quality is most visible. Also the one place prompt caching earns its keep (§10.11) — several turns within minutes share a profile prefix.',
  },
  consultation_pack: {
    model: MODELS.opus,
    effort: 'xhigh',
    maxTokens: 64_000,
    batch: false,
    why: 'Highest stakes output in the system.',
  },
  monthly_review: {
    model: MODELS.opus,
    effort: 'xhigh',
    maxTokens: 64_000,
    batch: true,
    why: 'Runs twelve times a year; cost is irrelevant, quality is not.',
  },
});

/** Dollars per million tokens, per §10.11's table. */
export type Pricing = { readonly inputPerMTok: number; readonly outputPerMTok: number };

const MODEL_PRICING: Readonly<Record<ModelId, Pricing>> = Object.freeze({
  'claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25 },
  /* The blueprint records an introductory $2/$10 through 2026-08-31. The list
   * price is used here deliberately: an estimate that assumed a promotion which
   * expires makes the cap under-enforce the day after it ends, and the failure
   * mode of this file is a bill. */
  'claude-sonnet-5': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },
});

export const PRICING: Readonly<Record<AiTask, Pricing>> = Object.freeze(
  Object.fromEntries(AI_TASKS.map((task) => [task, MODEL_PRICING[ROUTES[task].model]])) as Record<AiTask, Pricing>,
);

/** Which `ai_purpose` a task records against, for `ai_interaction`. */
export const TASK_PURPOSE = Object.freeze({
  parse_meal: 'parsing',
  classify_journal: 'classification',
  extract_lab: 'extraction',
  narrate_insight: 'narration',
  draft_weekly_review: 'review_draft',
  ask: 'ask',
  consultation_pack: 'ask',
  monthly_review: 'review_draft',
} as const satisfies Readonly<Record<AiTask, string>>);
