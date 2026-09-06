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
| 9 | `verify-media-integrity` | **yes** | §9.8 + outbox health |
| 10 | `assert-data-integrity` | no | §5.16's assertions |
| 11 | `schedule-notifications` | no | §5.9. No separate scheduler |
| 12 | `rebuild-timeline` | no | When a projector change makes entries stale |
| 13 | `maintain-partitions` | **yes** | §9.7. **Before** the collapse; see below |
| 14 | `downsample-samples` | **yes** | §9.7, past 90 days |
| 15 | `prune-idempotency` | **yes** | §5.7's seven-day TTL. Registered 7 September 2026; see below |
| 16 | `prune-telemetry` | **yes** | §5.11's ninety-day retention |
| 17 | `drain-task-queue` | **yes** | **Last**, so work enqueued earlier tonight runs tonight |

Nine are registered. The eight that are not do **domain** work and arrive with
their domains — a rollup step is meaningless before there is anything to roll
up.

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
more.

A halted run marks the remaining steps `skipped` and **records them**. §5.16
alerts on absence, and a skipped step that produced no row is indistinguishable
from one that was never registered.

A step that *throws* rather than returning `Err` is a bug (§5.12), and it is
captured as `step_threw` rather than being allowed to lose the completion record
for the eleven steps that worked.

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

Cron authenticates through the same session path as a human. **There is no bypass
token** — a second way in is a second thing to secure (§5.4). The `x-vercel-cron`
header distinguishes the two for the `isManual` flag only; it is not a
credential and grants nothing.

The POST returns **200 even for a failed run**. The request succeeded — it ran the
job and produced a report. A 500 would make cron retry a run that already wrote
its completion record, which is a second run, not a retry.

---

## 10. Gotchas

- **`only` names are filtered against `JOB_STEPS`.** An unknown name is dropped
  rather than erroring, so a typo runs nothing rather than everything.
- **The stale threshold is six hours**, well beyond the fifteen-minute budget, so
  recovery never steals a task from a genuinely running invocation.
- **`backoffSeconds` takes the attempt count *before* the increment.** Off by one
  here means the first retry waits a day.
- **A step's `note` is surfaced in `/settings/developer`.** Counts and codes only
  — never user content (§5.11).
