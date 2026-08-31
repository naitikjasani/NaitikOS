# Sleep

**Status:** complete against §4.6's Sleep block, shipped 31 August 2026 (§12's
V3, built alongside Work). Nights, timing, consistency and disturbances; the
Daily Close's two observations keep working unchanged.
· **Blueprint sections:** §4.6, §9.2, §9.3, §4.7, §10.0, §5.3
**Related:** [daily-close.md](daily-close.md) · [observations.md](observations.md) ·
[mind.md](mind.md) · [work.md](work.md)

---

## 1. Why a table, when two observations already exist

§4.6 is unusually direct about why this matters at all:

> Sleep is the highest-leverage cross-domain variable in the entire system and
> is therefore in the MVP's Daily Close despite Sleep not being a full module
> until later.

`body.sleep.duration` and `body.sleep.quality` have been on the substrate since
week one and they stay there — every existing chart, every correlation and the
Daily Close itself read them, and none of that changes. What a per-metric series
cannot carry is the other three things §4.6 asks for: **timing, consistency, and
disturbances.**

§9.2's test for promoting something to an entity is whether it has internal
structure, and a night does. It has two endpoints, a latency, a count of
wakings, and a reason it was bad. Those are not five more scalars in a trench
coat, because the quantity that actually matters is the *relationship between
the endpoints across nights* — which is what consistency means, and which no
collection of independent series can express. Five metric keys would give you
five charts and no way to compute a midpoint spread.

So a night is an entity, and it also writes the two observations. That is the
shape Gym already uses: a `workout_set` is a row and its load is also an
observation. §9.3 permits it in exactly one direction — the entity is the source
of truth and the series is a projection of it, never the reverse.

## 2. A night is keyed by the morning it ended

The convention is stated in the schema, enforced in the contract, and repeated
in the loader, because it is the one decision here that is expensive to get
wrong and impossible to detect afterwards.

A night that begins on Tuesday evening and ends on Wednesday morning is filed
under **Wednesday**. The reason is that every question asked of this data is of
the form *"how did I sleep before the day I had?"* — training readiness on
Wednesday, mood on Wednesday, the skin flare noticed on Wednesday. Filing by the
evening puts the night one row away from every day it explains.

The failure mode is what makes this worth a section. An off-by-one here does not
crash, does not warn, and does not look wrong: it produces a correlation with
the sign flipped, discovered months later, at which point there is no way to
tell which convention any given historical row was written under. The
`sleep_night_day_unique` index is on `day_key` for the same reason — one night
per morning, so a second row is a duplicate rather than a nap, and naps are not
modelled. A schema that silently accepted two would make every consistency
figure wrong by an amount nobody could see.

## 3. Duration is stored, never derived

`bedAt`, `wokeAt` and `durationHours` are three independent facts and the system
computes none of them from the others. That is a deliberate refusal, in the
contract as well as the column:

> Hours slept. Stored rather than computed from the endpoints, because the two
> are different facts: time in bed is not time asleep, and the difference is
> exactly `latencyMinutes` plus the wakings. A derived duration would silently
> overstate every night.

The temptation is real — `wokeAt - bedAt` is right there, and a night with two
endpoints and a null duration looks incomplete. It is not incomplete. It is a
night where the operator knows when they went to bed and does not know how long
they slept, and inventing the second from the first fabricates a number that is
wrong in a consistent direction on every single row. A figure that is
systematically inflated is worse than a missing one, because the missing one is
visibly missing (P5, §10.0).

What the endpoints are actually for is `timeInBedHours` and `sleepEfficiency`,
which are named for what they measure and computed on read, where the reader can
see the derivation. Nothing writes them back.

The reverse also holds, and it is the common case: the Daily Close asks for a
duration and a quality, so a night captured through the ritual has a duration
and no timing at all. That is a *complete* record of what the operator knows on
waking, not a partial one to be nagged about, and every field here except the
day, the zone and the id is nullable to say so.

## 4. The midpoint is circular, and treating it as linear is the bug

Consistency is the reason the table exists, and it is computed over the
**sleep midpoint** — the clock time halfway between falling asleep and waking —
rather than over bedtimes, because a night that is shifted late and a night that
is shifted short are different things and the midpoint separates them.

The arithmetic is the interesting part. Midpoints are minutes on a 24-hour dial,
and a dial wraps:

| Two midpoints | Linear difference | Actual difference |
|---|---|---|
| 03:00 and 23:00 | 20 hours | **2 hours** |
| 01:00 and 23:30 | 21.5 hours | **1.5 hours** |

A naive standard deviation over raw minutes reports the operator as wildly
irregular precisely when they are consistently going to bed near midnight, which
is the single most common sleep schedule there is. The spread is therefore
computed circularly, and the tests pin the midnight-crossing cases specifically.

Two smaller decisions follow from the same place. The midpoint is derived in the
night's **own** `zone`, not in the reader's — a night slept in Singapore stays a
Singapore night when it is read back in London, because §5.3's whole point is
that an instant plus a zone is the record and a re-interpretation is a
different fact. And consistency is refused below a minimum number of recorded
nights: a spread over three nights is a number, but it is not a finding, and
§10.9 asks for *"insufficient data"* rather than a confident figure over
nothing. The screen renders that as "not enough nights yet", never as a zero.

## 5. No stages, and no score

Two things a sleep module normally has, and the reason each is absent.

**No stages.** There are no REM, deep or light columns. Partly because §4.6 puts
wearable import at V3 and there is no import yet — but mostly because consumer
sleep staging is a model's guess from movement and heart rate, and putting that
guess in the same column as a self-report would file a vendor's inference and
the operator's own observation under one name with no way to separate them
later. When import arrives it gets its own columns and its own `source`.

**No score.** Every wearable computes one; no two agree, because the weights are
a product decision rather than a finding. This system would have to invent its
own weights to produce one, and it would then carry that invented number into
every other domain as though it were a measurement. §10.0 keeps the system out
of the business of asserting numbers it cannot defend. The screen shows duration,
quality, latency, wakings and consistency as five named figures and leaves the
weighing to the person who slept.

Sleep debt is reported for the same reason it is reported carefully: it is
arithmetic against a stated target, not a judgement, and it returns nothing at
all when there are too few nights to compute it over.

## 6. The screen states nothing causal

§4.7 forbids *"your mood is low because you skipped the gym"*, and the
prohibition runs in both directions — this is the page where the temptation is
strongest, because sleep is the variable §4.6 says feeds "essentially
everything: mood, anxiety, training readiness, skin."

So a bad night is drawn and left alone. The duration grid is day-keyed with the
same `AdherenceGrid` the routine, medication and task screens use, so laying it
next to any of them is a matter of looking at two pictures rather than
reconciling two day-key conventions — and the adjacency is all the page offers.
An unrecorded night is drawn as `null`, not as `0`: a night nobody logged is
absence of evidence, and a grid that renders it as a zero-hour night shows a
wall of failure for every day before the operator started using the system.

Anything stronger than adjacency is governed by §10.6's five controls, and none
of them is satisfied by two strips on a screen.

## 7. Writes are online-only

`/api/sleep` sits behind `observation:write` — §5.4 splits permissions by blast
radius, and a night changes nothing about how a future observation is
interpreted the way a nutrition target does.

Nothing here queues through the outbox. A night is keyed uniquely by its day, so
a replayed write is a uniqueness violation rather than a duplicate, and the
outbox replays in queue order rather than causal order: a delete replayed after
a correction would remove the corrected row with nothing anywhere to detect it.
The form says so rather than letting the operator find out when a queued night
never appears. Deleting asks why and never requires an answer, the same rule
tasks use — in year three a row removed with no reason is indistinguishable from
an accident.

## 8. What is not built

| Not built | Why |
|---|---|
| Wearable import | §4.6 names it for V3 and it is the one genuinely missing piece. It is not a matter of adding a parser: an imported night needs its own `source`, its own stage columns (§5), and a rule for what happens when a device and the operator disagree about the same morning — and that rule is a design decision, not an integration. |
| Naps | Not modelled, and the unique index on `day_key` actively prevents them. A nap is not a short night and averaging the two would corrupt both the duration series and every consistency figure. If they earn a place they get their own table. |
| Sleep cross-referenced with mood, training or work load | Both series are day-keyed through `dayKeyInZone` precisely so they can be stacked, and stacking them is a charts job (§6). |
| A readiness figure | §4.6 lists training readiness as something sleep *feeds*, which is a statement about Gym reading this data, not about this module computing a verdict. It would be a score by another name (§5). |
