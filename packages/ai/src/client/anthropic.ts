/**
 * The Anthropic adapter — §10.11's API specifics, in one file.
 *
 * Everything vendor-shaped lives here. `invoke.ts` runs the guardrails against
 * the {@link Transport} port and never imports this, which is what makes the
 * whole safety pipeline testable without a key, a network, or a bill.
 *
 * ## The four API facts this design depends on
 *
 * **Adaptive thinking with `effort` as the depth control.** `budget_tokens` is
 * rejected outright on Opus 5 and Sonnet 5, and a fixed thinking budget carried
 * over from an older model is a 400 rather than a degradation.
 *
 * **`max_tokens` bounds thinking *and* response together**, and thinking is on
 * by default on Opus 5. The routing table's ceilings are generous for that
 * reason: a tight limit does not save money — output is billed on what is
 * produced — it truncates, and for a Consultation Pack that means a page of
 * questions that stops halfway and reads like a printer fault.
 *
 * **Sampling parameters do not exist.** No `temperature`, no `top_p`. Any
 * design assuming a temperature knob is invalid, and there is none here.
 *
 * **A refusal arrives on a 200.** §10.11: "Health and body content sits
 * adjacent to categories that occasionally trip safety classifiers, so
 * `stop_reason` is checked before reading content on every call." This is the
 * one failure mode this domain reliably produces, so it is checked first and
 * returned as a value rather than thrown.
 *
 * ## Streaming, and why
 *
 * The routing table gives Ask and the Consultation Pack a 32K–64K ceiling, and
 * the SDK requires streaming at that size to avoid an HTTP timeout. Requests
 * stream and the final message is collected — the surfaces here are not
 * incremental, so nothing consumes the stream events; it exists to keep a long
 * `xhigh` call from dying at the transport layer.
 */

import Anthropic from '@anthropic-ai/sdk';

import type { Transport, TransportRequest, TransportResponse, TokenUsage } from './transport';
import { ZERO_USAGE } from './transport';

/**
 * The cache breakpoint sits between the two blocks, which is the whole point of
 * §10.4's split reaching the wire.
 */
function blocksFor(request: TransportRequest): Anthropic.MessageParam[] {
  return [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: request.stablePrefix,
          /* Everything before this caches. Everything after it is allowed to
           * move, which is why the assembler refuses a prefix containing a
           * timestamp — see `context/assemble.ts`. */
          cache_control: { type: 'ephemeral' },
        },
        { type: 'text', text: request.volatile },
      ],
    },
  ];
}

function usageOf(usage: Anthropic.Usage | undefined): TokenUsage {
  if (usage === undefined) return ZERO_USAGE;
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

export type AnthropicTransportOptions = {
  readonly apiKey: string;
  /** Injectable for tests. Defaults to a client built from the key. */
  readonly client?: Anthropic;
};

export function createAnthropicTransport(options: AnthropicTransportOptions): Transport {
  const client = options.client ?? new Anthropic({ apiKey: options.apiKey });

  return {
    async send(request: TransportRequest): Promise<TransportResponse> {
      try {
        const stream = client.messages.stream({
          model: request.model,
          max_tokens: request.maxTokens,
          messages: blocksFor(request),
          /*
           * Adaptive, always. `display: 'omitted'` is the default on Opus 5 and
           * is what is wanted here: nothing in this system shows the model's
           * reasoning to the operator, and asking for a summary would be paying
           * to render something no surface displays.
           */
          thinking: { type: 'adaptive' },
          output_config: {
            ...(request.effort === null ? {} : { effort: request.effort }),
            /*
             * §10.10's enforcement mechanism. A response that does not match
             * the schema does not arrive — which is stronger than validating
             * one that did, and `invoke.ts` validates anyway because "the API
             * guarantees it" is a claim about someone else's code.
             */
            format: { type: 'json_schema', schema: request.schema },
          },
        });

        const message = await stream.finalMessage();

        /*
         * `stop_reason` before `content`, on every call. §10.11 asks for this
         * specifically, and the reason is that a refusal is a 200: reading
         * content first would produce an empty answer with no explanation and
         * no record of why.
         */
        if (message.stop_reason === 'refusal') {
          return {
            ok: false,
            failure: {
              kind: 'refusal',
              category: message.stop_details?.category ?? null,
            },
            usage: usageOf(message.usage),
          };
        }

        if (message.stop_reason === 'max_tokens') {
          /* Truncated. Reported rather than parsed — half a Consultation Pack
           * is worse than none, because it looks complete. */
          return { ok: false, failure: { kind: 'truncated' }, usage: usageOf(message.usage) };
        }

        const text = message.content
          .filter((block): block is Anthropic.TextBlock => block.type === 'text')
          .map((block) => block.text)
          .join('');

        try {
          return { ok: true, value: JSON.parse(text), usage: usageOf(message.usage), model: message.model };
        } catch {
          return { ok: false, failure: { kind: 'invalid_json' }, usage: usageOf(message.usage) };
        }
      } catch (error: unknown) {
        /*
         * The typed SDK errors, not a string match. The status travels into the
         * ledger so a run of 429s is distinguishable from a run of 400s months
         * later, which is the difference between "we were rate limited" and "we
         * were sending something invalid".
         */
        if (error instanceof Anthropic.APIError) {
          return {
            ok: false,
            failure: { kind: 'transport', status: error.status ?? null, message: error.name },
            usage: null,
          };
        }
        return {
          ok: false,
          failure: {
            kind: 'transport',
            status: null,
            message: error instanceof Error ? error.name : 'unknown',
          },
          usage: null,
        };
      }
    },
  };
}

/**
 * Build a transport from the environment, or the unconfigured one.
 *
 * Returns `null` rather than throwing when no key is present. §2.1 expects
 * modules to sit unused for months; an AI layer with no key is a configuration,
 * not a fault, and every surface in this application works without it.
 */
export function transportFromEnv(apiKey: string | undefined): Transport | null {
  if (apiKey === undefined || apiKey.trim() === '') return null;
  return createAnthropicTransport({ apiKey });
}
