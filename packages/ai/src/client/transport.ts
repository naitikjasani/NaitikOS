/**
 * The model transport, as a port.
 *
 * §5.0 puts this package in the *replaceable* tier, and a port is what makes
 * that concrete: `invoke.ts` — which is where every guardrail runs — depends on
 * this interface and not on a vendor SDK. The consequence that matters is not
 * portability, which nobody needs; it is that **the entire guardrail pipeline is
 * testable without a network, a key, or a bill**, and a safety control that can
 * only be exercised against production is one nobody exercises.
 *
 * The shape is deliberately §10.11's, not a lowest common denominator. `effort`,
 * adaptive thinking and structured outputs are the features the design actually
 * depends on, and an interface that abstracted them away would be abstracting
 * away the enforcement mechanism (§10.10).
 */

import type { Effort, ModelId } from './routing';

export type TransportRequest = {
  readonly model: ModelId;
  /**
   * The cacheable prefix, sent as its own block with the cache breakpoint after
   * it. §10.4's stable/volatile split reaches the wire here or it does not
   * exist.
   */
  readonly stablePrefix: string;
  readonly volatile: string;
  readonly maxTokens: number;
  readonly effort: Effort | null;
  /**
   * A JSON Schema the response must conform to.
   *
   * §10.10: "Every AI output conforms to a schema enforced via structured
   * outputs. Free-form model text never reaches the user unvalidated." This is
   * the enforcement mechanism, not a convenience, so it is required rather than
   * optional — a call with no schema has no way to be checked.
   */
  readonly schema: Record<string, unknown>;
  /** §10.11's 50% batch path. Nothing overnight pays full price. */
  readonly batch: boolean;
};

/**
 * Why a call produced nothing usable.
 *
 * `refusal` is a first-class outcome rather than an error, because §10.11 is
 * explicit that it arrives on a 200: "Health and body content sits adjacent to
 * categories that occasionally trip safety classifiers, so `stop_reason` is
 * checked before reading content on every call." Treating it as an exception
 * would mean the one failure mode this domain reliably produces is the one the
 * code path handles least carefully.
 */
export type TransportFailure =
  | { readonly kind: 'refusal'; readonly category: string | null }
  | { readonly kind: 'invalid_json' }
  | { readonly kind: 'truncated' }
  | { readonly kind: 'transport'; readonly status: number | null; readonly message: string }
  | { readonly kind: 'not_configured' };

export type TokenUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
};

export type TransportResponse =
  | { readonly ok: true; readonly value: unknown; readonly usage: TokenUsage; readonly model: string }
  | { readonly ok: false; readonly failure: TransportFailure; readonly usage: TokenUsage | null };

export type Transport = {
  send(request: TransportRequest): Promise<TransportResponse>;
};

export const ZERO_USAGE: TokenUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

/**
 * The transport used when no API key is configured.
 *
 * Fails closed and says so. §5.16's posture applied to the model layer: an
 * unconfigured AI layer must produce a stated absence rather than a silent one,
 * because every screen in this system works without it and the operator should
 * be told which part is missing rather than left to infer it from prose that
 * never appears.
 */
export const UNCONFIGURED_TRANSPORT: Transport = Object.freeze({
  send: () =>
    Promise.resolve({
      ok: false as const,
      failure: { kind: 'not_configured' as const },
      usage: null,
    }),
});
