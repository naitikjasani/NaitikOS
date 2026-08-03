/**
 * Rate limiting — §5.14: "Rate limiting: on auth and on AI endpoints, primarily
 * as a spend-control measure."
 *
 * ## What this is for, honestly
 *
 * At n=1 the threat is not a botnet. §5.14's realistic adversaries are a
 * compromised dependency, a provider breach, device theft, and "the operator's
 * own future carelessness". Against those, a rate limit does two useful things
 * and one useless one.
 *
 * Useful: it caps online password guessing against the single known-valid
 * address, and it caps spend on the AI endpoints, which is the stated reason
 * §5.14 lists it at all.
 *
 * Useless: it will not stop a distributed attacker. It is not pretending to.
 *
 * ## Why the store is an interface
 *
 * The default implementation is in-process memory. That is genuinely correct
 * for a single-user application on a single Vercel deployment, and genuinely
 * wrong the moment there are two serverless instances — each keeps its own
 * counter, so the effective limit multiplies by the instance count.
 *
 * Rather than pretend otherwise, the store is a port. Swapping to Postgres or
 * Upstash is one adapter, and {@link MemoryRateLimitStore} documents its own
 * limitation rather than hiding it. §13 would call the current state accepted
 * risk, not a solved problem.
 */

export type RateLimitDecision = {
  readonly allowed: boolean;
  /** Requests still available in the current window. */
  readonly remaining: number;
  /** Seconds until the window resets. Feeds `Retry-After`. */
  readonly retryAfterSeconds: number;
  /** When the window resets, as epoch milliseconds. */
  readonly resetAt: number;
};

export type RateLimitRule = {
  /** Requests permitted per window. */
  readonly limit: number;
  readonly windowMs: number;
};

export type RateLimitStore = {
  /**
   * Record a hit and return the resulting decision.
   *
   * Must be atomic per key. A read-modify-write that races will undercount, and
   * an undercounting rate limiter is a rate limiter that does not work.
   */
  hit(key: string, rule: RateLimitRule, now: number): Promise<RateLimitDecision>;
  /** Clear a key. Called after a *successful* sign-in — see the note below. */
  reset(key: string): Promise<void>;
};

/**
 * The rules.
 *
 * `signIn` is deliberately strict, and the window is long: five attempts per
 * fifteen minutes. There is exactly one valid address and its owner knows the
 * password, so a legitimate user hits five failures only if something is
 * already wrong.
 *
 * `stepUp` is stricter still. It guards export and encryption-key access
 * (§5.4), and the realistic attacker is someone holding an already-unlocked
 * device — the exact scenario where a slow guess would otherwise work.
 *
 * `session` is loose because it is checked on nearly every navigation; it
 * exists to bound a runaway client, not to police the user.
 */
export const RATE_LIMIT_RULES = Object.freeze({
  signIn: { limit: 5, windowMs: 15 * 60 * 1000 },
  stepUp: { limit: 3, windowMs: 15 * 60 * 1000 },
  session: { limit: 120, windowMs: 60 * 1000 },
  passwordReset: { limit: 3, windowMs: 60 * 60 * 1000 },
} as const satisfies Record<string, RateLimitRule>);

export type RateLimitRuleName = keyof typeof RATE_LIMIT_RULES;

type Bucket = { count: number; resetAt: number };

/**
 * In-process fixed-window counter.
 *
 * **Fixed window, not sliding.** A fixed window permits up to 2× the limit
 * across a boundary — five attempts at 14:59 and five more at 15:00. For
 * password guessing at these rates that is irrelevant, and a sliding window
 * costs either a sorted set per key or a second counter. Named here so the
 * choice is visible rather than accidental.
 *
 * **Single-process only.** See the file header. This is correct today and will
 * silently weaken if the deployment ever scales horizontally.
 */
export class MemoryRateLimitStore implements RateLimitStore {
  readonly #buckets = new Map<string, Bucket>();
  /** Bounds memory against key-space flooding. */
  readonly #maxKeys: number;

  constructor(maxKeys = 10_000) {
    this.#maxKeys = maxKeys;
  }

  hit(key: string, rule: RateLimitRule, now: number): Promise<RateLimitDecision> {
    const existing = this.#buckets.get(key);

    if (existing === undefined || now >= existing.resetAt) {
      // Opportunistic sweep. Cheap, and it keeps a long-lived process from
      // accumulating a bucket per key forever.
      if (this.#buckets.size >= this.#maxKeys) this.#sweep(now);

      const resetAt = now + rule.windowMs;
      this.#buckets.set(key, { count: 1, resetAt });
      return Promise.resolve({
        allowed: true,
        remaining: rule.limit - 1,
        retryAfterSeconds: 0,
        resetAt,
      });
    }

    existing.count += 1;
    const allowed = existing.count <= rule.limit;

    return Promise.resolve({
      allowed,
      remaining: Math.max(0, rule.limit - existing.count),
      retryAfterSeconds: allowed ? 0 : (existing.resetAt - now) / 1000,
      resetAt: existing.resetAt,
    });
  }

  reset(key: string): Promise<void> {
    this.#buckets.delete(key);
    return Promise.resolve();
  }

  #sweep(now: number): void {
    for (const [key, bucket] of this.#buckets) {
      if (now >= bucket.resetAt) this.#buckets.delete(key);
    }
    // Still full of live buckets: drop the oldest rather than grow unbounded.
    if (this.#buckets.size >= this.#maxKeys) {
      const oldest = [...this.#buckets.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt);
      for (const [key] of oldest.slice(0, Math.ceil(this.#maxKeys / 10))) {
        this.#buckets.delete(key);
      }
    }
  }
}

/**
 * Build the key a limit is counted against.
 *
 * Both the identifier *and* the rule name, so a sign-in attempt and a step-up
 * attempt from the same client do not share a budget — exhausting one must not
 * lock the other.
 *
 * The identifier is normally a client IP. It is hashed by the caller before it
 * arrives here: §5.11 forbids storing raw addresses, and a rate limiter only
 * needs the key to be stable, not readable.
 */
export function rateLimitKey(rule: RateLimitRuleName, identifier: string): string {
  return `${rule}:${identifier}`;
}

/**
 * Should a successful sign-in clear the counter?
 *
 * Yes, and it is worth being deliberate about it. Not clearing means a user who
 * mistypes four times, succeeds on the fifth, then signs out and back in is
 * locked out — punishing exactly the person the limit exists to protect. An
 * attacker gains nothing, because clearing requires having already succeeded.
 */
export const RESET_ON_SUCCESS = true;
