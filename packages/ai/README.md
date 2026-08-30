# @naitikos/ai

The AI layer. §5.0 puts this in the **replaceable** tier — everything durable
(statistics, detectors, the domain model) lives in `@naitikos/core`, which does
not know this package exists.

## The one rule

> §10.0 — **The model never computes, discovers, or asserts. It retrieves,
> explains, ranks, and drafts.**

Enforced structurally, not by prompt. A prompt saying "don't make up numbers" is
a hope; an architecture where the model is never given the opportunity is a
guarantee.

## Reading order

`schemas/` first, then `guardrails/`. That is the order of authority:

1. **`schemas/`** — §10.10's strongest control. No insight field can express a
   diagnosis, a dose, or a treatment change. Narration prose cannot contain
   digits at all; every figure is a `Reference` the application resolves against
   the database. A model that wanted to assert a lab value has nowhere to put it.
2. **`guardrails/`** — what runs when the schemas are not enough.
   - `consent.ts` — retrieval-time gating. A scope that is off means the class
     is never fetched, so no prompt-assembly bug can leak it.
   - `prohibited.ts` — post-generation scan. **Blocks, never sanitises**: a
     partially-redacted clinical instruction is more dangerous than a whole one,
     because it has lost the context that made it obviously wrong.
   - `crisis.ts` — a veto over the whole layer. Deliberately over-triggers.
   - `budget.ts` — §10.11's hard cap, checked *before* the call.
3. **`client/routing.ts`** — §10.11's table as data, with its reasons attached.

## Two things recorded here rather than discovered later

**The blueprint and the schema disagree about consent.** §10.10 specifies four
independently revocable scopes; the `consent_scope` column is a ladder that
cannot express "metrics on, clinical off". `fromStoredScope` is a conservative
projection of the ladder onto the four, and the asymmetry is stated in
`consent.ts` rather than hidden. Reconciling the column is a migration, and
§13.2 keeps migrations out of feature commits.

**`{0}` is digits.** The narration schema refuses digits in prose and had to
learn to ignore its own slot syntax first. The bug read as correct code and
rejected every valid narration in the system; the test found it.
