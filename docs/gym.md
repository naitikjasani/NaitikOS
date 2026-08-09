# Gym

*Blueprint §4.1, §9.2, §12 week 3. The first full domain, end to end.*

Gym is the first module that goes all the way through: a domain model in `core`,
entities and observations in `db`, contracts in `api`, routes and screens in the
web app, charts in the design system. Everything before it was platform.

The week's exit criterion is a sentence, and it is the only test that matters:

> A real training session logged in the gym, on a phone, without friction. If the
> logger is annoying to use under fatigue, week 4 is spent fixing it rather than
> moving on.

---

## 1. Sets are entities; set values are observations

The structural decision, and the one that looks like duplication until you know
why.

A `workout_set` row holds the **structure** — which exercise, which position in
the session, what kind of set. The load and the reps are *also* written to the
observation log against `gym.set.load` and `gym.set.reps`, subject-referenced to
the set.

The justification is P3. Skin must be able to ask "was training volume high in
the two days before this flare?" **without knowing Gym exists**, and it can only
do that through the metric vocabulary — a join into `workout_set` would make
every cross-domain question a Gym-shaped question.

`planSetLog` is where the duplication is made safe: it is the *only* place a set
becomes both, so the two representations cannot disagree about what happened.

```
SetLogInput ──► planSetLog ──┬──► WorkoutSet          (the structure)
                             └──► ObservationInput[]  (the numbers, canonical)
                                    subject = { type: 'workout_set', id }
```

Both halves are written in one transaction (`workout.repository.ts`). A write
that landed one without the other would leave the record disagreeing with itself.

---

## 2. The prefill is the interaction model

§4.1's design note is the strongest statement about Gym in the blueprint:

> The logger must default to *last session's numbers* for the same exercise, so
> the primary interaction is confirming or nudging rather than typing. Typing a
> weight from scratch every set is a P1 violation.

A novice's session is four exercises × four sets. Almost every one of those
sixteen sets is either identical to last week's or one increment above it.
Sixteen numeric keyboard interactions, between sets, out of breath, is the
difference between a system used in the gym and one filled in from memory that
evening — which is a different, worse dataset.

`prefillFor` therefore matches **by position within the previous session**: the
third set of squats prefills from the third set of squats, not the first. Three
rules fall out of that:

| Rule | Why |
|---|---|
| Warm-ups prefill only from warm-ups | Otherwise "add set" mid-session offers the empty bar |
| The last set repeats when this session runs longer | A fifth set after four is nearly always a repeat of the fourth |
| **RPE is never prefilled** | It is a judgement about *this* set; copying last week's turns the one subjective field into a number nobody assessed |

The prefill's provenance is rendered on the card ("Last time: 60 kg × 8"). A
prefilled value that cannot be distinguished from a recorded one is a
data-integrity problem wearing a convenience hat.

---

## 3. Volume, and the three ways to get it wrong

Volume is load × reps summed. That is the whole of the arithmetic and almost none
of the difficulty. `gym.session.volume` is written to the observation log and
consumed by the insight engine — §4.1 says it is "what makes 'your skin flares
two days after high-volume leg sessions' computable at all" — so a quietly wrong
number propagates into a clinical-sounding claim.

### Bodyweight movements

`gym.set.load` records *external* load and says so. A set of pull-ups at +10 kg
has `load = 10`, and computed naively its volume is 80 kg for eight pull-ups —
absurd, and enough to make a pull-up day look like a rest day.

The fix is to add the session's bodyweight. The trap is what to do when it is
unknown, and both tempting answers are wrong: **zero** understates by an order of
magnitude, and the **latest weigh-in** silently attributes today's bodyweight to
a session six weeks ago.

So an unresolvable set is **excluded and counted**. `SessionVolume.excluded`
carries the reasons, the session summary reports them, and the volume screen
says "3 sets not counted — no bodyweight recorded". A visible gap beats an
invisible lie; this is §8.9(3) applied to arithmetic rather than to a chart.

The session's bodyweight is resolved **once, at start**, from the most recent
reading *strictly before* the session began, and stored on the session row. Not
per set — a weigh-in mid-session would otherwise give two sets of the same
pull-ups different loads.

### Warm-ups

Excluded, per the metric's own description. A lifter ramping to a heavy single
does five warm-up sets; counting them turns the highest-*intensity* day of the
week into the highest-*volume* day, which inverts the signal the insight engine
reads.

### Attribution to muscles

A bench press trains chest, and also triceps and front delts. No observation says
in what proportion, so any split is a modelling choice. `SECONDARY_MUSCLE_SHARE`
makes ours explicit — **0.5** — rather than scattering a magic number through the
code.

This is the least defensible figure in the module and it is deliberately the most
visible one. It is not derived from physiology. It exists so that "which muscle
groups am I actually training" has an answer that is *consistent over twenty
years*, and consistency is what makes the comparison useful even when the
absolute number is arbitrary.

Consequently **the sum across muscles exceeds the session total**, and that is
correct rather than a bug: the question is not a partition of a fixed quantity,
and normalising it would understate every compound movement. The chart's axis
says "attributed volume" and the method note is printed under it.

---

## 4. Personal records

Three kinds, each with a definition that survives scrutiny:

| Kind | Beats the record when | Why it is separate |
|---|---|---|
| `load` | the heaviest weight moved for ≥ 1 rep | The number a lifter quotes. Says nothing about work done. |
| `reps` | the most reps **at or above** the previous best load | Progression on a fixed weight — most of a novice's year. |
| `e1rm` | the best estimated one-rep max | The only one that ranks *across* rep ranges. |

Single-set volume was considered as a fourth and rejected: it is maximised by
thirty easy reps, so it would reward the one thing a novice should not optimise.

**The estimate is Epley** — `1RM = w × (30 + r) ÷ 30` — chosen over Brzycki
because it degrades more gracefully at higher reps and is exact in rational
arithmetic, which matters when the result is compared for equality against a
stored record.

It is **refused above twelve reps**. Every rep-max formula is fitted to roughly
one to ten; a set of twenty at bodyweight would estimate a max nobody could lift,
and the app would congratulate the operator on a PR that does not exist.

Two guards worth naming:

- **Equalling a best is not a record.** Strictly greater, in every case. Otherwise
  the badge fires every time last week's work is repeated.
- **A rep PR requires the load to be at least the previous best.** Without it,
  twelve reps at half the weight counts, and the badge fires on every deload week
  — the one week it should be silent.
- **The first set of an exercise is `isFirst`, not a PR.** Everything is a record
  the first time, and badging that as one teaches the operator to ignore badges.

---

## 5. Offline: the ordering problem

A gym is a basement. Every write goes into the IndexedDB outbox first and the
drain sends it when there is signal (§5.7), so from the operator's point of view
logging cannot fail — it is queued, the banner says so, and it lands later.

That creates an ordering hazard specific to this module: **a set references its
session by foreign key.** A session logged offline queues one start and a dozen
sets; if a set reaches the server first it is rejected with `23503`.

Sorting the queue by `enqueuedAt` is not sufficient, because the drain continues
past a failure — one failed session start would let every set behind it try, fail,
and burn one of six attempts each.

The fix is handled on both sides:

**Client.** `OutboxEntry.dependsOn` names a prerequisite entry. `readyEntries`
withholds an entry while its dependency is still in the store — and since only
`acknowledge` deletes, "still in the store" means "the server has not confirmed
it". If the dependency is `blocked`, its dependants are blocked too, visibly,
rather than sitting pending forever.

**Server.** If one slips through anyway — a tab reloaded mid-session loses the
in-memory mapping — the foreign-key violation comes back as a *retryable*
`workout_session_missing` precondition rather than a permanent rejection.

### Idempotency

Everything is idempotent on a client-generated id:

- `startSession` inserts `ON CONFLICT DO NOTHING`. A replay must **not** move
  `startedAt` — the outbox may deliver it twenty minutes late, and the second
  write would shorten the recorded session by exactly the sync delay.
- `logSet` uses the set row as the anchor for its observations too. If nothing
  was inserted, the whole call returns the stored row and writes nothing else.
  This is load-bearing rather than an optimisation: the observations are
  *re-planned* on every attempt and carry fresh ids, so `append`'s own conflict
  handling would not recognise them, and a replayed set wrote its load and reps
  again.
- `closeSession` is guarded by `ended_at IS NULL`. Closing a closed session is a
  no-op, so a replay cannot lengthen it and make the derived duration disagree
  with the one already written.

---

## 6. Events

Gym emits three types, all already in the registry from the event-backbone
milestone:

| Event | Significance | Payload |
|---|---|---|
| `Workout.Started` | primary | program id, block label |
| `Workout.SetLogged` | **detail** | session, exercise, label, position, `isPersonalRecord` |
| `Workout.Completed` | primary | set count, exercise count, duration |

`SetLogged` is `detail` so a forty-set session does not bury everything else on
the timeline for that day.

No payload carries a load or a rep count — ADR 0005's rule. `isPersonalRecord` is
a *flag*, which is permitted: it is a fact about the set rather than a
measurement of it, and the timeline needs it to decide whether to render a badge
without a second query. The session's *volume* is deliberately absent for the
opposite reason: it is measured, it lives in `gym.session.volume`, and restating
it would create the second source of truth ADR 0005 exists to prevent.

---

## 7. The exercise library

Seeded reference data, ~41 movements, in every environment including production.
§4.1's logger is built around confirming numbers rather than typing them, and an
empty library makes the first session forty minutes of data entry — the exact
friction the module exists to remove.

Deliberately **not** a five-hundred-entry catalogue. §3.1's warning about
"fourteen mostly-empty sections" applies to a search box too: a library where
"row" returns thirty variants is one where the picker is slower than typing.

**The upsert conflicts on the slug, not the id.** The slug is derived from the
name by `exerciseSlug` and is stable across re-seeds; upserting on a generated id
would insert the library again under new ids, and every historical set would
still point at the originals — silently splitting each exercise's history in two.

**`form_notes` is never overwritten.** §4.1 calls it "user-authored cues that
actually work for them" — it is the only original content in the library, and a
re-seed that destroyed it would be unrecoverable.

Two search paths exist on purpose: Postgres trigram (§9.6) for the library
screen, and `core`'s `searchExercises` ranking an already-loaded library for the
picker. The second is what makes the picker work in a basement.

---

## 8. What is not built

Stated rather than left to be discovered:

- **Program adherence is built; program *definition* is not.** `/api/gym/program`
  reads the active program, reports adherence over a fortnight and names the next
  block, and `ProgramCard` renders it on `/body/gym` — rendering nothing at all
  when no program is active. What is missing is the authoring screen
  (`/body/gym/programs`): a form-heavy surface that would have taken the time
  §12's exit criterion says belongs to the logger. Until it exists a program is
  inserted directly.
- **Supersets and drop sets are data, not UI.** `supersetGroup` and the `drop`
  set kind are stored and counted correctly; the logger has no control for them.
- **Deload suggestion from volume trend** (§4.1's feature list) is absent by
  §2.1: every non-adherence insight is out of the MVP, and §10.6 explains why a
  detector that fires on noise is worse than none.
- **Session templates** and **superset UI** — §4.1 future expansion.
- **No screen projects a bodyweight forecast.** `projectForward` exists, is
  tested, and `TrendChart` renders projections dashed with a widening band per
  §8.9(4) — but nothing calls it. A fourteen-day bodyweight forecast is precisely
  the over-claim §4.6 warns about, and the capability is kept for a case where a
  projection is genuinely the question being asked.
- **Isometric work has no volume model.** A plank is stored with its hold in the
  reps field and contributes nothing to volume, because bodyweight × seconds is a
  number in kilogram-seconds that means nothing. Said out loud in the seed data
  rather than left as a silent zero.

---

## 9. Files

```
packages/core/src/domain/gym/
  exercise.ts       taxonomy, slug, local fuzzy ranking
  session.ts        session/set model, planSetLog, planSessionClose
  volume.ts         effective load, session volume, muscle attribution
  records.ts        Epley, personal-record detection, relative strength
  progression.ts    prefill, per-session progression points
  program.ts        programs, prescription parsing, adherence

packages/core/src/statistics/     moving average, OLS trend, band, projection
packages/core/src/derivation/     registry-aware daily/weekly rollups

packages/db/src/repositories/
  exercise.repository.ts   cached library, trigram search, slug upsert
  workout.repository.ts    sessions and sets, atomically
  program.repository.ts    programs and blocks
packages/db/src/seed/exercises.ts

packages/api/src/contracts/gym.ts

apps/web/lib/platform/gym.ts      the service
apps/web/app/api/gym/{sessions,sets,exercises,progression,volume}/route.ts
apps/web/features/gym/            logger, timer, picker, history, library, volume
apps/web/features/composition/    bodyweight and the seven-day trend
```
