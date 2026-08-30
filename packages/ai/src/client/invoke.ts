/**
 * The one path every model call takes — §10.10's "hard boundary, not a prompt".
 *
 * Nothing in this package calls a transport directly. {@link invoke} is the
 * boundary, and it runs, in order:
 *
 *  1. **Crisis routing.** §4.7 permits exactly one behaviour in that moment,
 *     and it is not a model call. Checked first, because every later step is
 *     irrelevant if the answer is "show the stored plan".
 *  2. **Consent.** §10.10 gates at retrieval; this is the second check, on the
 *     assembled pack, because this function is the last place before the wire.
 *  3. **Budget.** §10.11: "enforced **before the call**." A cap checked
 *     afterwards is exceeded by exactly one call a month, forever, and given
 *     the routing table that call is the Opus one.
 *  4. The call.
 *  5. **Schema validation.** §10.10: free-form model text never reaches the
 *     user unvalidated.
 *  6. **Prohibited-pattern scan.** Blocks the whole output, never sanitises.
 *  7. **The ledger.** §9.2: "complete auditability of everything the AI layer
 *     has ever done is a requirement, not a nicety" — written for every
 *     outcome, including the blocked and refused ones, because those are the
 *     records anyone investigating would actually want.
 *
 * The ordering is the design. Moving the budget check after the call, or the
 * scan before the schema, each turns a control into a formality.
 */

import type { ZodType } from 'zod';

import { checkBudget, estimateCostMinor } from '../guardrails/budget';
import type { BudgetVerdict } from '../guardrails/budget';
import type { ConsentGrant } from '../guardrails/consent';
import { scanAll } from '../guardrails/prohibited';
import type { BlockVerdict } from '../guardrails/prohibited';
import type { CrisisRouting } from '../guardrails/crisis';
import type { ContextPack } from '../context/assemble';
import { estimateTokens } from '../context/summarise';
import { ROUTES, TASK_PURPOSE } from './routing';
import type { AiTask } from './routing';
import type { Transport, TokenUsage } from './transport';
import { ZERO_USAGE } from './transport';

/**
 * What a call is recorded as, whatever happened.
 *
 * One shape for success, refusal, block and budget-exhaustion, because
 * `ai_interaction` has one row per attempt and an investigation months later
 * needs the failures more than the successes.
 */
export type InteractionRecord = {
  readonly purpose: string;
  readonly model: string;
  readonly usage: TokenUsage;
  readonly costMinor: number;
  readonly latencyMs: number;
  readonly succeeded: boolean;
  /** Set when the guardrail layer refused. §10.10 makes this a defect signal. */
  readonly blockedReason: string | null;
  readonly errorCode: string | null;
};

/** Why a call produced nothing usable, as the surface sees it. */
export type InvokeFailureReason =
  | 'crisis'
  | 'no_consent'
  | 'budget_exhausted'
  | 'refusal'
  | 'blocked'
  | 'invalid_output'
  | 'not_configured'
  | 'transport';

export type InvokeOutcome<T> =
  | { readonly ok: true; readonly value: T; readonly record: InteractionRecord }
  | {
      readonly ok: false;
      readonly reason: InvokeFailureReason;
      /** What the operator is told. Never a stack trace, never a category code. */
      readonly sentence: string;
      readonly record: InteractionRecord | null;
    };

export type InvokeInput<T> = {
  readonly task: AiTask;
  readonly pack: ContextPack;
  readonly schema: ZodType<T>;
  /** The JSON Schema sent to the API. Structured outputs need the raw form. */
  readonly jsonSchema: Record<string, unknown>;
  readonly transport: Transport;
  readonly grant: ConsentGrant;
  readonly crisis: CrisisRouting;
  /** Cents already spent this calendar month, read from `ai_interaction`. */
  readonly spentMinor: number;
  /** Free-text fields of the parsed output, for step 6. See {@link scanAll}. */
  readonly proseOf: (value: T) => readonly string[];
  readonly nowMillis: () => number;
};

export async function invoke<T>(input: InvokeInput<T>): Promise<InvokeOutcome<T>> {
  const route = ROUTES[input.task];
  const purpose = TASK_PURPOSE[input.task];
  const startedAt = input.nowMillis();

  /* --- 1. Crisis ---------------------------------------------------- */
  if (input.crisis.route === 'crisis_plan') {
    /*
     * No record is written, and that is deliberate. §4.7 permits one behaviour
     * and no model call happened, so there is no interaction to audit — and a
     * row in `ai_interaction` timestamped to the worst evening of someone's
     * year, recording that the system noticed, is not something this design
     * wants to create.
     */
    return {
      ok: false,
      reason: 'crisis',
      sentence: 'Showing your own crisis plan instead.',
      record: null,
    };
  }

  /* --- 2. Consent --------------------------------------------------- */
  if (!Object.values(input.grant).some(Boolean)) {
    return {
      ok: false,
      reason: 'no_consent',
      sentence:
        'No data class is shared with the model, so there is nothing to answer from. Every number in the app is computed without one and is unaffected.',
      record: null,
    };
  }

  /* --- 3. Budget, before the call ----------------------------------- */
  const estimatedInput = estimateTokens(input.pack.stable) + estimateTokens(input.pack.volatile);
  const estimatedMinor = estimateCostMinor({
    task: input.task,
    inputTokens: estimatedInput,
    /* The ceiling, not a guess. An estimate that assumed a short answer would
     * let a long one cross the cap, and the cap is the thing being protected. */
    outputTokens: route.maxTokens,
    batch: route.batch,
  });

  const budget: BudgetVerdict = checkBudget({ spentMinor: input.spentMinor, estimatedMinor });
  if (!budget.allowed) {
    return {
      ok: false,
      reason: 'budget_exhausted',
      sentence: budget.sentence,
      record: {
        purpose,
        model: route.model,
        usage: ZERO_USAGE,
        costMinor: 0,
        latencyMs: 0,
        succeeded: false,
        blockedReason: 'budget_exhausted',
        errorCode: null,
      },
    };
  }

  /* --- 4. The call --------------------------------------------------- */
  const response = await input.transport.send({
    model: route.model,
    stablePrefix: input.pack.stable,
    volatile: input.pack.volatile,
    maxTokens: route.maxTokens,
    effort: route.effort,
    schema: input.jsonSchema,
    batch: route.batch,
  });

  const usage = response.usage ?? ZERO_USAGE;
  const latencyMs = input.nowMillis() - startedAt;
  const costMinor = estimateCostMinor({
    task: input.task,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    batch: route.batch,
  });

  const base = { purpose, model: route.model, usage, costMinor, latencyMs };

  if (!response.ok) {
    return {
      ok: false,
      reason: response.failure.kind === 'not_configured' ? 'not_configured' : failureReason(response.failure.kind),
      sentence: sentenceFor(response.failure.kind),
      record: {
        ...base,
        succeeded: false,
        blockedReason: response.failure.kind === 'refusal' ? 'refusal' : null,
        errorCode: response.failure.kind,
      },
    };
  }

  /* --- 5. Schema ----------------------------------------------------- */
  const parsed = input.schema.safeParse(response.value);
  if (!parsed.success) {
    /*
     * Structured outputs should make this unreachable. It is checked anyway,
     * because §10.10's claim is that free-form model text never reaches the
     * user *unvalidated* — and "the API guarantees it" is a claim about someone
     * else's code.
     */
    return {
      ok: false,
      reason: 'invalid_output',
      sentence: 'The model returned something that did not match the expected shape. Nothing was shown.',
      record: { ...base, succeeded: false, blockedReason: 'schema_violation', errorCode: 'schema_violation' },
    };
  }

  /* --- 6. The scan --------------------------------------------------- */
  const verdict: BlockVerdict = scanAll(input.proseOf(parsed.data));
  if (verdict.blocked) {
    /*
     * The whole output is discarded. §10.10: "blocks rather than sanitises."
     * The block is recorded as a defect against the prompt rather than
     * swallowed — §10.10 makes it a source of eval cases.
     */
    return {
      ok: false,
      reason: 'blocked',
      sentence: 'The response contained something this system will not show, so none of it was shown.',
      record: {
        ...base,
        succeeded: false,
        blockedReason: verdict.prohibitionId,
        errorCode: verdict.category,
      },
    };
  }

  return {
    ok: true,
    value: parsed.data,
    record: { ...base, succeeded: true, blockedReason: null, errorCode: null },
  };
}

function failureReason(kind: string): InvokeFailureReason {
  return kind === 'refusal' ? 'refusal' : kind === 'invalid_json' || kind === 'truncated' ? 'invalid_output' : 'transport';
}

/**
 * What the operator reads.
 *
 * Every one of these says what still works, because it does. Nothing in this
 * application computes a number with a model, so a failed call costs prose and
 * nothing else — and a message that did not say so would make a cosmetic
 * failure look like a broken record.
 */
function sentenceFor(kind: string): string {
  switch (kind) {
    case 'not_configured':
      return 'No model is configured, so there is no narration. Every figure in the app is computed without one.';
    case 'refusal':
      return 'The model declined to answer this one. Nothing was shown, and nothing in your record changed.';
    case 'truncated':
      return 'The answer was cut off before it finished, so none of it was shown.';
    case 'invalid_json':
      return 'The model returned something unreadable. Nothing was shown.';
    default:
      return 'The model could not be reached. Every figure in the app is computed without one and is unaffected.';
  }
}
