# The AI layer

**Status:** foundation shipped, December 2026 (§12's V2 December block, built
early — see [validation.md](validation.md)). · **Blueprint sections:** §10, §5.0,
§9.2
**Related:** [insights.md](insights.md) · [health.md](health.md)

---

## 1. The one rule

> §10.0 — **The model never computes, discovers, or asserts. It retrieves,
> explains, ranks, and drafts.**

Enforced structurally rather than by instruction. §10.0 again: "A prompt saying
'don't make up numbers' is a hope. An architecture where the model is never
given the opportunity is a guarantee."

The cost of getting this wrong is stated in the blueprint and is worth repeating
here, because it is the reason for every design decision below: *"a person
changing their medication behaviour because a language model produced a fluent,
plausible, invented correlation."*

## 2. What the model can and cannot represent

The schemas are the primary control (§10.10: "the representation makes the
harmful output unrepresentable, which is stronger than any instruction").

| Cannot exist in any schema | Why |
|---|---|
| A diagnosis field | §10.10, and §10.7 makes clinical output a *question* |
| A dosage field | Same |
| A treatment-change field | Same |
| A digit in prose | Every figure is a `Reference` the application resolves |

`narrationSchema` refuses digits in `template` and requires a `Reference` per
`{n}` slot. The model writes `"{0} has been below {1} since {2}"` and supplies
three references; the application substitutes from the database. A corrected
observation (§9.1 makes a correction a supersession) therefore changes what the
operator reads without the insight being regenerated.

**`{0}` is digits.** The check runs on the template with its slots stripped.
The naive version reads as obviously correct and rejects every valid narration
in the system; its test found it.

## 3. The guardrail order, and why it is the design

`client/invoke.ts` is the only path to a model. In order:

1. **Crisis.** §4.7 permits exactly one behaviour and it is not a model call.
   First, because every later step is irrelevant if the answer is "show the
   stored plan" — and because someone in crisis should not receive a cheerful
   nightly narration about their protein intake. **No ledger row is written**: a
   record timestamped to the worst evening of someone's year, noting that the
   system noticed, is not something this design wants to create.
2. **Consent.** §10.10 gates at retrieval; this is the second check, because
   `invoke` is the last place before the wire.
3. **Budget, before the call.** §10.11 is explicit. A cap checked afterwards is
   exceeded by exactly one call a month, forever — and given the routing table
   that call is the Opus one. The estimate uses the *output ceiling*, not a
   guess: an estimate assuming a short answer would let a long one cross the cap.
4. The call.
5. **Schema validation**, even though structured outputs should make it
   unreachable. "The API guarantees it" is a claim about someone else's code.
6. **Prohibited-pattern scan**, which **blocks and never sanitises**. A
   paragraph is written *around* its clauses: stripping "you should stop taking
   it" leaves prose reading as agreement with whatever preceded it. A partially
   redacted clinical instruction is more dangerous than a whole one.
7. **The ledger**, for every outcome including the blocked and refused ones —
   those are the records anyone investigating would actually want.

Moving the budget after the call, or the scan before the schema, each turns a
control into a formality.

## 4. The transport is a port, and that is a testing decision

`invoke.ts` depends on the `Transport` interface, not on the vendor SDK. The
point is not portability, which nobody needs. It is that **the entire guardrail
pipeline runs in a unit test with no key, no network and no bill** — and a
safety control that can only be exercised against production is one nobody
exercises. Twelve tests cover it, each by having the thing a control is supposed
to stop actually be stopped.

`client/anthropic.ts` holds everything vendor-shaped.

## 5. Four API facts the design depends on (§10.11)

- **Adaptive thinking, `effort` as the depth control.** `budget_tokens` is
  rejected on Opus 5 and Sonnet 5 — a fixed budget carried over from an older
  model is a 400, not a degradation.
- **`max_tokens` bounds thinking *and* response**, and thinking is on by default
  on Opus 5. The routing ceilings are generous for that reason: a tight limit
  does not save money (output is billed on what is produced), it truncates. For
  a Consultation Pack that means a page of questions that stops halfway and
  reads like a printer fault.
- **No sampling parameters.** No `temperature`, no `top_p`. A test asserts the
  string `temperature` appears nowhere in the routing table.
- **A refusal arrives on a 200.** Health and body content sits adjacent to
  categories that occasionally trip safety classifiers, so `stop_reason` is
  checked before `content` on every call, and a refusal is returned as a value
  rather than thrown.

Requests stream. The routing table gives Ask and the pack a 32K–64K ceiling and
the SDK requires streaming at that size to avoid an HTTP timeout; nothing
consumes the stream events, because these surfaces are not incremental.

## 6. Consent: resolved, and how

§10.10 specifies four **independently revocable** scopes — `metrics`,
`clinical`, `journal`, `media`. The `consent_scope` column is a *ladder*
(`none | aggregates_only | non_clinical | clinical | journal`) where granting
journal implies everything below it. The ladder cannot express "metrics on,
clinical off", which is a reasonable configuration.

**The four booleans are now authoritative**, stored in the `setting` blob and
written from `/settings/ai`. The ladder column became a *derived projection*
(`toStoredScope`) recorded alongside each `ai_interaction` row. That inverts the
earlier arrangement, where the ladder was authoritative and `fromStoredScope`
narrowed it — a workaround that was correct while nothing could write the four,
and unnecessary once something could. No migration was needed: `setting` is
`jsonb`, which is the same trade §9.2 already makes for preferences.

The projection is lossy in one direction and honest about it. "Metrics on,
clinical off" projects to `aggregates_only`, and the fact that clinical was
*explicitly* off rather than merely below the rung is not recoverable from the
column. What the column is for — "what the user had granted at the moment of the
call, so a later consent change cannot retroactively justify an earlier one" —
survives that loss, because the projection is monotone: a narrower grant never
projects to a wider rung.

`media` is `false` at every rung, including `journal`. §10.10 marks it "Off, and
**per-invocation confirmed**", and a standing grant cannot satisfy a
per-invocation requirement.

### The parser leans closed, unlike every other parser in that file

`parseAiPreferences` falls back to *no consent and disabled* on anything
unexpected. Every other preference parser falls back to something merely
conventional — a bad theme becomes dark and nothing is harmed. This one guards
against a malformed row causing data to be sent that the operator never agreed
to send, and P7's egress is not reversible.

It also checks `=== true` rather than truthiness. A stored `"true"` string, a
`1`, or a half-written migration must not read as a grant.

An **unknown** consent scope is rejected by `validatePreferences` rather than
dropped. Elsewhere in that validator an unknown key is a typo; here it is a
client that believes it is granting something, and silently dropping the grant
would leave the operator thinking they had consented to a class that was never
enabled.

### The kill switch

§7: "a single flag in `/settings/ai`, and the acceptance test for the flag is
that **the whole product still works with it off**." It saves on toggle rather
than on a Save button — a kill switch that needs a second action to take effect
is not one — and there is no confirmation dialog, because §8.12 makes
confirmation a protection against loss and nothing is lost by turning it off.

`aiIsUsable` requires **both** the switch and a grant, because they mean
different things. The switch is a deliberate "not now" that leaves the grants
intact; an empty grant is "there is nothing I am willing to send". Flipping one
back on should not silently satisfy the other.

## 7. Money

`MONTHLY_CAP_MINOR` is 2,000 cents. §10.11 puts realistic steady-state at
"single-digit dollars per month"; twenty dollars is roughly three times that —
high enough that ordinary use never touches it, low enough that a runaway loop
is caught within a day rather than at the end of a billing cycle.

Estimates round **up** and use **list price** for Sonnet, not the introductory
rate that expires 2026-08-31. An estimate that assumed a promotion
under-enforces the day after it ends, and the failure mode of that file is a
bill. §10.11: "a bill is a reason to turn the system off", and §13.1 lists
abandonment as the fatal risk — so the cap is managing abandonment, not cost.

Every fail-closed message says what still works, because everything does.
Nothing in this application computes a number with a model.

## 8. What is not built yet

- **Reference rendering.** An answer's paragraphs come back as templates with
  `{0}` slots and a reference list. The renderer that resolves those against the
  database is not built, so the slots are currently visible in the answer. That
  is the honest failure mode: a paragraph with a `{0}` in it is obviously
  incomplete, and one with a plausible invented number is not.
- **`/ask/:threadId`.** §3.2 lists it for "a saved line of enquiry". It needs a
  table. Single-turn is the honest version until then, rather than a fake thread
  that forgets.
- **Local embeddings (§10.3).** The vector layer needs ONNX in a persistent
  runtime; §10.3 says so itself and calls it "the one piece of infrastructure in
  this design that C3 does not get for free". Hybrid retrieval currently means
  the lexical half only.
- **The Ask surface (§10.4's consumer).** The context engine it needs is built
  and tested; the surface is not.
- **Narration of insights.** The inbox renders the detector's own prose and
  leaves `narrative` null, deliberately — writing a deterministic sentence into
  a column documented as model-authored would make the audit trail unable to
  distinguish the two.

## 9. Ask

`/ask` is the first caller of `invoke`, and the shape of the surface is
§2.5's doing: **it is not a chat.** One question, one answer, and the box
clears. No thread, no history sidebar, no typing indicator. Every affordance
that makes a surface feel conversational is an invitation to spend time in it,
which §1.4 counts as a counter-metric rather than a success. It is reachable
from the command palette and from the insight inbox, and from nowhere in the
primary navigation — a tab for it would be the shell arguing against §2.5.

Retrieval is gated at the query. `buildPack` returns before a repository is
called when a scope is off, so unconsented data is never fetched, never held,
and never available to leak. `assemble` filters again afterwards and that
redundancy is deliberate — a defence living only upstream is one refactor from
being gone.

The crisis check reads mood and anxiety out of the observations already fetched
rather than through a detector. §4.7 permits one behaviour in that moment and it
must not depend on the nightly battery having run: a person in crisis on a night
the job failed is exactly the case that cannot be missed.

Relevance scoring is word-overlap and deliberately crude. §10.4 puts the
sophistication in *ranking*; a cleverer matcher here would be guessing at intent,
which the retrieval plan already decided. It only has to separate "mentioned"
from "not mentioned" well enough for the budget step to cut the right tail.

## 10. Where things are

| Layer | Path |
|---|---|
| Schemas | `packages/ai/src/schemas/` — references, insight, recommendation, consultation, ask |
| Guardrails | `packages/ai/src/guardrails/` — consent, prohibited, budget, crisis |
| Context engine | `packages/ai/src/context/` — classify, summarise, assemble |
| Boundary | `packages/ai/src/client/` — routing, transport, invoke, anthropic |
