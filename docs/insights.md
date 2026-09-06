# Insights — the deterministic battery

**Status:** implemented, Week 4; the V2 inbox routes moved to the top level on
7 September 2026 (§7). · **Blueprint sections:** §2.1, §10.6, §3.2, §10.9
**Related:** [mind.md](mind.md) · [skin.md](skin.md)

---

## 1. What ships, and what it is not

§2.1 gives the MVP "**one deterministic insight family.** Adherence tracking and
streak-break detection. No LLM in the MVP path at all."

That is the whole of it. Two detectors, stage 1 only, no model anywhere. Stage 2
— narration and ranking — is V2 and there is no code for it.

## 2. The five controls, and where each one lives

§10.6 calls all five mandatory. This is where they are.

| Control | Where |
|---|---|
| 1. Minimum-N gates per detector | inside each detector, reported as `InsufficientData` |
| 2. Benjamini–Hochberg across the whole battery | `runBattery`, over every p-valued finding |
| 3. Pre-registered hypotheses | `PRE_REGISTERED` in `detectors/battery.ts` |
| 4. Out-of-sample confirmation | `runBattery`, via `heldFindingIds` |
| 5. No insights before day 60 | `baselineState` — **see §3** |

Every finding also carries `doesNotProve` as a **required TypeScript field**, so
a detector cannot construct one without writing that sentence. That ordering
matters: the sentence exists before the finding does, which is the only reliable
way to get an honest one.

## 3. Control 5 does not apply to a count, and that is a deviation

§10.6 states the sixty-day gate without qualification. Applied to the whole
surface it contradicts §2.1.

The MVP contains exactly one insight family, and its definition of done is
"thirty consecutive days of real use". A gate that suppressed adherence for sixty
days would make the MVP's only insight family **dead code for the entire
validation window the MVP exists to run**, and §12's V1 gate — Compounding Days
≥ 25 of 30 by 29 September — would be assessed against a surface that had never
rendered anything.

**The reading taken: the gate applies to inference, not to description.**

- A count of logged doses cannot be an "early wrong insight". There is nothing in
  it to be wrong; the stated rationale ("an early wrong insight costs more trust
  than sixty days of silence") does not reach it.
- A *deviation* finding is an inference, carries a p-value, and is suppressed
  until day 60 along with every future correlation, changepoint and divergence
  detector.

This is a deviation from the literal text of a mandatory control, recorded here
rather than quietly implemented. **If the reading is wrong, the fix is one
boolean in `battery.ts`.**

## 4. The adherence detector emits two different kinds of thing

**A report** is a count over the recent window. `confidence: 'descriptive'`, no
baseline, no test, no p-value. It exists because the operator's actual question is
usually "have I been taking it?", which needs no statistics.

**A deviation** compares the recent window against the established baseline. It
is a genuine inference, and all four inferential controls apply to it.

### Why a test rather than a threshold

The obvious implementation flags adherence below some percentage. It is wrong in
both directions, predictably:

- fourteen days containing a weekend away puts a 95%-adherent operator under 80%
  and fires;
- a slow slide from 98% to 88% over three months never crosses the line and stays
  silent.

Adherence is a count of successes out of a known number of scheduled doses, which
is a binomial exactly. `binomialTailBelow` answers the question actually being
asked — *how surprising is this run for someone whose established rate is what it
is* — and it scales correctly with the number of doses, so a bad fortnight on a
once-daily medication is not treated as equivalent evidence to a bad fortnight on
a four-times-daily one.

**One-sided, downwards only.** A rise in adherence is not a deviation anybody
needs told about, and testing it would double the comparison count that
everything else in the battery pays for.

### The log-space implementation is not a flourish

The naive version multiplies `(1-p)^n` and walks a recurrence. At p = 0.97 and
n = 180 — a person on two daily medications over three months — `(1-p)^n` is about
10⁻²⁷⁰, and a few more doses puts it under `Number.MIN_VALUE`. It underflows to
zero, the recurrence stays zero, and the function returns p = 0 for every input.

Every finding would then clear every threshold. That is the worst available
failure: silent, and biased entirely towards firing. `statistics/binomial.ts`
computes the pmf through a Lanczos log-gamma and sums the tail with log-sum-exp,
and a test asserts the long high-adherence case returns something strictly
positive.

## 5. Benjamini–Hochberg is across the battery, not per detector

§10.6: "across the full nightly detector battery, not per-detector. The comparison
count is known — it is the size of the battery — so this is straightforward and
there is no excuse for omitting it."

Applying BH separately to each family is the mistake that looks like doing it.
Nine families each controlling their own FDR at 0.05 is nine independent 5%
budgets, which over a nightly cadence is a spurious finding every few days.

Two implementation details worth knowing:

- **It is step-up, not step-down.** The largest index that clears its bound sets
  the cutoff, and everything at or below that p-value is rejected — including
  entries that failed their own bound. A "reject while the bound holds" loop is
  quietly stricter than specified, and a test pins the difference.
- **Ties share a decision.** Rejection is by value, not by position. Without that,
  two identical findings can land on opposite sides of the line purely because of
  array order — invisible with distinct test values, obvious the first time a real
  battery produces two detectors reporting p = 1.

## 6. Out-of-sample confirmation has nowhere to keep what it held

§10.6 control 4 holds an inferential finding until a second window confirms it,
which means the battery has to be told what the previous run held.

**That store does not exist yet.** `insight` is a table in §9.2 and nothing writes
to it in the MVP, because the MVP's findings are all descriptive and none is held.
`heldFindingIds` is threaded through `runBattery` and passed as an empty array.

The consequence, stated rather than hidden: **if an inferential detector were
enabled today, its findings would be held forever and never promoted.** That is
the safe direction to fail in, and the fix is the `insight` repository that V2's
inbox needs anyway.

## 7. Where findings surface

§3.2 marks `/insights` as V2 and gives the MVP one place for a finding:
`/today`'s "Today's signal — at most ONE insight card".

The cap is enforced server-side in `topFinding`, not in the component — §3.3's
argument is that an interface which shows everything shows nothing, and an
insight surface is the easiest place in a health application to violate it.

### The routes, and where they live (7 September 2026)

The V2 inbox now exists, at the four routes §3.2 names:

| Route | What it is |
|---|---|
| `/insights` | The inbox — what survived the battery, usually empty |
| `/insights/:id` | Evidence, method, confidence |
| `/insights/archive` | Dismissed and acted-on history |
| `/insights/calibration` | §10.9 — how well the predictions have held up |

They were built under `/life/insights` and moved here on 7 September 2026.
Two reasons, and the second is the one that mattered.

**§3.2 puts insights at the top level, beside `/ask`, not under a pillar.** That
placement is an argument rather than a filing convention: a finding is a lens
over the whole record, and an adherence finding is about Body. Nesting the inbox
under Life implied an ownership that does not exist.

**More concretely, the section was split.** `/insights/calibration` had already
been built at the top level while the inbox sat under `/life`, so two halves of
one surface lived in two places — which is worse than either choice on its own.

Moving the inbox also fixed an orphan. Nothing anywhere in the application
linked to `/insights/calibration`; it was reachable only by typing the URL. It
is now linked from the inbox, which is where it belongs — calibration answers
the question the inbox provokes, which is *should I believe any of this?* A
system that surfaces findings and hides its own track record is asking for trust
it has not shown the working for.

Neither `/insights` nor `/ask` appears in the primary navigation, so the inbox
is still listed on `/life` as a cross-pillar pointer. Without that card the only
route to it is the command palette, which is a surface you have to already know
about. `/ask` has exactly that problem today and it is worth fixing.

The adherence figures themselves appear where they are actionable: `/mind/meds`
and `/body/skin/routine`.

**`insufficient` travels with `surfaced`.** §10.6 control 1: "Below the gate, the
detector reports *insufficient data* — which is itself displayed, because 'not
enough data yet' is honest and builds trust." A card that rendered nothing would
be indistinguishable from a broken one.

## 8. Streaks are reported, never celebrated

§4.7's "no negative framing" and §14.1's second finding both land on the streak
detector:

> "after a gap of three or more days the system offers optional backfill and says
> nothing about the gap. No guilt copy, no 'you missed 4 days,' no recovery
> streak."

So a break is a *fact about a run that ended* — "An 8-day run of the evening
routine ended on 2026-08-08" — reported **once**, within three days of the day it
happened. A finding that reappeared for a fortnight would be the guilt copy §14.1
forbids, arriving by repetition instead of by wording.

Findings are ordered confirmed → exploratory → descriptive, and deliberately
**not** by p-value. Ranking an insight list by significance teaches the operator
to read the top item as the most important thing, and a p-value is a statement
about surprise, not about importance.

## The correlation detector

Added December 2026. §10.6's headline detector, and the one its
statistical-honesty argument was written about.

### Spearman, not Pearson

Every metric this system correlates is either a 1–5 tap scale (mood, energy,
anxiety, skin state) or a bounded quantity with a long tail. Pearson's r on a
five-point scale assumes an interval scale that a tap does not have — the
distance between "2" and "3" is not the distance between "4" and "5" in any
sense the operator meant when they tapped it.

Spearman's rho is Pearson on the ranks, which is exactly the assumption the data
supports: a higher tap means more, and nothing about how much more. It is also
robust to the single outlier day an n=1 series is full of, and one catastrophic
Tuesday should not create a correlation.

Ties are averaged and the tie-corrected formula is used. A 1–5 scale over ninety
days is *mostly* ties, and ranking by position would make rho a function of the
sort order — a stable, plausible, entirely fictional correlation.

### The lag search is a multiple comparison, and is priced as one

§4.9's motivating case is "skin flares typically lag a trigger by 48–72 hours",
so a zero-lag-only correlation would miss most of the interesting relationships.
But searching eight lags and reporting the winner's raw p-value is eight tests
reported as one, which is precisely the dishonesty §10.6 exists to prevent.

The returned p-value is Šidák-adjusted for the number of lags searched
(`1 − (1 − p)^k`). This slightly over-corrects, because adjacent lags are not
independent — which is the direction to err in. Benjamini–Hochberg across the
battery then runs on top of it.

### The trivial-effect gate, which is not one of the five controls

`MIN_REPORTABLE_RHO = 0.3`. At n in the hundreds a rho of 0.15 clears any
significance threshold and describes about two percent of the variation: true,
uninteresting, and indistinguishable to a reader from something that matters.
No amount of FDR control addresses this — FDR is about *false* positives, and
this is a different problem.

The gate runs **before** the p-value is considered, so trivial findings never
reach the battery and never inflate its comparison count. Inflating it would
make Benjamini–Hochberg harsher on the findings that do matter.

### The registry is short on purpose

`CORRELATION_PAIRS` holds six pairs. Every comparison is paid for by every other
finding through the FDR correction, so adding a seventh pair makes the other six
harder to detect. That is the correct incentive, and it is why a registry beats
all-pairs exploration.

Each entry names a mechanism someone could argue with. "These are both numbers I
have" is not a mechanism. The three §10.6 names explicitly — sleep/mood, training
volume/skin state, nutrition/energy — are there; the other three are ones this
operator's record supports, including two where the sign is genuinely unknown in
advance, which is what makes them worth testing rather than assuming.

### The three-part caveat

Every correlation finding carries the same `doesNotProve`, and it has three parts
because they fail differently:

1. Association is not causation.
2. One person's data, with nothing held constant.
3. **Both figures were recorded by the same person on the same day.** A day that
   felt bad can move both readings without either affecting the other.

The third is the one a reader is least likely to think of and the most likely to
be the actual explanation. A test asserts the word "causes" never appears in a
finding's prose — §10.2 says no edge is ever labelled causal, and prose is an
edge the reader traverses.

## The inbox, and closing control 4

Added December 2026, together with the `insight` repository.

### The bug this commit fixed

`lib/platform/insights.ts` used to carry this note:

> So `heldFindingIds` is threaded through and passed as empty. The consequence
> is stated plainly rather than hidden: **if an inferential detector were
> enabled today, its findings would be held forever and never promoted.**

The correlation detector is that detector. But closing the loop surfaced a
second, deeper problem the note did not anticipate.

**A finding's `id` contains its day key.** `runBattery` compared
`heldFindingIds` against `finding.id`, so the same correlation detected on two
consecutive nights produced two different ids — the comparison matched nothing,
every inferential finding would have been held forever, and the inbox would have
stayed empty in a way indistinguishable from a system with nothing to say.

The battery's own test passed, because it re-ran with the *same* day key. That
is a test confirming a behaviour production can never exhibit.

The fix splits identity in two:

- **`id`** — unique per night. What a stored row needs.
- **`signature`** — `detector:subject:variant`, no day. What confirmation needs.

The test now re-runs with a different day key, which is what the nightly job
does, and asserts both that the signature matches and that the ids do not.

For a correlation the lag is part of the signature. A relationship at two days
and the same relationship at five are different claims, and confirming one with
the other would be the confirmation control confirming nothing.

### What is stored, and what is not

| Kind | Stored? | Why |
|---|---|---|
| Confirmed / exploratory | Yes, `disposition: 'new'`, `surfaced_at` set | The inbox |
| Held, awaiting confirmation | Yes, `disposition: 'archived'`, `surfaced_at` null | Control 4's memory; **never displayed** |
| Descriptive counts | **No** | Recomputed correctly on every read, and true of a different window each night — storing them would put a near-identical row in the inbox every morning, which is the feed §3.3 rules out |

`heldSignatures` is bounded to thirty days. A finding held eleven months ago and
not seen since is not "confirmed by subsequent data"; it is a coincidence that
happened twice, a year apart, and promoting it would be the control approving
exactly what it exists to reject.

### One open row per signature

`ON CONFLICT` cannot help: the primary key is a fresh uuid on every run, so
nothing ever conflicts. The natural key is the signature and there is no unique
index on it (that would be a migration). So the check is explicit — and it is
the right product rule regardless. A re-run of the nightly job must not put a
second copy of the same finding in front of a person, because two cards read as
two independent pieces of evidence for one thing.

A **dismissed** signature is allowed to return. The operator said the finding
was not useful in December; the same association still holding in March is a
different fact about the world, and suppressing it forever would let one
dismissal silence a signal permanently.

### Why the detectors run in the nightly job and not on a page render

Control 4 confirms a finding by seeing it in a *second independent window*. A
control that a page refresh can satisfy is not a control — opening `/today`
twice in an evening must not produce two nights of evidence. So `run-detectors`
is a registered job step, and `loadInsights` is a pure read.

### The inbox shows its own denominator

Every card renders `doesNotProve` unconditionally — §10.6 makes it a required
field, and a limitation behind a chevron is a limitation nobody reads. The page
footer prints how many statistical tests ran last night and were corrected
together. An insight surface that hid the size of its own correction would be
asking for trust it had not shown.

Most nights the inbox is empty. That is the system working.
