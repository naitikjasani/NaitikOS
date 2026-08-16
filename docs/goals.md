# Goals

**Status:** shipped, 10 August 2026 (§12's November block, built early — see
[validation.md](validation.md)). · **Blueprint sections:** §4.10, §9.2, §9.3,
§8.9, §10.9
**Related:** [charts.md](charts.md) · [observations.md](observations.md)

---

## 1. Goals own no progress data

§4.10, and this is the whole architecture of the feature:

> Goals are **not a module with its own data**. A goal is a declaration plus a
> projection over observations that already exist... Recording progress
> separately from the underlying observations would create two sources of truth
> and guarantee drift.

So the pipeline runs on every read, from data other modules already wrote:

```
observations → dailyRollup → linearTrend → deriveProgress → the screen
```

There is no `current_value` column on `goal_target`, no cached ratio, and no
method in `goal.repository.ts` that would fill one. **There is a test that
asserts this against the live schema** — `information_schema.columns` is queried
and four column names are checked for absence — because the temptation to add a
cache is exactly what §4.10 warns produces the drift.

The visible payoff: correct a bodyweight reading through §9.1's supersession and
today's goal answer moves immediately. The integration test does precisely that.

## 2. The snapshot table is not a contradiction

`goal_progress_snapshot` exists, and §9.2 says why:

> "Snapshots exist so the *trajectory as it was believed at the time* is
> preserved even after the underlying data is corrected."

It is a dated record of a **belief**, written nightly by the
`snapshot-goal-progress` job step, and it becomes interesting precisely when it
disagrees with today's derivation. A March bodyweight corrected in June changes
today's line; the January snapshot is the only evidence that the review that
month was looking at something else. That is P2 applied to a derived value.

Two rules keep it from becoming a cache:

- **Nothing reads it for progress.** It feeds one screen — the review — and only
  to compute a delta.
- **An `insufficient` progress writes no row.** A snapshot of "we could not say"
  reads as a measurement of zero in six months, and the absence of a row is
  already the honest record of that day.

The row id is derived from the target and the day, so a job re-run on the same
evening is a no-op rather than a second row.

## 3. Three comparators, and why a rate is different

`at_least` and `at_most` compare the metric's **level**. `rate_of_change`
compares its **slope**.

Conflating them is a real failure with a concrete shape: *"gain 0.25 kg a week"*
is not satisfied by weighing 76 kg, and a system that treats it as a level
target reports the bulk as met on the day the operator steps on the scale after
dinner.

Two consequences:

- **A rate target must state its window**, and it is refused without one.
  `MIN_RATE_WINDOW_DAYS = 14`, because a rate fitted over a week of bodyweight is
  dominated by water and gut content and reads as a spectacular gain or an
  alarming loss depending on which morning the window starts. A silently
  defaulted thirty days would be a different goal from the one that was set.
- **A rate is quoted per week, never per day.** `linearTrend` returns units per
  day because that is the natural unit of a daily series. Nobody thinks in
  kilograms per day, and nobody would have typed `0.036`.

The sign carries the direction: *"at least −0.5 kg/week"* is a cut, and reading
its `at_least` as "up" would report a cut and a bulk as compatible.

## 4. Honest projection

§8.9(4): *"Confidence must be visible where it exists. Trend lines carry a band.
**A projection is rendered dashed with an interval.**"*

None of this is new work — `trendBand` and `projectForward` were built for Gym
and are reused verbatim. Four properties they already have, restated because
they are what makes the goal screen defensible:

| Property | Why |
|---|---|
| `MIN_TREND_POINTS = 4` | Residual variance uses *n* − 2 degrees of freedom. Below four there is no line, only points and a hope. |
| `MAX_PROJECTION_DAYS = 14` | Roughly the horizon over which a bulk's slope stays plausible, and short enough that being wrong is visible before it is acted on for a month. |
| Prediction interval, not the interval for the mean | The extra `1` under the root is the spread of an individual future observation. A band covering only the mean would be materially too narrow for what it is read as — *"where will I actually be"*. |
| `TREND_CAVEAT` renders under every line | Daily readings are autocorrelated, so the interval is **narrower than the truth**. The string lives in `core` so a redesign cannot quietly drop it. |

**`insufficient` is a first-class status,** per §10.9's *"must degrade to
'insufficient data' rather than guessing"*. It renders in `neutral`, not
`caution` — "we do not know yet" is not a warning, and colouring it as one would
make the first week of every goal look like a problem.

**`projectionConfidence` is a fit, and every surface says so.** It is filled from
`rSquared` — how well the line describes the points supplied — which is not a
probability that the projection holds. §10.6 exists because that is the
distinction people stop making first.

### The arrival date is uncapped, and the drawn projection is not

Two different questions, two different bounds. A dashed line beyond a fortnight
invites being read as a forecast, so the chart stops at fourteen days. An
arrival *date* is one number the operator asked for by setting a horizon, and
clamping it to a fortnight would silently answer something else — so it
extrapolates freely, bounded only at `MAX_ARRIVAL_DAYS = 730`. Past two years,
`null`: "you will get there in 2043" is arithmetic, not information.

### The reference band is not drawn on the goal chart

The target is stated in words above the plot rather than drawn as a horizontal
line. §8.9(2)'s annotations are *events on the time axis* — medication starts,
travel — and a value line is a different object that the chart layer does not
have a vocabulary for. Adding one is a design-system change, not a goal feature.

## 5. Tension detection

§4.10: *"a bulk and a visible-abs goal are in tension, and the system should say
so rather than let both quietly fail."*

The failure is specific: two goals declared six weeks apart, neither wrong,
together unachievable. Nobody notices, both stall, and the conclusion drawn is
"I have no discipline" rather than "these two cannot both happen".

Two kinds:

- **Direct** — two active targets on the same metric pointing opposite ways.
  Mechanical, and rare in practice.
- **Antagonistic** — two targets on different metrics that a small hand-written
  table says are physiologically opposed. `ANTAGONISTIC_PAIRS` has three entries
  and each carries the sentence explaining itself.

That table is deliberately tiny. **Every entry is a claim about the body**, so
the bar for adding one is that the sentence beside it would survive being read
to a clinician. A generated list of "metrics that correlate negatively" would be
exactly the unfounded assertion §10.6 exists to prevent.

**It reports; it never arbitrates.** No score, no ranking, no suggestion to drop
one. Which of your goals matters more is not a thing a computer knows (P5), and
the screen says so in a line under the list.

Only `active` goals are considered. A paused or abandoned goal is not being
pursued, and reporting it would turn goal archaeology into a nagging surface,
which §14.1's no-guilt rule forbids.

## 6. The review ritual

`/life/goals/review` deliberately does **not** answer "where am I" — the overview
already does. It answers the one thing only a snapshot history can:

> Has the picture moved since I last looked?

And then it says the part that matters: **it cannot tell you whether it moved
because you did or because the data behind it was corrected.** Guessing would be
the more useful-looking answer and the wrong one.

No score, no grade, no streak. A review that scored the week would be a streak
with a longer name, and §1.5 refused a streak because "miss day 34 and the
incentive collapses, which is precisely the anxiety-amplifying dynamic P6
prohibits".

## 7. Goals are not bitemporal, and that is deliberate

Unlike `condition` or `medication_schedule`, closing a goal is an `UPDATE`.

A goal that was abandoned was not *believed to be something else* — it was
abandoned, on a date, for a reason, and `closingNote` plus `supersedesGoalId`
carry that. §9.5 is explicit that bitemporality stops at `medical_event` and its
subtypes; extending it here would double the query cost of every screen for a
distinction goals do not have.

One small honesty rule inside `close`: **only an achievement gets a date.** An
abandoned goal has a closing note and a null `achievedAt`, because it was not
achieved and a populated column there would read as though it had been.

## 8. What is not built

| Not built | Why |
|---|---|
| Milestone decomposition | §4.10 future expansion. A goal with sub-goals is several goals; the tension detector already handles the interesting part of that. |
| Effort-versus-outcome analysis | Needs the detector suite and §10.6's controls. December. |
| Calibration scoring of past projections | §10.9 requires "every prediction is stored and compared against what actually happened" and §12 puts the prediction engine in **V3 Q3**. The snapshots being written now are what that will score — the data is accumulating from tonight. |
| A goal on a metric that does not exist yet | Permitted and handled: a target on `nutrition.protein` written before Nutrition ships produces an empty series and an `insufficient` status rather than failing the page. |
| Editing a goal | Close it with a note and set a new one, linked by `supersedesGoalId`. That is what "goal archaeology" means, and an edit would erase the thing worth reading in year three. |
