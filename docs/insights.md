# Insights — the deterministic battery

**Status:** implemented, Week 4 · **Blueprint sections:** §2.1, §10.6, §3.2
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

So there is no inbox route in this milestone. The cap is enforced server-side in
`topFinding`, not in the component — §3.3's argument is that an interface which
shows everything shows nothing, and an insight surface is the easiest place in a
health application to violate it.

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
