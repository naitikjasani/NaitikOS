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

- **Local embeddings (§10.3).** The vector layer needs ONNX in a persistent
  runtime; §10.3 says so itself and calls it "the one piece of infrastructure in
  this design that C3 does not get for free". Hybrid retrieval currently means
  the lexical half only.
- **Narration of insights.** The inbox renders the detector's own prose and
  leaves `narrative` null, deliberately — writing a deterministic sentence into
  a column documented as model-authored would make the audit trail unable to
  distinguish the two.
- **Four of `statisticRefSchema`'s six fields.** It permits `r`, `n`, `p`,
  `effectSize`, `lagDays` and `windowDays`; the `insight` table stores `p_value`
  and `effect_size`. The other four resolve to a visible gap. That is §6.2's
  failure mode — two files each correct on their own — and it is recorded at
  both ends rather than fixed by narrowing the schema, because narrowing it is a
  decision about what a detector may report.

### Recently closed

- **Reference rendering.** Built. An answer's paragraphs come back as templates
  with `{0}` slots; the server resolves each reference against the database and
  substitutes. See §10 below.
- **`/ask/:threadId`.** Built, on migration 0017. See §11.
- **The Ask surface.** Built; §9 describes it.

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
| Rendering | `packages/ai/src/render/` — narration substitution (§11) |
| Reference lookup | `packages/db/src/repositories/reference.repository.ts` |
| Translation | `apps/web/lib/platform/references.ts` |
| Enquiry threads | `packages/db/src/repositories/enquiry.repository.ts`, `apps/web/lib/platform/enquiry.ts` |

## 11. Reference rendering — the other half of §10.10

`schemas/references.ts` makes a narration structurally unable to carry a number.
That is worth nothing on its own: for a while every Ask answer rendered with
visible `{0}` slots, which was the honest failure and an unsatisfying one.

`render/narration.ts` puts the stored figure back. The model emits `{0}` and an
observation id; the server reads the row and substitutes. §10.10's sentence —
*"the model is never the source of a figure the user reads"* — is now true end
to end.

**Resolution happens on the server.** A client receiving reference ids and
looking them up would be a second path to a figure, running in a browser. The
number is read from the row server-side and travels as text.

**The output is segments, not a string.** A rendered narration is a list of
pieces, each labelled prose, resolved value, or unresolvable reference. That
costs a `.map` and buys two things: the UI can mark a figure as coming from the
record — §10.10 is invisible to a person if a resolved number looks like a
written one — and a reference that cannot be resolved is *distinguishable*.

**An unresolved reference never disappears.** The model can name an observation
since deleted, or invent an id outright. Substituting nothing gives *"has been
below on most days"* — a sentence that reads as complete and is missing its
subject, which is worse than either a gap or an error because it looks fine. It
renders as an em dash and the count is stated under the answer.

**A superseded observation renders as it was, and says so.** §9.1 makes a
correction a supersession rather than an edit. An answer written on Tuesday
cited what was true on Tuesday; silently following the chain would make a saved
answer say something the model never said. The correction is reported instead.

### The layering, and why the repository speaks in ids

`db` cannot import `@naitikos/ai` — §5.0 puts `ai` above `db`. So
`reference.repository.ts` takes five sets of identifiers and returns five maps,
and `lib/platform/references.ts` owns the translation. The deeper reason is that
a reference is a fact about a model's output format, and the database layer has
no business knowing that format exists.

One query per kind, five issued together. An eight-paragraph answer naming one
observation four times costs one row read.

## 12. Saved lines of enquiry (`/ask/:threadId`)

§3.2 has listed this route since day one. Migration 0017 gave it two tables.

**A thread is not a conversation, and the schema is what enforces that.** There
is no column for a transcript and no ordering the context builder reads.
**Prior turns are never sent back to the model.** Feeding a model its own output
makes it reason over its own assertions rather than over the record, which is
§10.0's prohibition in the one place it is most tempting to break.

The consequence the interface states plainly, under the box: *"Each question is
answered from your record alone. Nothing said above is sent back to the model,
so a follow-up has to stand on its own."* Without that, a user writes "and what
about the week before?" and gets a confused answer with no indication why.

**A thread is created deliberately, and before the asking.** There is no "save
this answer" button. Saving after the fact makes every answer a candidate for
keeping, which turns the surface into a chat log with a filter on it. Naming the
enquiry first forces the question §4.13 says the surface is for — *what am I
actually trying to find out* — and that outlives any one phrasing.

A thread can sit unasked. That is a legitimate use: a line of enquiry you have
not got to is still one. It sorts last in the list, because a placeholder from
six months ago is not more urgent than something answered this morning.

**Stored answers are re-rendered on every read, never cached.** A turn holds
templates and reference ids; the figures resolve against the log each time the
thread opens. This is the surface where §10's supersession behaviour earns its
keep, because it is the only one showing answers old enough for the record to
have moved underneath them.

**A turn with no answer is kept.** "I asked this in April and the layer was off"
is part of a line of enquiry; hiding it would make the thread look unpursued. A
CHECK requires exactly one of `answer` and `problem` — neither is a row that
says an exchange happened and refuses to say what came of it, both is two
accounts of one moment.

**An unparseable stored answer is shown as unreadable, not skipped.** A row from
2031 may predate whatever `answerSchema` looks like then. The question stays
legible — it is the operator's — and the answer says what happened to it.

**Nothing can POST a turn.** Turns come into existence exactly one way: by
asking, through `/api/ask` with a `threadId`. A client able to write an answer
could write one containing a number, and every structural control in
`schemas/references.ts` would be bypassed by a request.
