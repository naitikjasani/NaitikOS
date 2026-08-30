/**
 * The guardrail pipeline, end to end, against a fake transport.
 *
 * This is the file the `Transport` port exists for. §10.10 calls the guardrails
 * "a hard boundary, not a prompt", and a boundary that could only be exercised
 * against the real API — with a key, a network and a bill — is one nobody would
 * exercise. Every control below is tested by the thing it is supposed to stop
 * actually being stopped.
 *
 * The ordering assertions matter as much as the controls. A budget checked
 * after the call is a cap that is exceeded once a month forever; a scan run
 * before the schema is a scan over an unvalidated shape.
 */

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { NO_CONSENT, fromStoredScope } from '../guardrails/consent';
import { MONTHLY_CAP_MINOR } from '../guardrails/budget';
import { ROUTE_TO_MODEL } from '../guardrails/crisis';
import type { ContextPack } from '../context/assemble';
import { invoke } from './invoke';
import type { Transport, TransportResponse } from './transport';
import { UNCONFIGURED_TRANSPORT, ZERO_USAGE } from './transport';

const SCHEMA = z.object({ headline: z.string(), limitation: z.string() });
const JSON_SCHEMA = { type: 'object' } as const;

const PACK: ContextPack = {
  stable: 'Profile: vegetarian plus eggs.',
  volatile: 'Question: how has my sleep been',
  included: [],
  droppedIds: [],
  omitted: 'Nothing was omitted.',
  estimatedTokens: 40,
  refusedClasses: [],
};

const USAGE = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 };

function transportReturning(response: TransportResponse): Transport & { readonly calls: { count: number } } {
  const calls = { count: 0 };
  return {
    calls,
    send: () => {
      calls.count += 1;
      return Promise.resolve(response);
    },
  };
}

const GOOD: TransportResponse = {
  ok: true,
  value: { headline: 'Sleep and mood moved together.', limitation: 'This is an association, not a cause.' },
  usage: USAGE,
  model: 'claude-opus-5',
};

function run(overrides: Partial<Parameters<typeof invoke<z.infer<typeof SCHEMA>>>[0]> = {}) {
  return invoke({
    task: 'narrate_insight' as const,
    pack: PACK,
    schema: SCHEMA,
    jsonSchema: JSON_SCHEMA,
    transport: transportReturning(GOOD),
    grant: fromStoredScope('clinical'),
    crisis: ROUTE_TO_MODEL,
    spentMinor: 0,
    proseOf: (value) => [value.headline, value.limitation],
    nowMillis: () => 1_000,
    ...overrides,
  });
}

describe('invoke', () => {
  it('passes a well-formed response through and records it', async () => {
    const outcome = await run();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.record.succeeded).toBe(true);
    expect(outcome.record.costMinor).toBeGreaterThanOrEqual(0);
  });

  it('never reaches the transport in a crisis', async () => {
    /*
     * §4.7 permits exactly one behaviour, and it is not a model call. This is
     * checked first because every later step is irrelevant if the answer is
     * "show the stored plan" — and because someone in crisis should not receive
     * a cheerful narration about their protein intake.
     */
    const transport = transportReturning(GOOD);
    const outcome = await run({ transport, crisis: { route: 'crisis_plan', dayKeys: ['2026-12-01'] } });

    expect(outcome.ok).toBe(false);
    expect(transport.calls.count).toBe(0);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('crisis');
    /* No ledger row either. A record timestamped to the worst evening of
     * someone's year, noting that the system noticed, is not something this
     * design wants to create. */
    expect(outcome.record).toBeNull();
  });

  it('never reaches the transport with no consent granted', async () => {
    const transport = transportReturning(GOOD);
    const outcome = await run({ transport, grant: NO_CONSENT });

    expect(transport.calls.count).toBe(0);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('no_consent');
  });

  it('checks the budget before the call, not after', async () => {
    /*
     * §10.11: "enforced before the call". A cap checked afterwards is exceeded
     * by exactly one call every month, forever — and given the routing table
     * that call is the Opus one.
     */
    const transport = transportReturning(GOOD);
    const outcome = await run({ transport, spentMinor: MONTHLY_CAP_MINOR });

    expect(transport.calls.count).toBe(0);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('budget_exhausted');
    /* Recorded, unlike the crisis case: a call that did not happen because of a
     * cap is exactly what someone reading the ledger wants to find. */
    expect(outcome.record?.blockedReason).toBe('budget_exhausted');
  });

  it('estimates against the output ceiling rather than a guess', async () => {
    /* An estimate assuming a short answer would let a long one cross the cap,
     * and the cap is the thing being protected. */
    const justUnder = await run({ spentMinor: 0 });
    expect(justUnder.ok).toBe(true);

    const nearCap = await run({ spentMinor: MONTHLY_CAP_MINOR - 1 });
    expect(nearCap.ok).toBe(false);
  });

  it('treats a refusal as a value, not an exception', async () => {
    /*
     * §10.11: a refusal arrives on a 200. Health and body content sits adjacent
     * to categories that occasionally trip safety classifiers, so this is the
     * failure mode this domain reliably produces — and it must not be the one
     * the code path handles least carefully.
     */
    const outcome = await run({
      transport: transportReturning({
        ok: false,
        failure: { kind: 'refusal', category: 'bio' },
        usage: USAGE,
      }),
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('refusal');
    expect(outcome.record?.blockedReason).toBe('refusal');
    /* The tokens were still spent, so they are still recorded. */
    expect(outcome.record?.usage.inputTokens).toBe(1000);
  });

  it('discards the whole output when the scan blocks any part of it', async () => {
    /*
     * §10.10: "blocks rather than sanitises." A paragraph is written *around*
     * its clauses — stripping "you should stop taking it" leaves prose that
     * reads as agreement with whatever preceded it.
     */
    const outcome = await run({
      transport: transportReturning({
        ok: true,
        value: {
          headline: 'Sleep and mood moved together.',
          limitation: 'You should stop taking your medication and see.',
        },
        usage: USAGE,
        model: 'claude-opus-5',
      }),
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('blocked');
    /* §10.10 makes a block a defect that drives an eval case, so the specific
     * prohibition is recorded rather than a generic flag. */
    expect(outcome.record?.blockedReason).toContain('discontinuation');
  });

  it('rejects an output that does not match the schema, even though the API should prevent it', async () => {
    /* "The API guarantees it" is a claim about someone else's code. */
    const outcome = await run({
      transport: transportReturning({ ok: true, value: { nope: true }, usage: USAGE, model: 'claude-opus-5' }),
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('invalid_output');
  });

  it('reports a truncated response rather than parsing half of it', async () => {
    const outcome = await run({
      transport: transportReturning({ ok: false, failure: { kind: 'truncated' }, usage: USAGE }),
    });
    if (outcome.ok) return;
    expect(outcome.sentence).toContain('cut off');
  });

  it('says what still works, on every failure', async () => {
    /*
     * §13.1 lists abandonment as the fatal risk, and nothing in this
     * application computes a number with a model. A failure message that read
     * like a broken record would make a cosmetic failure look structural.
     */
    for (const transport of [
      UNCONFIGURED_TRANSPORT,
      transportReturning({ ok: false, failure: { kind: 'transport', status: 500, message: 'x' }, usage: null }),
    ]) {
      const outcome = await run({ transport });
      if (outcome.ok) return;
      expect(outcome.sentence).toContain('without');
    }
  });

  it('records latency from a clock it is handed, never from a global one', async () => {
    /* §11.3 keeps raw time behind one door. A `Date.now()` in here would be
     * both a lint violation and an untestable duration. */
    const clock = vi.fn<() => number>().mockReturnValueOnce(1_000).mockReturnValueOnce(1_450);
    const outcome = await run({ nowMillis: clock });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.record.latencyMs).toBe(450);
  });

  it('reports an unconfigured layer as a configuration, not a fault', async () => {
    const outcome = await run({ transport: UNCONFIGURED_TRANSPORT });
    if (outcome.ok) return;
    expect(outcome.reason).toBe('not_configured');
    expect(outcome.record?.usage).toEqual(ZERO_USAGE);
  });
});
