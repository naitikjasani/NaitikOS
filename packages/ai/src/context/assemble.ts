/**
 * Steps 4–6 of §10.4 — rank, budget, assemble.
 *
 * ## The stable/volatile split, and the failure it prevents
 *
 *   "The stable/volatile split is a first-class design concern, not an
 *    optimisation afterthought. The prefix is **byte-identical across calls** so
 *    it caches; anything time-varying — timestamps, the question itself,
 *    retrieved rows — sits strictly after the cache boundary. **A `new Date()`
 *    interpolated into the profile block would silently destroy cache hits
 *    across every request in the system**, which is the classic way this goes
 *    wrong."
 *
 * Silently is the operative word. A destroyed cache does not error, does not
 * slow anything perceptibly, and shows up only as a bill. So {@link assemble}
 * does not merely *arrange* the two blocks — it checks the stable one for
 * anything that varies, and refuses to build a pack whose prefix would not
 * cache. `stableBlockProblems` is that check.
 *
 * ## Never silently truncate
 *
 *   "5. BUDGET — Fit to the token budget. Prefer structured summaries over raw
 *       rows. **Never silently truncate — state what was omitted.**"
 *
 * {@link ContextPack.omitted} is a required field carrying prose, and the Ask
 * schema requires the model to pass it through to the operator. A pack that
 * dropped its lowest-ranked section without saying so would produce an answer
 * that reads complete and is not, which is worse than no answer.
 */

import type { ConsentGrant, RetrievalClass } from '../guardrails/consent';
import { canRetrieve } from '../guardrails/consent';
import { estimateTokens } from './summarise';

/**
 * A retrieved thing, ready to rank.
 *
 * `text` is what reaches the model; `references` are the ids the application
 * will resolve when rendering the answer. Both travel together so a pack cannot
 * contain a claim whose evidence was budgeted away.
 */
export type ContextItem = {
  readonly id: string;
  readonly retrievalClass: RetrievalClass;
  readonly text: string;
  /** §10.4's RANK inputs, 0–1 each. */
  readonly recency: number;
  readonly relevance: number;
  readonly strength: number;
  /** The operator marked this important. Beats everything else. */
  readonly pinned?: boolean;
};

export type RankedItem = ContextItem & { readonly score: number; readonly tokens: number };

/**
 * §10.4's RANK: "Recency · relevance · statistical strength · user-marked
 * importance".
 *
 * Weighted rather than lexicographic. Lexicographic ordering on recency would
 * put yesterday's irrelevant note above a strongly-relevant finding from March,
 * which for a causal question is exactly backwards.
 *
 * User-marked importance is not a weight; it is a **short-circuit**. Something
 * the operator pinned is in the pack, and no combination of the other three can
 * push it out. That asymmetry is deliberate: the other three are the system's
 * guesses about what matters, and the pin is the operator telling it.
 */
export const RANK_WEIGHTS = Object.freeze({ recency: 0.3, relevance: 0.45, strength: 0.25 });

export function scoreItem(item: ContextItem): number {
  return (
    clamp01(item.recency) * RANK_WEIGHTS.recency +
    clamp01(item.relevance) * RANK_WEIGHTS.relevance +
    clamp01(item.strength) * RANK_WEIGHTS.strength
  );
}

/**
 * The assembled pack.
 *
 * `stable` and `volatile` are separate strings rather than one document,
 * because the caller sends them as separate content blocks with the cache
 * breakpoint between them. Joining them here would make the boundary a
 * convention rather than a structure.
 */
export type ContextPack = {
  /** Cacheable. Byte-identical across calls, or {@link assemble} refuses. */
  readonly stable: string;
  readonly volatile: string;
  readonly included: readonly RankedItem[];
  readonly droppedIds: readonly string[];
  /** Never empty. "Nothing was omitted" is a claim, made explicitly. */
  readonly omitted: string;
  readonly estimatedTokens: number;
  /** Classes the grant refused, so the answer can say what it could not see. */
  readonly refusedClasses: readonly RetrievalClass[];
};

export type AssembleInput = {
  /** Profile, clinical context, active medications, semantic memory, protocols. */
  readonly stableBlocks: readonly string[];
  readonly items: readonly ContextItem[];
  readonly question: string;
  readonly grant: ConsentGrant;
  readonly tokenBudget: number;
};

export type AssembleResult =
  | { readonly ok: true; readonly pack: ContextPack }
  | { readonly ok: false; readonly problems: readonly string[] };

/**
 * Patterns that must never appear in the stable prefix.
 *
 * Each one is something that changes between two calls a minute apart, which
 * makes the prefix a cache miss every time. They are checked rather than
 * documented because the failure is invisible — §10.4 says so in as many words.
 */
const VOLATILE_IN_STABLE: readonly { readonly pattern: RegExp; readonly what: string }[] = Object.freeze([
  { pattern: /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/u, what: 'a timestamp' },
  { pattern: /\b(?:today|right now|as of now|currently at)\b/iu, what: 'a relative time reference' },
  { pattern: /\b\d{2}:\d{2}(?::\d{2})?\b/u, what: 'a clock time' },
]);

/** What is wrong with a proposed stable block, if anything. */
export function stableBlockProblems(block: string): readonly string[] {
  return VOLATILE_IN_STABLE.filter((rule) => rule.pattern.test(block)).map(
    (rule) =>
      `The stable prefix contains ${rule.what}. §10.4: anything time-varying sits strictly after the cache boundary — a prefix that moves is a cache miss on every call, and it fails silently as a bill rather than as an error.`,
  );
}

export function assemble(input: AssembleInput): AssembleResult {
  const problems = input.stableBlocks.flatMap(stableBlockProblems);
  if (problems.length > 0) return { ok: false, problems };

  const stable = input.stableBlocks.join('\n\n');
  const stableTokens = estimateTokens(stable);

  /*
   * Consent is applied here as a second line, and the Context Engine's
   * retrieval is the first. §10.10 requires the gate at retrieval "so there is
   * no path by which a prompt-construction bug leaks it" — this filter exists
   * because *this file is the prompt construction*, and a defence that only
   * lives upstream is one refactor from being gone.
   */
  const refusedClasses = new Set<RetrievalClass>();
  const permitted = input.items.filter((item) => {
    if (canRetrieve(input.grant, item.retrievalClass)) return true;
    refusedClasses.add(item.retrievalClass);
    return false;
  });

  const ranked: RankedItem[] = permitted
    .map((item) => ({ ...item, score: scoreItem(item), tokens: estimateTokens(item.text) }))
    .sort((a, b) => {
      /* The pin short-circuits. See RANK_WEIGHTS. */
      const pinDelta = Number(b.pinned ?? false) - Number(a.pinned ?? false);
      return pinDelta !== 0 ? pinDelta : b.score - a.score;
    });

  const included: RankedItem[] = [];
  const dropped: RankedItem[] = [];

  let used = stableTokens + estimateTokens(input.question);

  for (const item of ranked) {
    /*
     * A pinned item is admitted even if it takes the pack over budget. The
     * alternative is dropping something the operator explicitly marked because
     * an estimate said so, and the estimate is four-characters-per-token.
     */
    if (item.pinned === true || used + item.tokens <= input.tokenBudget) {
      included.push(item);
      used += item.tokens;
      continue;
    }
    dropped.push(item);
  }

  return {
    ok: true,
    pack: {
      stable,
      volatile: [...included.map((item) => item.text), '', `Question: ${input.question}`].join('\n'),
      included,
      droppedIds: dropped.map((item) => item.id),
      omitted: omissionSentence(dropped, [...refusedClasses]),
      estimatedTokens: used,
      refusedClasses: [...refusedClasses].sort((a, b) => a.localeCompare(b)),
    },
  };
}

/**
 * What the pack does not contain, in words the operator will read.
 *
 * Two different absences, reported differently. Something **dropped for budget**
 * is a limitation of this answer; something **refused by consent** is a choice
 * the operator made and can unmake, so it names the setting rather than
 * apologising. Collapsing them into one sentence would hide the second, which
 * is the actionable one.
 */
function omissionSentence(dropped: readonly RankedItem[], refused: readonly RetrievalClass[]): string {
  const parts: string[] = [];

  if (dropped.length > 0) {
    parts.push(
      `${String(dropped.length)} lower-ranked ${dropped.length === 1 ? 'item was' : 'items were'} left out to fit the context budget.`,
    );
  }

  if (refused.length > 0) {
    parts.push(
      `${refused.join(', ')} data was not read at all, because that consent scope is off in settings.`,
    );
  }

  return parts.length === 0 ? 'Nothing was omitted.' : parts.join(' ');
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
