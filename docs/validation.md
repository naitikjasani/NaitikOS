# Validation — the V1 window

**Status:** instrumentation implemented, 10 August 2026. The window itself runs
30 August – 29 September. · **Blueprint sections:** §1.4, §1.5, §5.11, §12
**Related:** [insights.md](insights.md) · [daily-close.md](daily-close.md)

---

## 1. What this phase is

§12's V1 phase is the only one in the roadmap that forbids building:

> **No new features.** Use it daily and fix what actually hurts.
> Instrument: capture latency, Daily Close completion, drop-off points, sync
> failures. **Gate: Compounding Days ≥ 25 of 30 by 29 September.** If the gate is
> missed, October is spent on capture friction, not on V2.

So the work is the instrumentation, and it had to land *before* the thirty days
rather than during them — a window that produces no measurements is a window
spent for nothing.

## 2. Two of the four things were not instrumented at all

`capture.latency` was in the metric registry, in `METRIC_NAMES`, and in the
`app_event` schema. **Nothing wrote it.** The §1.4 health metric with an explicit
`p50 < 5 s` budget had no source, and had had none for three milestones. The same
was true of `route.transition`, which the counter-metric depends on entirely.

This is the recurring failure in this codebase and it is worth naming again: a
check that is declared, typed, and never executed reads exactly like a check that
passes. The developer dashboard now lists **raw event counts by name** for
precisely this reason — a metric reading zero because nothing emits it looks
identical to one reading zero because nothing happened, and that list is the only
way to tell them apart.

| §12 asks for | Source now |
|---|---|
| Capture latency | `recordCaptureLatency`, once per page load, from `performance.timeOrigin` |
| Daily Close completion | `daily_close.submitted` in `useDailyClose` |
| Drop-off points | `daily_close.started`, paired with the above |
| Sync failures | `sync.failed`, already emitted by the upload path |

## 3. Capture latency is measured from cold start, not from submit

§1.4 defines it as "cold start → logged observation persisted, p50". Measuring
from the submit button would report a system that boots in eight seconds and
writes in two hundred milliseconds as comfortably inside a five-second budget —
the opposite of what the metric protects.

It is recorded **once per page load**. The second capture in a session is not a
cold start, and including it would drag the median towards the warm case and hide
exactly the regression the budget exists to catch.

## 4. The counter-metric is an approximation, and says so

§1.4 wants "median daily foreground minutes, ≤ 6 min **and falling**". A browser
gives no reliable foreground timer, so `foregroundMinutesByDay` sessionises route
transitions with a five-minute inactivity gap and sums the spans.

Two biases, both documented in the code rather than corrected for:

- **A single-transition session counts as zero.** Opening the app, reading Today,
  closing it registers no span — and that is the most common session shape in a
  system whose counter-metric wants to be small. The figure understates.
- **A tab left open counts up to five minutes past the last interaction.** That
  overstates.

They do not cancel, and pretending they do would be worse than the approximation.
The figure is useful for its *trend*, which is what §1.4 actually asks for.

## 5. §1.5's anti-goal is a function

> "the North Star must never be pursued by making the Daily Close longer or
> richer. If Compounding Days rises while median capture latency also rises, the
> metric has been gamed against its own purpose."

`detectGaming` is that sentence. It compares the trailing thirty days against the
thirty before them and fires only when Compounding Days rose *and* either latency
or time-in-app rose by more than ten percent. Deliberately conservative: a false
positive here would have the operator "fixing" a system that is working.

## 6. The gate

`evaluateGate` computes it, on any day, and returns five verdicts rather than two:
`passed`, `missed`, `on_track`, `at_risk`, `unreachable`.

The last one is the useful addition. A gate that says nothing until 29 September
arrives as a surprise; learning on the 20th that it is **arithmetically out of
reach** is worth more than learning on the 29th that it was missed.

Every verdict carries its `consequence` — what October is for — because §12 says
"the discipline to honour it is the difference between a system that lasts and a
graveyard of half-built modules", and naming the consequence is what makes it a
decision rather than a number.

### §12 disagrees with itself by one day

The gate is "≥ 25 of **30** by 29 September"; the phase is dated "**30 August to
29 September**", which is thirty-**one** days inclusive.

Resolved in favour of the dates. The threshold — 25 — is unambiguous and is what
the gate turns on; the extra day makes it very slightly easier, which is the right
direction to err when the alternative is arguing about it on the day.

### Where the gate is *not* shown

Not on `/today`. §1.5 refused a streak because "miss day 34 and the incentive
collapses, which is precisely the anxiety-amplifying dynamic P6 prohibits", and
§14.1 forbids guilt copy about gaps. A countdown on the daily surface would be
that streak rebuilt with a different name.

It lives on `/settings/developer`, framed as a fact about the *project*: whether
October is V2 or capture friction.

## 7. Privacy — the schema is the guarantee

§5.11: "Event names and numeric measurements only. **No payloads, ever.** The
schema cannot represent user content, which makes leakage impossible rather than
prohibited."

Four layers implement that sentence:

1. `app_event` has no column that could hold content.
2. `telemetryEventSchema` has no `payload`, `properties`, or `metadata` field, so
   Zod strips anything sent.
3. `telemetryNameSchema` is a **closed enum** — a free-text event name is a
   payload with extra steps, and `capture.latency.mood_2` is user content in a
   name field. A test asserts it equals `METRIC_NAMES` exactly, so a client
   cannot emit an event the server silently drops.
4. `routePattern` collapses every id and day key client-side, and the contract
   rejects a populated path server-side.

Day keys are collapsed as well as ids. `/timeline/2026-09-14` is not an
identifier, but it is still a fact about the operator's life — which day they
went back and looked at — and telemetry has no business holding it.

Retention is ninety days, swept by the nightly job's `prune-telemetry` step
rather than by a database cron, so the deletion appears in `job_run` like every
other scheduled effect. A sweep nobody can see the result of is a sweep nobody
notices has stopped.

## 8. The gap that would have made the window worthless

§2.1's definition of done:

> "thirty consecutive days of real use by the operator, with a Compounding Days
> count of ≥ 25 and **no manual database intervention required**."

As of week 4 that last clause was false. Defining an evening skincare routine or
putting Venlafaxine in the register meant running SQL — and until they exist,
routine adherence and medication adherence never fire, which means §2.1's *only*
insight family produces nothing for the entire validation window.

So three authoring surfaces ship with the instrumentation, deliberately minimal:

| Register | Where | What it is |
|---|---|---|
| Routine definition | `/body/skin/routine` | A name, a period, an ordered list of labels |
| Medication | `/mind/meds` | Substance, strength, start date, one schedule |
| Crisis plan | `/settings/profile` | §4.7's four fields and contacts |

These are not new features. They are the missing halves of features already
shipped, and the test each had to pass was "does its absence stop the thirty days
from happening".

Three decisions inside them worth knowing:

- **They do not queue.** Every other write goes through the outbox; these go
  straight to the network. A routine definition queued behind twelve
  step-completions would be applied *after* them, and those twelve would have
  been counted against a denominator that no longer existed. Ordering a schema
  change behind the data it governs is the one case where the outbox is wrong.
- **A removed step is tombstoned, never deleted.** `routine_log` references
  `step_id`, so a hard delete would orphan months of adherence history. A
  retired step leaves *past* adherence intact and stops counting towards *future*
  ratios — the only reading of "I dropped the toner" that does not rewrite March.
- **The schedule is mandatory on registration.** A medication with no schedule
  has no denominator and never appears in an adherence figure. Registering one
  without would produce a row that *looks* tracked and is not, which is worse
  than not registering it.

## 9. The crisis plan is written in settings, on purpose

§4.7 requires it "entered by them when well". A form on `/mind` would be met on
the days Mind is opened — disproportionately the days it should not be met.

`/mind` surfaces an *invitation* instead, and only when `shouldInvitePlanning` is
true: no plan on file **and** no current run of severe days. The invitation and
the form are in different places so that the path to writing one always starts on
a settled day.

That function was written in week 4, returned by the API, and rendered by
nothing. This is the same defect class as §2 — declared, typed, unexercised — and
it is now wired.

## 10. What to do on 29 September

Open `/settings/developer`. The gate card states the verdict and the consequence.

If it says `missed` or `unreachable`, October is capture friction. The two
numbers to read first are the Close funnel — how many were opened and left — and
median capture latency, because between them they say whether the ritual is too
slow or too much.
