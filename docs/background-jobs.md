# Background Jobs

**Status:** infrastructure implemented, Week 2 · **Blueprint sections:** §5.2, §5.11, §5.13, §5.16, §9.7
**Related:** [events.md](events.md) · [storage.md](storage.md)

---

## 1. Exactly one scheduled entry point

§5.2:

> "**Exactly one scheduled entry point** — a nightly job at 03:00 local, which
> runs derivation, detectors, and rollups in sequence. One cron, idempotent, safe
> to re-run, and manually triggerable from `/settings/developer`. Every additional
> scheduled job must justify itself against C3."

So this is **not a queue with workers.** It is an ordered list of steps that one
cron invocation walks, plus a table of deferred work that the same invocation
drains. There is no second scheduler, no worker pool, and no polling loop.

That is a real constraint rather than a simplification. At n=1 with ~50 actions a
day there is no throughput problem, and C3 says the system "must survive
three-week gaps in attention" — a queue is a second piece of infrastructure to
operate, and §5.2 is explicit that every scheduled job "is a liability that must
justify itself".

```
03:00 local ──► POST /api/jobs/nightly ──► runNightly(steps, deps)
                                              │
                                              ├─ walks JOB_STEPS in order
                                              ├─ writes job_run on start
                                              └─ writes job_run on finish, ALWAYS
```

---

## 2. The step list

`JOB_STEPS` is the canonical order. The runner walks **it**, not registration
order — dependencies between steps are a property of the pipeline, not of which
module happened to import first.

| # | Step | Registered? | Notes |
|---|---|---|---|
| 1 | `derive-observations` | no | First: everything downstream reads what it writes |
| 2 | `refresh-rollups` | no | §5.6, §9.7 |
| 3 | `snapshot-goal-progress` | no | §4.10. After rollups — the projection is fitted over them |
| 4 | `resolve-predictions` | **yes** | §10.9. **Before** `make-predictions`; see below |
| 5 | `make-predictions` | **yes** | §10.9, over a window that includes today |
| 6 | `run-detectors` | **yes** | §10.6. After rollups — a trend must exist first |
| 7 | `generate-embeddings` | no | V2, local-only (P7) |
| 8 | `generate-thumbnails` | no | For objects that arrived without them |
| 9 | `verify-media-integrity` | **yes** | §9.8 + the **media upload** outbox's health, not the capture outbox's — see §8 |
| 10 | `assert-data-integrity` | **yes** | §5.16's assertions. Registered 8 September 2026; see §6a |
| 11 | `schedule-notifications` | no | §5.9. No separate scheduler |
| 12 | `rebuild-timeline` | no | When a projector change makes entries stale |
| 13 | `maintain-partitions` | **yes** | §9.7. **Before** the collapse; see below |
| 14 | `downsample-samples` | **yes** | §9.7, past 90 days |
| 15 | `prune-idempotency` | **yes** | §5.7's seven-day TTL. Registered 7 September 2026; see below |
| 16 | `prune-telemetry` | **yes** | §5.11's ninety-day retention |
| 17 | `drain-task-queue` | **yes** | **Last**, so work enqueued earlier tonight runs tonight |

Ten are registered. The seven that are not each wait on something that is not
wired: `generate-embeddings` and `generate-thumbnails` need the local model and
the image pipeline, `schedule-notifications` needs a delivery channel,
`verify-media-integrity`'s §9.8 half needs the storage driver, and the rest do
**domain** work that arrives with its domain — a rollup step is meaningless
before there is anything to roll up.

`assert-data-integrity` was the one remaining step with no external dependency
at all: it needs a connection and nothing else, which is why it is registered
ahead of the six that do.

`prune-idempotency` was the exception, and not a deliberate one. Its domain
existed and `IdempotencyRepository.prune` was implemented; the step was simply
never added to `stepsFor`. That mattered more than a housekeeping omission
should have, because `claim()` returned `in_flight` for any incomplete record
without consulting `expires_at` — so a request that died between `claim()` and
`complete()` blocked every retry of that capture permanently, and the seven-day
recovery `release()`'s comment promises was carried entirely by a sweep that
never ran.

The expiry is now enforced in `claim()`, where it is relied upon; a guarantee
that depends on a job being wired up is not a guarantee. This step is back to
being what it should always have been — housekeeping that stops the table
growing without bound, and that cannot halt the run.

Running a partial list is deliberate, not incomplete. §5.16's alert watches for
the *absence* of a completion record, so a record has to be written from the
first night the cron is enabled — otherwise the alert's first firing is a false
positive, and an alert that cries wolf once gets muted.

### Two orderings in this list are load-bearing

**`resolve-predictions` before `make-predictions`.** Tonight's new prediction
for a metric is fitted over a window that includes today's reading; yesterday's
prediction *about* today must be scored against that reading before it is
folded into anything. Reversing them would let a prediction be graded against a
window its own successor had already been fitted on.

**`maintain-partitions` before `downsample-samples`.** Both touch `sample`, and
creating a partition takes a brief `ACCESS EXCLUSIVE` lock on the parent. Taking
it first means the lock lands on a quiet table rather than queueing behind a
collapse that is deleting a month of rows.

### Step names are stable identifiers

They key the completion record §5.16 alerts on. Renaming one makes the alert fire
for a step that no longer exists and stay silent for the one that replaced it.

---

## 3. Idempotency is required, not encouraged

§5.2 says the nightly run is "idempotent, safe to re-run". Every step must
produce the same result when run twice on the same day — because it *will* be, by
the manual trigger, by a retry, and by an operator debugging at 11pm.

---

## 4. Failure semantics

```ts
type JobStep = {
  name: JobStepName;
  describes: string;
  haltOnFailure: boolean;   // ← the interesting field
  run(context): Promise<Result<JobStepOutcome, DomainError>>;
};
```

**`haltOnFailure: true`** for steps later steps depend on. A failed derivation
makes every rollup wrong, so continuing would write bad aggregates that look like
data.

**`haltOnFailure: false`** for independent steps. A thumbnail failure must not
prevent the integrity check — and the integrity check is the one that matters
more. Note the corollary, which §6a takes up: the integrity check's own flag is
also `false`, because the flag governs a *failed query* rather than a broken
record, and the two are not the same event.

A halted run marks the remaining steps `skipped` and **records them**. §5.16
alerts on absence, and a skipped step that produced no row is indistinguishable
from one that was never registered.

A step that *throws* rather than returning `Err` is a bug (§5.12), and it is
captured as `step_threw` rather than being allowed to lose the completion record
for the steps that worked. (The figure used to be given as a count here, which
drifted the moment a tenth step was registered — the point is that the record
survives, not how many rows are in it.)

---

## 5. The wall-clock budget

Default fifteen minutes. A run that has not finished by then is stuck, and on a
serverless platform it will be killed mid-step anyway — better to abort
deliberately and write a `halted` record §5.16 can alert on than to be terminated
with no record at all.

The budget is checked **before** each step, not during one. There is no way to
interrupt an in-flight step without cooperative cancellation, so a single step
that blows the whole budget still runs to completion. `JobStepContext` carries an
optional `AbortSignal` for the day a step is long enough to need it.

---

## 6. The completion record

`job_run`, one row per invocation, written on **every** exit path.

§5.16: "Absence of the record by 05:00 raises an alert."

That framing is what makes `finish()` load-bearing in an unusual direction: a
recorder that throws produces a run that did all its work and left no record, and
the alert then reports a nightly run that never happened.

```
GET /api/jobs/nightly  →  { last: {…}, healthy: boolean }
```

`healthy` is `hasCompletedRunSince(24h ago)` and requires **`isManual = false`**.
A human pressing the button must not satisfy an alert that exists to detect the
cron having stopped firing — otherwise debugging the problem is what makes the
symptom disappear.

`errorMessage` on the row holds **step names and error codes only**, never a
message from the failure itself. A step that failed on a constraint violation
would otherwise write the offending row's values into that column, and §5.11's
"no payloads, ever" applies to a job's account of itself too.

### Runs left in `running`

A serverless platform terminates mid-step with no chance to write `finish`, so
these accumulate. `abandonedJobRuns(olderThan)` reports them. They are **not** the
same as a failure — the work may have completed — and conflating them makes the
failure count meaningless.

**They are marked, never deleted.** The decision and its reasoning, because the
obvious sweep is the wrong one:

- §5.16's alert fires on the **absence** of a completion record. An unfinished
  row *is* that absence in physical form — the only surviving trace that an
  invocation started on a night nothing finished. A delete destroys the evidence
  the alert exists to provide, and it does so in the silent direction: the table
  would look tidiest on exactly the mornings something went wrong.
- Nor would deleting buy much. `job_run` has **no retention policy at all** —
  every successful night keeps a row too, so the table grows by roughly 365 rows
  a year whether or not anything is killed, and abandoned rows are a small
  subset of that. Deleting them trades the whole of a signal for a rounding
  error of the growth. If `job_run` needs bounding, and one day it will, the
  honest fix is a retention sweep over the *whole* table under §9.4's line
  between domain data and operational exhaust — decided once, applied to
  succeeded rows first. That is a policy decision, not a tidy-up, and it is not
  made here.
- What marking bounds is the set of rows a maintainer has to **think** about.
  Every stranded row is judged once, and `/settings/developer` then says which
  are explained and which are not.

`markAbandonedJobRuns` does the judging, and it runs inside the recorder's
`finish` — immediately after the completion write, never before it. That
placement is the proof: **a run that has just recorded its ending is itself the
evidence that an older run of the same job is not still in flight.** A nightly
*step* could not supply that evidence, because a step executes during a run,
when tonight's ending has not happened yet — it would always be judging last
night's corpse a night late.

Three conditions, and each on its own excludes a live run:

| # | Condition | Why it holds |
|---|---|---|
| 1 | Started more than `ABANDONED_RUN_AFTER_MS` (30 min) before the judging run **started** | The runner's budget is 15 minutes and it aborts itself, recording `halted`. Nothing healthy is half an hour old and unfinished |
| 2 | No ending recorded — `status = 'running'`, `finished_at IS NULL` | A run that ended, however badly, is out of scope by definition |
| 3 | A later run of the same job has completed | Supplied by the caller: `finish` is that later run |

Condition 1 is what makes the overlap case safe. A human pressing the button
while cron is mid-run produces two live invocations, and the manual one
finishing would otherwise judge the cron one — but the cron run is minutes old,
nowhere near the cut-off. The reference instant is the judging run's *start*
rather than its finish for the same reason: the earlier instant marks strictly
fewer rows. And if all three were somehow satisfied by a run that is genuinely
alive, the mark is self-correcting — that run's own `finish` overwrites
`status`, `finished_at` and `error_message` with its account of itself. The mark
is a label on a row, never a claim on it.

Scoped to one job name, deliberately. A finished `nightly` says nothing about
whether a single-step run started from `/settings/developer` is still going, so
it must not judge one; the consequence is that a stranded single-step run stays
unadjudicated until that step is next run alone, which is honest — nothing has
proved it dead.

**What the mark is, and what it should be.** `error_message` carries
`abandoned:no_completion_record` — a code, in a column whose stated contents are
"step names and error codes only". The state being expressed belongs in
`status`, and `job_status` is a Postgres enum with no `abandoned` member, so
putting it there is a migration; §13.2 keeps those out of feature commits. The
cost of waiting is one column reading slightly off. When the enum catches up
this moves, and `abandonedJobRuns` is the only reader to follow.

Leaving `status` alone has a second benefit worth stating, because it would be
the first casualty of a new enum member: `docs/runbooks/incident.md`'s
"runs killed mid-step" query is `WHERE status = 'running' AND started_at <
now() - interval '6 hours'`, and it still returns marked rows. A run moved to
an `abandoned` status would vanish from the query an operator reaches for at
2am, silently. The marker is also safe under that runbook's disclosure rule —
`job_run.error_message` is "step names and error codes only", and this is a
code.

Three things the mark deliberately does **not** do:

- It does not set `status = 'failed'`. The work may have completed, and folding
  these into the failure count would make that count mean "failed, or possibly
  fine".
- It does not set `finished_at` or `duration_ms`. Nothing knows when the
  invocation died, and a plausible-looking instant is a fabricated fact in a
  record §9.4 keeps for ever.
- It does not hide the row from `abandonedJobRuns`. The mark records that a row
  has been *judged*, not dealt with. Hiding judged rows would quietly turn the
  sweep into the delete it is not.

An **un**marked row past the cut-off is the louder of the two states, and
`/settings/developer` shows the difference: it means no later run of that job
has recorded an ending since — so either the pipeline has been down since, or
that row is the most recent thing that happened.

The failure of the sweep itself is swallowed, and it is the only swallowed
failure in the recorder. `finish` returns `void`, so there is nothing to hand a
count to, and a housekeeping statement that threw would turn a run that has
already recorded itself into an unhandled 500 — which makes cron retry, and a
retry is a second run (§9). The cost is visible rather than silent: the rows
stay unmarked and keep appearing on the dashboard as unadjudicated.

---

## 6a. The integrity assertions (§5.16)

§5.16 asks for standing assertions over the record:

> "**Data-integrity assertions**, run nightly: no observation dated in the
> future; no medication with an end date before its start; no orphaned media
> rows; no observation referencing an unregistered metric key. These catch the
> class of bug that silently corrupts a longitudinal record and is otherwise
> discovered years later."

`packages/db/src/repositories/integrity.repository.ts` implements them as
read-only queries. **The step writes nothing, and must never be made to.** §9.1
makes the observation log append-only; a nightly job that *repaired* what it
found would rewrite the record at 03:00, unattended, on the strength of a
heuristic, and the evidence of what it changed would be the thing it destroyed.
A violation is a fact for a human, not a task to dispatch.

### An assertion earns its place only if the schema cannot express it

A CHECK or a foreign key is enforced at write time, on every path, by the
component that cannot be bypassed. A nightly query finds the same corruption up
to twenty-four hours later and only if the job ran. So re-checking a constraint
nightly is theatre — it can only pass — and a suite of assertions that always
passes teaches the operator to stop reading it.

Two of §5.16's four named assertions are already write-time guarantees and are
**not** re-checked here: an observation referencing an unregistered metric key
is impossible under `observation_metric_key_metric_key_fk` (§9.3(1)), and
`upload_outbox.media_object_id` cannot dangle because `events.ts` does carry
`.references()` — verified against `pg_constraint`, not assumed.

### What is asserted

Eleven assertions, run as 33 queries — the polymorphic-subject check runs once
per subject type and the two clinical checks once per subtype table, so the
report can name the table rather than the family.

| Assertion | What no constraint can catch |
|---|---|
| `observation.future_dated` | `now()` is STABLE, so Postgres refuses it in a CHECK — the same reason §9.6's date-truncated index is not implementable. §5.16 names this one |
| `observation.orphaned_subject` | §9.3(3)'s `subject_type`/`subject_id` are "deliberately **not** a foreign key". A subject that was never written, or has since gone |
| `observation.unknown_subject_type` | A subject vocabulary this reader has never heard of — a gap in the *reader*, reported so the assertion cannot pass by not looking |
| `observation.supersession_dangling` | There is no self-referential FK on `superseded_by_id`; migration 0001's trigger permits the UPDATE and checks no target |
| `observation.supersession_cross_metric` | A bodyweight cannot be corrected by a mood score. The old metric silently loses a reading, the new one silently gains one |
| `observation.supersession_fan_in` | A chain is a list, not a tree. One successor for two readings means one was retracted with no replacement |
| `observation.supersession_cycle` | `observation_no_self_supersede` rules out a one-row cycle. A two-row one satisfies every constraint *and* fan-in, and both readings vanish from every current-only read |
| `medication.stopped_before_started` | §5.16 names it. See the outstanding migration below |
| `clinical.orphaned_by_tombstone` | Each §9.3 subtype filters *its own* `deleted_at`; none checks the supertype's. A condition across two rows, which CHECK cannot see |
| `clinical.believed_interval_overlap` | §9.5's transaction axis, on the eight subtypes with no equivalent of `medication_schedule_no_overlap` |
| `upload_outbox.uploaded_without_object` | The FK says the target exists; nothing says the column is *populated*. A row claiming success with nothing in it has left §5.16's sync-health alert's field of view |

`sample` is deliberately untouched. Device data under a ninety-day retention has
no correction chain, no polymorphic subject and no tombstone — there is nothing
here for the one table that reaches tens of millions of rows to violate.

### What was considered and dropped

- **Overlapping believed schedules for one medication** —
  `medication_schedule_no_overlap`, a GiST exclusion constraint from migration
  0002. The same *shape* is checked on the eight clinical subtypes, which have
  no equivalent.
- **`observation.unit` against `metric.canonical_unit`** — not corruption. The
  column is denormalised on purpose so a registry whose canonical unit changed
  in year eight does not relabel year three. A mismatch is history working.
- **§5.16's "no orphaned media rows"**, in the one direction a foreign key
  cannot cover: `media_attachment.entity_type`/`entity_id`. Nothing in shipped
  code inserts `media_attachment`, so the vocabulary does not exist. An
  assertion over an empty table with an invented vocabulary would report zero
  every night for years and read as assurance. It arrives with the first writer.
- **The §9.8 storage check** — owned by `verify-media-integrity`, which needs
  the storage driver where this step needs only a connection.
- **A Daily Close against the observations it wrote** — there is no
  `daily_close` row to disagree with. The Close *is* observations plus a
  completion marker, so there is no denormalised count for the log to
  contradict.
- **`metric_rollup.sample_count` against its bucket** — `refresh-rollups`
  recomputed the same window from the same log twenty minutes earlier in the
  same run, so a disagreement would be a bug in code that just ran; and
  expressing the comparison means restating the day-bucketing in SQL, which
  `rollup.repository.ts` argues must exist exactly once.

### `haltOnFailure: false`, and the flag is not the interesting decision

`haltOnFailure` governs exactly one thing: what happens when `run` returns
`Err`. And a violation does **not** return `Err` — it returns `ok`, with the
finding in the note and the log. So the flag is being set for the case where the
queries *would not execute*, not for the case where the record is broken.

That settles it. A read that failed has taught us nothing, and the seven steps
after this one depend on none of its output. Halting would skip all of them to
punish a failed SELECT — and skipping `maintain-partitions` on the 31st because
an integrity query timed out is how the 1st fails on a constraint error at
midnight.

The one argument the other way is `downsample-samples`, the only later step that
destroys anything. Preserving evidence would be a reason to stop, and it does
not apply: every assertion reads `observation`, `medication`, the clinical
subtypes or `upload_outbox`, and `sample` is outside all of them.

### A violation is a *successful* run of this step

The temptation is to return `Err` so the step goes red. It is wrong for a
mechanical reason: the runner records `note` for a succeeded step and **drops it
for a failed one** — "absent for a `failed` step (an `Err` carries a code, not
an outcome)". Failing would discard the one thing the step exists to produce.
The step did its job: it looked, and it found something.

### How a violation is surfaced

```
job_run.steps[].rowsAffected  →  rows flagged (a read-only step's only number)
job_run.steps[].note          →  "3 rows across 2 assertions: upload_outbox.uploaded_without_object ×2, clinical.orphaned_by_tombstone ×1"
logger.error                  →  one line per violation: assertion code, table, up to 20 row ids
```

The note is clamped to 200 characters, so it is a headline. `summariseIntegrity`
keeps it inside the bound by construction — it lists the three assertions with
the most rows and counts the remainder — rather than letting `clampNote`
truncate mid-identifier, because half an assertion name is a name nobody can
grep for.

The row ids go to the logger, `identifiers` only, never a value (§5.13 and the
`@naitikos/no-sensitive-log` rule). Ids are space-separated so the line pastes
into `where id in (...)`. §9.4 keeps application logs out of Postgres, so this
step creates no permanent record of the ids — which is the right split: the note
says *that* something is wrong tonight, the log says *which rows* while the
operator is reading it, and the database holds the truth, since the offending
rows are still there when someone goes to look.

**No metric is emitted.** `METRIC_NAMES` is a closed union restated as a wire
contract in `packages/api`, with an equality test in each package, so an
`integrity.violations` name is a coordinated change across three packages rather
than a line in a step — the same reasoning recorded for the media outbox gauges
in §8. Until then the log line is the signal.

### Two real gaps found and not fixed

Both are schema work, and §13.2 keeps migrations out of feature commits.

1. **The eight clinical subtypes have no interval-ordering CHECKs.**
   `condition`, `medication`, `medication_schedule`, `lab_panel`, `appointment`,
   `procedure`, `treatment_course`, `side_effect` and `symptom` all share §9.5's
   `bitemporal` block, and only `medical_event` received
   `medical_event_valid_ordered` and `medical_event_recorded_ordered`. So
   `valid_to < valid_from` and `recorded_to < recorded_from` are both insertable
   on every subtype. Deliberately **not** asserted nightly, because they are
   exactly expressible: the honest fix is a migration adding sixteen CHECK
   constraints, not a query that finds the damage a day late.
2. **`medication` has no `started_at <= stopped_at` CHECK**, where six other
   tables in the schema got their `*_ordered` one — `workout_session`,
   `sleep_night`, `trip`, `visit`, `life_span`, `financial_account`. This one
   *is* asserted nightly, for the single reason that §5.16 names it, and the
   assertion should be retired when the constraint lands.

---

## 7. Deferred tasks

Work an event handler defers. The bus dispatches synchronously, so anything slow
— thumbnailing a 12 MB photo, generating an embedding — becomes a row here rather
than blocking the request that emitted it.

```ts
TASK_KINDS = [
  'thumbnail.generate', 'embedding.generate', 'document.extract-text',
  'timeline.reproject', 'notification.send', 'ai.summarise',
];
```

**A row here is work that will happen tonight, not work that is happening now.**
That is the single most important thing to understand before adding a task kind:
a caller expecting a thumbnail in five seconds will be disappointed by up to
twenty-four hours.

### The subject is a reference, never a payload

Same reasoning as ADR 0005: a task carrying a copy of the data would be a copy
that can drift, and a task table is exactly where a stale copy sits unnoticed for
a week.

### One live task per (kind, subject)

A partial unique index on `WHERE status IN ('pending','running')`. Enqueuing a
thumbnail for the same photo twice must not produce two rows — the second does
redundant work and can race the first.

Partial, so a *settled* task does not block a new one. Re-running a thumbnail
after a code change has to be possible.

### Retries

Three attempts, matching the event bus, then `dead`. Backoff is coarse — **1h,
6h, 24h** — because the runner fires nightly and finer granularity would be
theatre. The point is a second chance tonight and a third tomorrow, rather than
three attempts in one run against the same broken dependency.

`dead`, not `failed`, on exhaustion: §5.16 alerts on the dead rows, and a
transient failure that will be retried tonight must not page anyone.

---

## 8. Observability

No vendor. §5.11: "**No third-party analytics. Ever.** (P7.) … An `app_event`
table in the same Postgres … Event names and numeric measurements only. **No
payloads, ever.** The schema cannot represent user content, which makes leakage
impossible rather than prohibited."

So "no vendor lock-in" here does not mean *swappable* vendors — it means **no
vendor**. §5.14 names the adversary: "a compromised third-party dependency
exfiltrating data", and a telemetry SDK is a dependency with network access and a
legitimate reason to use it.

| Signal | Where it goes | Blocking? |
|---|---|---|
| `Logger` | stdout, one JSON object per line | no |
| `Metrics` | `app_event` | **fire-and-forget** |
| `Tracer` | log lines (traceId + spanId) | no |
| `ErrorReporter` | log + a counter | no |
| `AuditHook` | `audit_log` | **yes — awaited** |

### The type system is the enforcement

`LogContext` has **no `data` field**. Every signature accepts names and numbers;
none accepts an arbitrary object. A `properties?: Record<string, unknown>`
parameter is how a journal entry ends up in a metrics pipeline. Where a value
genuinely aids debugging it goes in `protected` as a `Sensitive<T>`, whose
serialiser emits `[redacted]` — so the logger *physically cannot* write a journal
entry to stdout.

§5.13 makes the argument: "relying on a redaction *list* fails the moment someone
adds a field and forgets — relying on a *type* fails loudly at compile time."

`METRIC_NAMES` is a closed union for the same reason. §1.4 warns that "vanity
metrics are actively harmful in a single-user product because there is no one to
impress."

### Two outboxes, and the metrics used to conflate them

Read this before wiring §5.16's sync-health alert, because the old names
invited the wrong conclusion and the wrong conclusion is a green light.

Until 7 September 2026, `verify-media-integrity` and `GET /api/media/uploads`
both emitted `sync.outbox.depth` and `sync.outbox.oldest_age_seconds`. Both read
`platform.outbox`, which is `createUploadOutboxRepository` — the `upload_outbox`
table, holding a **photograph** waiting for a signed URL.

§5.7's **capture** outbox is a different thing entirely: the IndexedDB queue in
`apps/web/lib/offline/outbox.ts`, holding a Daily Close made in aeroplane mode.
It contributes nothing to either gauge, and no server-side query can see it —
one browser profile on one device.

So an alert built on the old names would have watched media uploads, of which
there are currently **zero**: nothing in shipped code inserts `media_object`,
and `completeUploadSchema` requires a `media_object_id` that would fail its
foreign key. The alert would have sat at zero and silent while a Close the
operator believes is saved waited in a phone in a drawer. That is worse than no
alert, because a green signal reads as evidence.

The two server emitters now carry a `route` dimension —
`/api/jobs/nightly` and `/api/media/uploads` — so they are at least separable in
`app_event`, which has a `route` column and no column for any other dimension
(`stepName`, `outcome` and `eventType` are on `MetricDimensions` and are
discarded by `createPostgresMetrics`).

**The rename has been made, and it went the other way round.** The server's
media gauges became `media.outbox.depth` and `media.outbox.oldest_age_seconds`;
`sync.outbox.*` was *kept* and reserved for the capture outbox. That direction
follows from where the reading has to come from: the capture queue is in
IndexedDB on one device, so only the client can report it, and
`telemetryNameSchema` — the client wire contract — already accepted
`sync.outbox.depth`. Renaming the client's name to make room for the server's
would have moved the wrong one.

The vocabulary now carries four names across `METRIC_NAMES` (`packages/core`)
and `telemetryNameSchema` (`packages/api`), which a test in each package asserts
are identical. Two of the four — the `sync.outbox.*` pair — have **no emitter**,
and that is stated in `METRIC_NAMES` beside them rather than left to be
discovered: a name in the vocabulary with nothing emitting it reads as zero
rather than as broken, which is the exact failure that equality test exists to
prevent.

### Why the capture outbox has no server-side signal, and what one would cost

Nothing on the server can observe the capture outbox, and no fake signal has
been invented for it. Two options were priced:

**The client reports its own depth on the existing beacon.** `/api/telemetry`
already accepts `sync.outbox.depth` from `telemetryNameSchema`, and
`lib/telemetry/client.ts` already batches and flushes to it — so this is one
`record()` call in the drain loop. It was rejected as *not* the signal §5.16
asks for. A backed-up capture outbox means a device with no network; a device
with no network cannot beacon, and telemetry deliberately does not queue (see
the header of `app/api/telemetry/route.ts` — "it does not go through the
outbox"). The reading would therefore arrive only *after* the drain succeeded,
which makes it an after-the-fact depth measurement rather than an alert: silent
for the entire duration of the condition it exists to detect. It would also land
under the same `app_event.name` as the media gauges with nothing but `route` to
separate them, so it would corrupt the reading it was added beside.

**A drain heartbeat the server can miss.** This is the shape that works, because
§5.16 alerts on *absence* — the same mechanism that makes `job_run` trustworthy.
`sync_state` already has the columns (`device_id`, `watermark`, `last_synced_at`)
and `lib/offline/device.ts` already holds a stable device id; a successful drain
would stamp `last_synced_at`, and a nightly step would flag any device whose
stamp is older than 24 hours. Not built: it needs a write path for `sync_state`
(which nothing writes today), a repository, a device-registration story, and an
answer to the case it cannot distinguish — a phone that is stuck looks exactly
like a phone that is switched off, and at n=1 with a tablet in a drawer that is
the common case, not the edge one. That is a milestone with a design question in
it, not a patch.

Until one of those lands, the honest position is the one
`docs/runbooks/incident.md` already takes: the SQL query is the alert.

### Metrics can be lost, and that is the trade

Every metric write is non-blocking and swallows its failure into
`onWriteFailure`. Telemetry is operational exhaust; a full `app_event` table must
not turn a logged workout into a 500. **Audit is different** — it awaits and lets
a failure propagate, because an audit row is part of the record and §9.4 keeps it
forever.

§9.4 draws that line explicitly: "The audit log is not the application log. Audit
is domain data, lives in Postgres, and is retained forever. Application logs are
operational exhaust and expire." Conflating them puts a permanent record on a
30-day retention.

### Not OpenTelemetry

OTel is a dependency with network egress and a collector to operate, and C3 says
every piece of infrastructure "is a liability that must justify itself". §5.13
asks for `traceId` and `spanId` on every log entry — that is a trace tree, and a
trace tree assembled from structured log lines answers "what did this request do"
without a second system.

`currentSpan()` returns `null`. Tracking an ambient span needs
`AsyncLocalStorage`, which is a Node API, and `core` declares the port — so the
honest implementation says we do not track one and has callers pass the parent
explicitly.

---

## 9. Running it

```
POST /api/jobs/nightly            # everything
POST /api/jobs/nightly
{ "only": ["refresh-rollups"] }   # one step, for a maintainer at 11pm
GET  /api/jobs/nightly            # last run + healthy flag
```

### The cron cannot actually reach this route (found 8 September 2026)

This section used to read:

> Cron authenticates through the same session path as a human. **There is no
> bypass token** — a second way in is a second thing to secure (§5.4).

The second sentence is a sound decision. The first describes something a cron
invocation cannot do, because **it carries no cookies**. There is no session for
it to authenticate through, so the stated mechanism has never been capable of
working. Four independent refusals, any one sufficient, all verified:

1. **Vercel cron issues `GET`; the scheduled entry point is `POST`.** A
   GET-triggered cron would report last-run status nightly and derive nothing —
   while looking configured, which is the worst of the four.
2. **`proxy.ts` refuses it before the handler is entered.**
   `/api/jobs/nightly` appears in none of `UNGUARDED_PREFIXES`,
   `PUBLIC_PREFIXES` or `PUBLIC_API_PREFIXES`, and `lib/auth/routes.ts` is
   default-deny. No session cookie → 401 `unauthenticated_no_session`.
3. **`csrfGuard` would refuse it next** — no `Origin` gives
   `origin_missing`, and no `naitikos-csrf` cookie gives `token_missing`.
4. **`requireServerPermission('settings:write')` would refuse it last.**

`x-vercel-cron` is read in exactly one place — `isManual: ... === null` — and
grants nothing, exactly as the old text said. Nothing anywhere reads a
`CRON_SECRET`.

**The consequence is that §5.16's only automated derivation signal is dead in
production**: `healthy` stays permanently `false` because no completion record
is ever written by a schedule. Nothing derives, no rollups refresh, no
detectors run. Everything on this page works when a human triggers it and
nothing runs on its own.

`docs/runbooks/deployment.md` §9.3 tables the three ways out — an external
scheduler that signs in with credentials, a route change adding a
bearer-token path (which needs an ADR, because it is precisely the "second way
in" the decision above refused), or accepting no schedule and triggering
manually. That is a decision, not a defect to patch, and it is unresolved.

The POST returns **200 even for a failed run**. The request succeeded — it ran the
job and produced a report. A 500 would make cron retry a run that already wrote
its completion record, which is a second run, not a retry.

---

## 10. Gotchas

- **`only` names are filtered against `JOB_STEPS`.** An unknown name is dropped
  rather than erroring, so a typo runs nothing rather than everything.
- **The stale threshold is six hours**, well beyond the fifteen-minute budget, so
  recovery never steals a task from a genuinely running invocation.
- **A stranded `job_run` row is judged at thirty minutes, not six hours**, and
  the asymmetry is not an oversight. Recovering a *task* releases a claim
  another invocation may still hold, so acting too early puts two workers on one
  subject — a correctness failure, priced with a six-hour margin. A `job_run`
  row is written and owned by exactly one invocation and read by nobody else, so
  acting too early mislabels a row instead. Twice the budget is enough, and
  keeping it in minutes is what makes last night's corpse visible over breakfast
  rather than the following evening.
- **`backoffSeconds` takes the attempt count *before* the increment.** Off by one
  here means the first retry waits a day.
- **A step's `note` is surfaced in `/settings/developer`.** Counts and codes only
  — never user content (§5.11). It reaches the page through
  `JobRunSummary['steps']` and the `steps` jsonb, and for a milestone it did
  *not*: every step returned one, this line promised it was shown, and
  `runNightly` built each entry from name, status, duration, `rowsAffected` and
  error code — dropping the note two packages below the page making the promise.
  It is carried now. No migration was involved: `steps` is `jsonb` and the note
  is one more key in an object it already stored.
- **A note is clamped to 200 characters** (`JOB_STEP_NOTE_MAX_CHARS`) and an
  empty one is stored as absent. `job_run` is never pruned, so a step that
  interpolated something unbounded into its note would keep it for ever in a
  record that holds names and numbers. Clipping is marked with an ellipsis
  rather than silent, and a long note is clipped rather than dropped — the step
  still speaks.
- **A failed step has no note.** An `Err` carries a code, not an outcome, so
  `note` is null for a failure, for a step that had nothing to say, and for a
  row written before notes were stored. The page shows counts alone rather than
  inventing a distinction between the three.
- **`assert-data-integrity` reports a violation as a *success*.** Not an
  oversight and not leniency: the line above is the reason. A failed step's note
  is dropped, so returning `Err` on a violation would discard the list of
  offending assertions and leave `job_run` holding a bare error code. The step
  reports `Err` only when a query would not run — the case where it learned
  nothing. See §6a.
- **`assert-data-integrity` never writes.** There is no repair path and there
  must not be one. §9.1's log is append-only, and a nightly job that corrected
  the record unattended at 03:00 would destroy the evidence of what it changed.
  Its repository is a reader; the module has no INSERT, UPDATE or DELETE.
