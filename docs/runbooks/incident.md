# Runbook — Incidents

**Status:** written 7 September 2026, before any incident in it has occurred · **Blueprint sections:** §2 (C3), §5.7, §5.12, §5.13, §5.15, §5.16, §9.1, §9.4, §13.2
**Related:** [restore-drill.md](restore-drill.md) · [migration.md](migration.md) · [key-rotation.md](key-rotation.md) · [background-jobs.md](../background-jobs.md) · [offline.md](../offline.md) · [storage.md](../storage.md) · [auth.md](../auth.md) · [observations.md](../observations.md)

---

This is written for the person described in §6.2 — the operator "executing a
database restore having not thought about the system for two months" — and
specifically for the version of that person who is looking at something visibly
broken at 11pm and is the only one who can fix it.

There is no pager here, no severity ladder, no incident commander, and no second
engineer to escalate to. C3 is the governing constraint:

> "One maintainer with a demanding day job. The system must survive three-week
> gaps in attention. It must not require operational babysitting."

So this document is organised by **symptom**, because a symptom is all you have
at the start. Each section gives what it looks like, the causes that are
actually possible in this codebase, the exact query or place to look that
confirms which one it is, the fix, and how to know the fix worked.

---

## 1. The first five minutes

### 1.1 Establish scope before touching anything

Three questions, in this order. They take about ninety seconds and they change
what you do next.

1. **Is anything actually lost?** Almost certainly not. The three durability
   mechanisms are independent and all of them fail *towards* keeping data: the
   IndexedDB outbox deletes an entry only on a 2xx (`acknowledge` in
   `apps/web/lib/offline/outbox.ts` is the only function that removes one);
   `observation` carries a `BEFORE UPDATE OR DELETE` trigger that refuses
   deletion outright (migration `0001_observation_immutable.sql`); and
   `audit_log` is append-only and never pruned (§9.4). If the symptom is "my
   data is gone", the prior should be that it is not gone, it is not being
   *read*.
2. **Is it one surface or the whole application?** There is exactly one error
   boundary in the app tree — `apps/web/app/error.tsx`. §5.12 asks for
   per-pillar boundaries and they have not been built, so a thrown render error
   blanks the content region for the whole application, not only the pillar
   that threw. "Everything is broken" and "one page is broken" therefore look
   identical from the outside, which makes question 3 the one that separates
   them.
3. **Does the sign-in page load?** `/auth/sign-in` and `GET /api/auth/session`
   are the only unauthenticated 200s in the application. If `GET
   /api/auth/session` returns `{"status":"anonymous"}`, the deployment is up and
   Postgres is not necessarily in the path yet. If it hangs or 500s, go to §9.

Then use this table.

| What you are looking at | Section |
| --- | --- |
| The sync banner says entries are waiting or "Not synced" | §4 |
| Something that should have happened overnight did not | §5 |
| A number, chart or timeline entry is wrong | §6 |
| A photo will not finish uploading | §7 |
| You cannot sign in | §8 |
| Pages 500, or `pnpm dev` cannot connect | §9 |
| It worked before the last deploy | §10 |

### 1.2 The one thing not to do

**Do not run an `UPDATE` or a `DELETE` in psql against domain data.** Not to
"fix a bad row", not to "clear a stuck record", not to unblock yourself at
midnight. It is the single most damaging action available in this system, and it
is damaging in a way that is silent and permanent.

§9.1 states the reason without hedging:

> "Observations are append-only. This is not a stylistic preference; it is what
> makes a twenty-year record trustworthy. If a weight from 2027 can be silently
> edited in 2031, then no number in the system can be relied upon and the entire
> premise fails."

Three things follow, and the third is the dangerous one:

- **`observation` will refuse you.** The trigger installed by
  `0001_observation_immutable.sql` raises `restrict_violation` on any `DELETE`,
  and on any `UPDATE` that touches a column other than `superseded_by_id`,
  `superseded_at`, `supersede_reason`. A re-pointed supersession is refused too
  — the correction chain is write-once. This is the one place the database
  protects you.
- **`domain_event` will also refuse you.** `0006_event_log_immutable.sql` is
  stricter: no updates at all, no deletes at all. A corrected event is a
  compensating event.
- **Nothing else will.** `medication`, `goal`, `skincare_product`, `condition`,
  `journal_entry`, `timeline_entry`, `insight`, `prediction` — every mutable
  entity is protected only by application code and by `audit_log`, and a psql
  session writes neither. An `UPDATE medication SET ...` in psql produces a row
  with a stale `version`, no audit entry, and no `changed_fields`, which means
  §9.4's "recovery mechanism of last resort" now has a gap exactly where you
  were working.

Two related traps worth knowing before you open a connection:

- **RLS will not save you.** Migration `0004_enable_rls.sql` enables `FORCE ROW
  LEVEL SECURITY` on every table with zero policies, which denies everything —
  except to a role with `BYPASSRLS`. Verified today: the local `naitikos` role
  has both `rolsuper = t` and `rolbypassrls = t`. Locally, psql is unrestricted.
- **`pnpm db:reset` destroys the local database.** It is `docker compose down -v
  && docker compose up -d postgres`; the `-v` removes the `naitikos-pgdata`
  volume. `pnpm db:down` (no `-v`) is the safe stop.

What to do instead is in §6.

### 1.3 What is safe to run

Everything in this document that reads is safe. `psql` is not installed on the
host — the local database is reached through the container:

```bash
docker exec -it naitikos-postgres psql -U naitikos -d naitikos
```

Against production, `DATABASE_URL` points at Supabase and the SQL editor in the
Supabase dashboard is the equivalent surface. The queries below are identical in
both.

Non-destructive checks:

```bash
docker ps                 # is the container up and healthy
pnpm db:up                # start it; idempotent, keeps the volume
pnpm verify               # typecheck, lint, test, build — the known-good gate
```

---

## 2. How to read this runbook: verified, derived, unknown

None of the incidents below has happened. Writing them in the confident past
tense of someone who has lived through them would make this document a work of
fiction with a table of contents, and this codebase refuses that elsewhere —
`docs/offline.md` has a section called "What is not built" and `docs/storage.md`
says outright that half the media path does not exist yet.

So the convention, applied per section:

- **Verified** — read in the code or queried against the local database on 7
  September 2026. Every command, path, table, column, enum value, env var and
  route in this document is verified. If it is named here, it exists.
- **Derived** — a causal chain reasoned out from verified code. Plausible,
  untested, and stated as such.
- **Unknown** — stated as unknown, with the query that would answer it, rather
  than papered over with a plausible-sounding alert name.

Each symptom section opens with a line saying which of these it is.

---

## 3. The diagnostics that exist — and the ones that do not

*Verified by enumeration of `apps/web/app/api/**/route.ts` (47 route files) and
every page under `apps/web/app/(protected)/settings/`.*

This section exists because the alternative is discovering the gaps one at a
time while something is broken.

**What exists:**

| Signal | Where | Notes |
| --- | --- | --- |
| Unsynced capture work | `SyncBanner`, on the capture surfaces | Client-side only. Reads IndexedDB, never the server |
| Nightly run history | `job_run` table | SQL only — see below |
| Last run + health flag | `GET /api/jobs/nightly` | Returns `{ last, healthy }`. Requires `settings:read` |
| Telemetry aggregates | `/settings/developer` | `app_event` only: capture latency, time in app, correction rate, close funnel, event counts, one `sync.failed` counter |
| Every mutation ever | `/settings/data/audit`, `audit_log` | Read-only by construction; `createAuditReader` has no write path |
| Media upload queue | `GET /api/media/uploads` | Returns `{ entries, health }` from `upload_outbox` |
| Structured logs | stdout, one JSON object per line | Platform log retention owns them. Nothing is stored in Postgres (§9.4) |

**What does not exist. All of the following were searched for and not found:**

- **No health-check endpoint.** §5.16 asks for "an external HTTP check every
  five minutes against a health endpoint that verifies database connectivity".
  `/api/health` is the *Health domain* — vitals, conditions, appointments — and
  requires `observation:read`. There is no `/api/healthz`, `/api/status`,
  `/api/ready` or `/api/version`. The closest usable external probe is `GET
  /api/auth/session`, which returns 200 `{"status":"anonymous"}` without a
  session; it does touch Supabase Auth but not Postgres, so it cannot detect a
  database outage.
- **No alerting of any kind.** §5.16's "absence of the record by 05:00 raises an
  alert", the 24-hour outbox-age alert and the dead-letter alert are all
  specified in the blueprint and none is implemented. `GET /api/jobs/nightly`
  computes `healthy` but nothing calls it. Nothing sends anything anywhere.
- **No cron configuration in version control.** There is no `vercel.json` at the
  repo root or in `apps/web`, and `.github/workflows/` is empty. Whether the
  nightly job fires at all depends on configuration that is not in this
  repository.
- **No job-run UI and no manual-trigger button.** §5.2 and
  `docs/background-jobs.md` both say the nightly job is "manually triggerable
  from `/settings/developer`".
  `apps/web/app/(protected)/settings/developer/page.tsx` renders
  `loadValidationReport` and nothing else. The settings index describes that
  page as "Feature flags, the nightly run, schema version, diagnostics"; none of
  the first three is on it. Triggering the job means a hand-made `POST
  /api/jobs/nightly` — see "Re-running" in §5.
- **No feature flags in the running application.** The `feature_flag` table
  exists and is seeded with four rows (`ai.enabled`, `ai.journal_access`,
  `insights.enabled`, `sync.outbox`), and nothing in `apps/web` reads it.
  §5.15's "feature flags for anything touching the substrate, so a bad path can
  be disabled without a rollback" is not available to you. Rollback is the only
  lever.
- **No sync diagnostics.** `sync_state` — watermark, `clock_skew_ms`,
  `pending_writes` — is written by nothing and read by nothing. §5.8's
  five-minute clock-skew flag does not exist.
- **No server-side visibility of the capture outbox at all.** This is the
  important one and it is inherent, not an oversight: the capture outbox is
  IndexedDB in one browser profile on one device. No query can see it.
  `docs/storage.md` makes the same point about media: "outbox *depth* is a lower
  bound on unsynced work, never an exact count — a phone that has been in a
  drawer for a week contributes nothing to it."

### 3.1 The queries that replace the missing dashboard

Keep these. They are the diagnostics.

```sql
-- The last ten nightly runs.
SELECT started_at, finished_at, status, is_manual, duration_ms, error_message
  FROM job_run
 WHERE job_name = 'nightly'
 ORDER BY started_at DESC
 LIMIT 10;

-- §5.16's actual check, run by hand: has a non-manual success landed in 24h?
SELECT count(*) FROM job_run
 WHERE job_name = 'nightly' AND status = 'succeeded'
   AND is_manual = false AND started_at >= now() - interval '24 hours';

-- Runs killed mid-step, which leave `running` forever.
SELECT id, job_name, started_at FROM job_run
 WHERE status = 'running' AND started_at < now() - interval '6 hours'
 ORDER BY started_at DESC;

-- Deferred work, by kind and state.
SELECT kind, status, count(*) FROM deferred_task GROUP BY 1, 2 ORDER BY 1, 2;

-- Events that exhausted their handler retries.
SELECT failed_at, event_type, handler_name, attempts, error_code
  FROM event_dead_letter WHERE resolved_at IS NULL ORDER BY failed_at DESC;

-- Media uploads that have not finished.
SELECT status, count(*), min(created_at) AS oldest
  FROM upload_outbox WHERE abandoned_reason IS NULL GROUP BY status;

-- What the application has been emitting.
SELECT name, count(*), max(occurred_at)
  FROM app_event WHERE occurred_at >= now() - interval '24 hours'
 GROUP BY name ORDER BY 2 DESC;

-- Which migrations are applied.
SELECT id, applied_at, is_data_migration FROM schema_migration ORDER BY applied_at DESC LIMIT 10;
```

---

## 4. Captures are not syncing

*The mechanism is verified. The failure is derived — no capture has been
observed stuck.*

### What it looks like

`SyncBanner` (`apps/web/features/capture/components/SyncBanner.tsx`) has exactly
three states, and the difference between the second and the third is the whole
diagnosis:

- **Nothing rendered.** The outbox is empty. Deliberate: a permanent "all
  synced" chip is one the operator learns not to read.
- **A neutral badge, "Syncing" or "Offline", with a count and an age.**
  Expected. This is a gym basement. Nothing needs doing.
- **A critical badge, "Not synced", with "N entries have failed repeatedly" and
  a "Try again" button.** One or more entries reached `blocked`. This is the
  only state that needs a person.

The banner also says "Nothing has been lost — the entries are stored on this
device until they send." That sentence is true, and it is the first thing to
re-read before doing anything drastic.

### The causes that are actually possible

`recordFailure` walks an entry to `blocked` after `MAX_ATTEMPTS = 6`, with
backoff of 2, 4, 8, 16, 32, 60 seconds — a little over an hour of trying.
`blockEntry` puts one there immediately. The `lastError` field on the entry is a
category, never a response body, and it tells you which of these you have:

| `lastError` | Cause | Will a retry help? |
| --- | --- | --- |
| `network` | `fetch` threw. Offline, captive portal, DNS, or the deployment is down | Yes, once connectivity is real |
| `server_500` and similar | The route threw. See §9 and §10 | Only after the server is fixed |
| `rate_limited` | HTTP 429. The `session` rule is 120 requests per 60 seconds | Yes, after the window |
| `conflict` | HTTP 409 from `withIdempotency` — `request_in_flight`. **see "The 409 trap" below** | Usually not. This is the trap |
| `rejected_400`, `rejected_422` | Zod refused the body, or the domain did | No — a retry sends the same payload |
| `dependency_blocked` | Set by `drainOutbox` on an entry whose `dependsOn` target gave up | Fix the dependency first |

The `dependsOn` chain exists because a `workout_set` references its session by
foreign key. A blocked session start takes every set behind it to `blocked` as
well, visibly — `orphanedEntries` finds them and the drain blocks them
explicitly, because leaving them pending forever would be §5.7's silent discard
arriving slowly.

### How to confirm

There is no server query for this. Open DevTools on the affected device →
Application → IndexedDB → `naitikos-outbox` → `entries`. Each record carries
`status`, `attempts`, `lastError`, `endpoint`, `method`, `label`, `dependsOn`,
`nextAttemptAt`.

If the device is a phone you cannot inspect, the banner's counts are all you
have; `useOutbox()` exposes the same `{ pending, sending, blocked,
oldestPendingAgeMs }` shape the banner renders.

### Fixing it, and why retrying is safe

**Press "Try again".** That calls `retryBlocked()` → `drainOutbox()`, which
resets `attempts` to 0 and `nextAttemptAt` to now for every blocked entry.

Retrying is safe by construction, and it is worth knowing exactly why, because
the confidence is the point:

- **The idempotency key is the entry id.** `enqueue` sets `body: {
  ...input.body, idempotencyKey: id }` where `id` is the entry's own UUIDv7
  primary key. One identifier, not two, so a replay is provably the same
  request.
- **The server stores the response, not merely a rejection.** `withIdempotency`
  returns the original body verbatim with `X-Idempotent-Replay: true`. A dedupe
  that merely answered "409, already done" would leave the entry queued forever.
- **The request is fingerprinted.** `fingerprintRequest(endpoint, body)` means a
  reused key carrying different content is refused with `idempotency_key_reused`
  rather than silently returning the first submission's answer for the second.
- **The write path is independently idempotent** — client-generated UUIDv7
  primary keys plus `ON CONFLICT DO NOTHING`. Two mechanisms; the second is the
  load-bearing one.

**What would duplicate.** Only one thing: re-entering the data by hand while the
original entry is still queued. That produces a second entry with a different
id, therefore a different idempotency key, therefore a genuinely different
request. If you have already re-entered something, do not clear the outbox to
"avoid the duplicate" — let both land and correct one by supersession (§6).

**The one destructive client action** is `clearOutbox()`, wired to "clear local
data" in settings. It empties the store, and unsent entries are gone with no
server-side trace. It is the only way to lose a capture in this system.

### The 409 trap — a verified defect

*Verified: read in `packages/db/src/repositories/idempotency.repository.ts` and
`packages/core/src/jobs/registry.ts`. The consequence is derived.*

`claim()` never checks `expires_at`. Expiry is honoured only by `prune()`, and
`prune-idempotency` — although it is in `JOB_STEPS` — is **not** one of the
eight steps registered in `apps/web/app/api/jobs/nightly/route.ts`. So nothing
prunes `idempotency_record`, ever.

`withIdempotency` releases the key on both the error path and the `catch`, so an
ordinary failure is fine. But if the process dies between `claim()` and either —
a serverless timeout, a container kill, a lost database connection during
`release` — the row is left with `is_complete = false` and stays that way
permanently. Every retry of that outbox entry is answered `409
request_in_flight`, categorised as `conflict`, and after six attempts the entry
sits in `blocked`. Pressing "Try again" resets the counter and burns six more.
The code comment anticipates "a self-inflicted outage with a seven-day
recovery"; because `claim` ignores expiry and nothing prunes, there is no
recovery at all.

Confirm it:

```sql
SELECT key, endpoint, created_at, expires_at
  FROM idempotency_record
 WHERE is_complete = false AND created_at < now() - interval '1 hour'
 ORDER BY created_at;
```

The `key` matches the outbox entry's `id` exactly, so you can tie the row to the
entry in DevTools.

Fix it by deleting the stranded claim:

```sql
DELETE FROM idempotency_record
 WHERE key = '<the outbox entry id>' AND is_complete = false;
```

**This is the one deletion this runbook sanctions, and the reason is that
`idempotency_record` is not domain data.** It is transport bookkeeping with a
declared TTL, it is not in the export, it has no audit obligation, and §1.2's
rule is about the record — observations, entities, events, audit. Keep the
`is_complete = false` predicate in the statement: deleting a *completed* record
throws away a stored response the client may still need to reconcile against.

Then press "Try again" on the device.

### How to tell it is fixed

The banner disappears — which means `acknowledge` ran, which means the server
returned 2xx. Then confirm the write actually landed rather than trusting the
client:

```sql
SELECT id, metric_key, value, unit, observed_at, recorded_at
  FROM observation
 WHERE recorded_at >= now() - interval '15 minutes'
 ORDER BY recorded_at DESC;
```

---

## 5. A nightly job failed, or did not run

*The mechanism, the step list, and the re-run safety of every registered step
are verified. The failure is derived.*

### What it looks like

Nothing. That is the difficulty. There is no alert (§3), no UI, and no
notification. The symptom you actually notice is downstream and days late:
predictions stop appearing, insights stop being confirmed, the `sample` table
stops shrinking, `app_event` stops being pruned, or an import at midnight on the
first of a month fails on a missing partition.

### How to confirm

Run the first three queries in §3.1. Interpret them like this:

- **No row at all for the last 24 hours** — the cron did not fire. There is no
  cron configuration in this repository (no `vercel.json`), so check the
  platform's own scheduler settings. `job_run` is written on *every* exit path,
  including failure, so an absent row means the invocation never started.
- **`status = 'failed'`** — at least one step returned `Err`. `error_message`
  holds `stepname:errorcode` pairs and nothing else, by design: §5.11's "no
  payloads, ever" applies to a job's account of itself, so a constraint
  violation will not tell you which row violated it.
- **`status = 'running'` and hours old** — the invocation was killed before
  `finish()` could write. `abandonedJobRuns` exists in the repository for
  exactly this and has no caller, so the query in §3.1 is how you find them.
  These are *not* failures. The work may well have completed. Conflating them
  makes the failure count meaningless.

For per-step detail:

```sql
SELECT jsonb_pretty(steps) FROM job_run WHERE id = '<run id>';
```

Each element is `{ name, status, durationMs, rowsAffected?, errorCode? }`, where
`status` is `succeeded`, `failed` or `skipped`.

Two mappings will otherwise confuse you. `JobRunSummary.status` has three values
— `succeeded`, `failed`, `halted` — and `createJobRunRecorder` writes only
`succeeded` or `failed`; a halted run is stored as `failed`. To tell them apart,
read `steps`: a halted run has `skipped` entries. And a step that threw rather
than returning `Err` appears with `errorCode: 'step_threw'`.

### The ordering, and what a halt would cost

`runNightly` walks `JOB_STEPS` order, not registration order. Eight of the
seventeen names are registered today; the rest arrive with their domains. Two
orderings in the list are load-bearing:

- **`resolve-predictions` before `make-predictions`.** Yesterday's prediction
  about today must be scored against today's reading before tonight's prediction
  is fitted over a window that includes it. Reversed, a prediction is graded
  against a series its own successor was fitted on.
- **`maintain-partitions` before `downsample-samples`.** Both touch `sample`,
  and creating a partition takes a brief `ACCESS EXCLUSIVE` lock on the parent.
  Taking it first means the lock lands on a quiet table rather than queueing
  behind a collapse that is deleting a month of rows.

**Verified: all eight registered steps set `haltOnFailure: false`.** Nothing
currently halts a run, so `skipped` entries can only come from the
fifteen-minute wall-clock budget (`DEFAULT_RUN_BUDGET_MS`) being exhausted
between steps. Which also means the ordering above degrades rather than breaks:
a failed `resolve-predictions` does not stop `make-predictions` from running
tonight. The affected prediction stays pending and is picked up tomorrow,
because `pending` is a day-key comparison rather than a one-shot queue.

### Which steps are safe to re-run

**All eight. Verified individually — this is not an assumption from the
"idempotent, safe to re-run" comment.**

| Step | What makes a second run safe |
| --- | --- |
| `drain-task-queue` | `recoverStale` only touches claims older than six hours; `pendingCount` reads |
| `verify-media-integrity` | Reads `upload_outbox.health`, plus a `recoverStale` bounded the same way |
| `prune-telemetry` | Deletes `app_event` past a computed cutoff. A second run finds nothing left |
| `resolve-predictions` | `resolve()` updates only where `resolved_at IS NULL`, so a scored prediction cannot be re-scored |
| `make-predictions` | `predictionId(dayKey, kind, metricKey)` is a pure function of its inputs; `record()` uses `onConflictDoNothing` and returns the existing row |
| `maintain-partitions` | `ensure_sample_partition(date)`, a database function that creates only what is absent |
| `downsample-samples` | See the caveat below |
| `run-detectors` | `recordNight` refuses a signature that already has an open row — both for the surfaced half and the held one |

**`downsample-samples` is the interesting case and deserves its own paragraph,
because it is the only registered step that deletes anything from the record.**
It aggregates, deletes the raw rows, then inserts the hourly means — three
ordered statements in one transaction, deliberately not a single data-modifying
CTE, because every statement in a `WITH` sees the same snapshot and an aggregate
landing exactly on an hour that already had a reading at `HH:00:00` would
conflict with the row being deleted beside it and leave the hour with neither. A
crash rolls back to full resolution, which is the correct direction: re-running
from raw rows is free, re-deriving from deleted ones is impossible.

It is safe to re-run. The caveat is that a re-run is not a *replay*. The cutoff
is `now()` minus the retention window, truncated to the hour, so re-running at
03:47 collapses the same set as the 03:00 run that failed — but re-running three
days later collapses three more days as well. That is correct behaviour and not
a problem; it is only worth knowing before you re-run a step from a week ago and
it reports more rows than the run that failed.

The step whose failure matters least on any given night is this one: the raw
rows stay where they are and tomorrow collapses them. The step whose failure
matters most is `maintain-partitions` — and even there the cost is bounded,
because a missing partition sends the next import to `sample_default`, where it
is stored and findable rather than lost. The step reports that count in its note.

### Re-running

There is no button. The only way in is an authenticated request, and there is
deliberately no bypass token — "a second way in is a second thing to secure"
(§5.4).

```
POST /api/jobs/nightly              # everything
POST /api/jobs/nightly
{ "only": ["refresh-rollups"] }     # one step
GET  /api/jobs/nightly              # { last, healthy }
```

`POST` requires `settings:write`, `GET` requires `settings:read`, and both go
through the CSRF guard — so a state-changing request needs the `naitikos-csrf`
cookie value echoed in the `x-naitikos-csrf` header, and an `Origin` matching
`NEXT_PUBLIC_SITE_URL`. The most reliable way to issue it is DevTools' console
on an authenticated tab, where the cookie is already present.

Three behaviours to expect:

- **The POST returns 200 even for a failed run.** The request succeeded; it ran
  the job and produced a report. A 500 would make cron retry a run that already
  wrote its completion record, which is a second run rather than a retry.
- **Unknown names in `only` are dropped, not rejected.** A typo runs nothing
  rather than everything. If a targeted re-run reports zero steps, check the
  spelling against `JOB_STEPS`.
- **Your manual run will not satisfy the health flag.** `hasCompletedRunSince`
  requires `is_manual = false`, and `isManual` is set from the absence of the
  `x-vercel-cron` header. This is intentional — otherwise debugging the problem
  is what makes the symptom disappear — but it means `GET /api/jobs/nightly`
  will keep saying `healthy: false` until the real cron fires.

### How to tell it is fixed

A new `job_run` row with `status = 'succeeded'` and no `error_message`, and
`steps` showing eight `succeeded` entries. Then, tomorrow morning, the same row
again with `is_manual = false` — which is the only thing that proves the
*schedule* is working rather than your hands.

---

## 6. Data looks wrong on a surface

*The immutability rule and the correction path are verified. The scenario is
derived.*

### The rule, before the diagnosis

**The fix is never an `UPDATE`.** Corrections in this system are supersessions:
a new observation is written, the old row's `superseded_by_id` points at it,
`superseded_at` records when, `supersede_reason` records why, and both rows
survive forever so the timeline can be replayed as it was known at any past
moment.

Reaching for psql here is the one action that destroys the integrity of the
record, and it does so in a way nothing will report. The database refuses the
crude version — the trigger raises `restrict_violation` on a `DELETE` or on an
`UPDATE` touching any column but the three supersession fields — so what you
actually get if you try is an error, which is the good outcome. The bad outcome
is the version that succeeds: an `UPDATE medication`, `UPDATE goal` or `UPDATE
journal_entry`, none of which is trigger-protected, which leaves a stale
`version`, no `audit_log` row, and a record that now disagrees with its own
history.

The reason is not procedural fastidiousness. §9.4 calls `audit_log` "the
recovery mechanism of last resort", and a psql write is precisely the write it
cannot see.

### Work out which kind of wrong it is

| Looks like | Probably | Confirm with |
| --- | --- | --- |
| A single value is wrong | A mis-tap at capture | Query `observation` for the metric and day |
| A value is right in one place, wrong in another | A stale derived row or projection | Compare `observation` against `metric_rollup` / `timeline_entry` |
| A whole day is missing | The capture never landed | §4, then the query below |
| Everything after a date is wrong | The nightly run stopped | §5 |
| A categorical shows no label | `decodeValue` returned `null` — the ordinal is past the end of `allowed_values` | Compare `observation.value` against the metric's `allowed_values` |

The primary query:

```sql
SELECT id, metric_key, value, value_text, unit, observed_at, observed_zone,
       recorded_at, superseded_by_id, superseded_at, supersede_reason
  FROM observation
 WHERE metric_key = '<metric>'
   AND observed_at >= now() - interval '7 days'
 ORDER BY observed_at DESC;
```

Read `unit` from the row, never from the metric registry. It is denormalised
deliberately: if the registry's canonical unit is ever changed, the row must
still say what it meant when it was recorded, and without that column a unit
change silently reinterprets twenty years of data.

A row with a non-null `superseded_by_id` is *already corrected* and is being
shown to you because the surface asked for the full chain (`?currentOnly=false`)
rather than because anything is broken.

### The correct fix

**Re-enter the value through the surface that owns it.** The correction path is
in the application, not in SQL:

- A day-level surface that upserts — Skin is the shipped example — reads the day
  first and supersedes the observations already there rather than adding a
  contradictory second reading. Re-logging the day is the correction.
- `POST /api/observations` accepts a `supersedes: { id, reason }` block on any
  observation. `reason` is `min(1)` in the schema and the domain rejects an
  empty one: "a supersession with no reason is a silent edit wearing a paper
  trail."

Two properties protect you while you do this. A row can be superseded exactly
once — the write is guarded on `superseded_by_id IS NULL`, and the trigger
refuses a re-pointed chain — so two devices correcting the same observation
offline cannot both win and lose a link. And a re-submitted identical answer
does not write a pointless correction, because boolean and categorical values go
through the same `toQuantityString` as a measured number and therefore compare
equal to what is stored.

**If there is no surface for the correction**, the honest answer is that you
cannot fix it correctly tonight, and the right move is to leave the record alone
and add the surface. A wrong number that is visibly wrong is recoverable; a
wrong number that was silently overwritten is not.

### Derived rows are different, and safe to rebuild

The asymmetry is deliberate and `0006_event_log_immutable.sql` states it:

```sql
COMMENT ON TABLE timeline_entry IS
  'Projection over domain_event. Safe to TRUNCATE and rebuild via replay (ADR 0005 rule 3).';
```

The log is permanent; the projection is derived. `metric_rollup`,
`goal_progress_snapshot` and `timeline_entry` are rebuildable from their
sources. Rebuilding is the nightly job's business (`rebuild-timeline`,
`refresh-rollups`), and neither of those steps is registered yet — so today, a
bad projection is a bug to fix in the projector rather than a row to patch.

### How to tell it is fixed

The surface shows the new value, and the chain is intact:

```sql
SELECT id, value, unit, observed_at, superseded_by_id, supersede_reason
  FROM observation
 WHERE id IN ('<old id>', '<new id>');
```

The old row has `superseded_by_id` set to the new id, a `superseded_at`, and a
reason. The new row's `superseded_by_id` is null — a new row is never born
superseded; the correction points backwards.

---

## 7. A photo or upload is stuck

*Mostly **verified**, and the verified finding is that this incident cannot
currently occur through any in-repository path.*

### The lifecycle, as designed

`upload_outbox.status` is the enum `outbox_status` with exactly five values:
`pending`, `uploading`, `uploaded`, `failed`, `abandoned`. `docs/storage.md`
draws the intended machine — `pending` → claimed → `uploading` → `uploaded`,
with `failed` looping back and `recoverStale` returning stuck `uploading` rows
to `pending`, and `abandoned` as the "the operator gave up" terminal that keeps
the record without keeping the alert.

The row is created *before* the bytes move, which is the property that matters:
a `POST /api/media/uploads` reserves the outbox row and returns a signed URL,
the client `PUT`s to Supabase Storage directly, then `PATCH`es back with either
a `mediaObjectId` or an `errorCode`. There is deliberately no branch that
deletes the row.

### What is actually reachable today

This is where the design and the shipped code diverge, and the runbook is more
useful for saying so than for narrating a failure that cannot happen.

- **Nothing in this repository calls `/api/media/uploads`.** No fetch in
  `features/`, `lib/`, `components/` or `app/`; no test; no e2e spec.
  `runPipeline` likewise has no production caller.
- **`claimPending` — the only writer of `uploading` — has no production
  caller.** Its only references are in `event-store.repository.test.ts`. The
  state is therefore never written, which in turn means `recoverStale` (whose
  predicate is `status = 'uploading'`) can never match a real row. The nightly
  `verify-media-integrity` step calls it every night and it is a no-op.
- **`abandon` — the only writer of `abandoned` — has no caller anywhere outside
  tests.** The terminal state is defined and unreachable.
- **`recordProgress` has no caller.** The `progress` column is never written.
- **`markUploaded` would fail a foreign key even if reached.**
  `completeUploadSchema` requires a `mediaObjectId`, and
  `upload_outbox.media_object_id` references `media_object(id)`. Nothing in
  shipped code inserts into `media_object` — the repository file says so in its
  own header — so a `PATCH` carrying any UUID would violate
  `upload_outbox_media_object_id_media_object_id_fk`.

`docs/storage.md` corroborates the state honestly: "The server half — the table,
the repository, the endpoints, the health reading — is complete and tested. The
IndexedDB half belongs to the PWA/offline milestone."

**So the practical position on 7 September 2026: the only rows that can exist in
`upload_outbox` are ones an external HTTP call created, and they will sit in
`pending` indefinitely and show up in `health().pending` and in the
`sync.outbox.depth` gauge.** If you are looking at a stuck upload, the first
hypothesis is not a bug in the retry logic — it is that the upload path is not
wired yet.

### How to confirm

```sql
SELECT id, status, tier, content_type, attempts, last_error_code,
       last_attempt_at, abandoned_reason, created_at
  FROM upload_outbox
 WHERE status <> 'uploaded' AND abandoned_reason IS NULL
 ORDER BY created_at;
```

`GET /api/media/uploads` returns the same thing as `{ entries, health }`, where
`health` is `{ pending, failed, oldestAgeSeconds }`.

### Two things to know before you conclude the photo is lost

- **There is no attempt cap on the server outbox, deliberately.** `attempts`
  increments in `markFailed` and nothing ever gives up. There is also no backoff
  column and no `next_attempt_at`. A row with a high `attempts` count is not a
  dead row.
- **A photo taken fully offline has no row here at all.** The bytes live in the
  device's IndexedDB until it reaches the network; a 12 MB write over a
  connection that is unreliable by definition is not something the design
  attempts. Outbox depth is a lower bound on unsynced work and never a count.

### The alert that does not exist

§5.16 says "an outbox entry older than 24 hours is an alert, because it means
data the user believes is saved is not". There is no 24-hour constant anywhere
in the code. The gauges `sync.outbox.depth` and `sync.outbox.oldest_age_seconds`
are emitted to `app_event` by the nightly job and by `GET /api/media/uploads`,
and nothing reads them back against a threshold. The query above is the alert.

Note also that both gauges measure the *media* outbox despite their names. The
capture outbox contributes nothing to them.

---

## 8. Locked out, or cannot sign in

*Verified. Note that the shipped mechanism is not the one the blueprint
specifies.*

### Correcting a likely assumption first

§5.4 specifies "email magic link plus passkey (WebAuthn) as the preferred
factor". **Neither is what runs.** `STRATEGY_REGISTRY` in
`packages/core/src/auth/strategies.ts` has `password.enabled = true` and
`magic_link`, `passkey` and `oauth_google` all `false`. `docs/auth.md` §7 states
the divergence plainly: this milestone shipped email and password by product
decision.

Concretely:

- **Passkey is not implemented at all.** No WebAuthn ceremony, no credential
  storage, no table, no column. The only trace is the value `'passkey'` in the
  `auth_strategy` enum. `packages/db/src/schema/identity.ts` says of
  `auth_identity`: "No credentials. No password hashes, no tokens, no recovery
  codes."
- **Magic link is wired and disabled.** `sendMagicLink` exists in the Supabase
  adapter with `shouldCreateUser: false` and has no caller. Enabling it requires
  SMTP configuration on the Supabase project, which is not in this repository.
  The return path — `GET /auth/callback` — is live and does run the allowlist
  check.

So the sign-in flow is: `POST /api/auth/sign-in` with `{ email, password }` →
CSRF → the `signIn` rate limit → `signInWithPassword` against Supabase →
`resolveActor`, which checks email verification and then the allowlist.

### Reading the response you got

| What you see | Cause |
| --- | --- |
| **401** | Wrong password, or unknown account. Deliberately identical — no enumeration |
| **403**, "This account is not permitted" | Not on the allowlist, **or** the email is unverified. Also deliberately identical |
| **403**, "Too many attempts. Try again shortly." | Supabase's own throttling, passed through as `insufficient_permission`. Note it arrives as 403, not 429 |
| **429** with `Retry-After` | This application's limiter: `signIn` is 5 per 15 minutes, `stepUp` is 3 per 15 minutes |
| **403** on a CSRF check | Origin mismatch or a missing `x-naitikos-csrf` header. The message does not say which |
| A 307 loop back to `/auth/sign-in` | The proxy has no session. If you are signed in on another tab, the cookie may be scoped wrong — check `NEXT_PUBLIC_SITE_URL` matches the origin you are on |
| **401** JSON `unauthenticated_no_session` on an API call | The proxy refused. API routes get a status, not a redirect |
| Every page loads but shows nothing | See the total-lockout mode at the end of this section |

### Confirming, from the database

Every sign-in, refusal and denial is an audit row:

```sql
SELECT occurred_at, after_state->>'kind' AS event, after_state->>'email', trace_id
  FROM audit_log
 WHERE entity_type = 'auth_session'
 ORDER BY occurred_at DESC
 LIMIT 50;
```

The kinds you will see are `sign_in_succeeded`, `sign_in_failed`, `sign_out`,
`step_up_succeeded` and `allowlist_rejected`. A run of `allowlist_rejected` with
your own address means either the allowlist is wrong or the address is
unverified in Supabase — the code cannot tell you which, on purpose.

And the identity row:

```sql
SELECT subject_id, email, role, last_sign_in_at, last_strategy, disabled_at, disabled_reason
  FROM auth_identity;
```

### Recovery

**There is no break-glass.** No backup codes, no admin bypass, no recovery CLI.
`pnpm --filter @naitikos/db seed` seeds feature flags, metrics, exercises, foods
and prompts, and does not touch `auth_identity` or `profile`. Three levers
exist, all out-of-band:

1. **Fix `AUTH_ALLOWLIST` and restart.** Comma-separated, lowercased and trimmed
   on parse. It is validated at process start (`serverEnv()` in
   `apps/web/lib/env.ts`) and `createAllowlist` throws on an empty list, so the
   application refuses to boot with a bad one rather than authorising the wrong
   person. Restarting also clears the in-process rate limiter, which is the
   fastest escape from a 429.
2. **Reset the password in the Supabase dashboard.** There is no in-application
   password-reset route. The `passwordReset` rate-limit rule is declared and
   unused.
3. **Un-revoke the identity in SQL**, if `disabled_at` is set. `docs/auth.md` §8
   documents the revoke direction; the inverse is `UPDATE auth_identity SET
   disabled_at = NULL, disabled_reason = NULL WHERE subject_id = '<subject>'`.
   This is one of the very few sanctioned writes, and it is sanctioned because
   `auth_identity` is access-control state rather than the record. It takes
   effect on the next request, because `findRoleBySubject` filters `disabled_at
   IS NULL`. Re-signing in cannot resurrect a revoked identity on its own —
   `linkSubject` returns `identity_disabled`.

Two more notes for the middle of the night:

- **The rate limiter is in-process and fixed-window**, keyed on a hash of the
  first `x-forwarded-for` hop, falling back to `x-real-ip` and then the literal
  string `'unknown'`. Locally, with no forwarding header, every client shares
  the `'unknown'` bucket. A restart or a redeploy clears it. Supabase-side
  throttling does not clear and is not resettable from here.
- **A successful sign-in resets the `signIn` counter** (`RESET_ON_SUCCESS =
  true`), so one correct attempt inside the window unblocks the rest.

### The total-lockout mode worth knowing about

RLS is `FORCE`d on all tables with zero policies. `FORCE` applies to the table
owner too. **If the application ever connects as a role without `BYPASSRLS`,
every query returns zero rows with no error at all** — you will be signed in,
the pages will render, and everything will be empty. `docs/auth.md` §8 puts
"Verify the app role has `BYPASSRLS`" in the Supabase project checklist for this
reason. Confirm with:

```sql
SELECT current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user;
```

### How to tell it is fixed

`GET /api/auth/session` returns `status: "authenticated"` with your email, role
and permissions, and a fresh `sign_in_succeeded` row appears in the audit query
above.

---

## 9. The database is unreachable

*Verified mechanisms; derived scenario.*

### What it looks like

Route handlers catch and return `internalErrorResponse(traceId)` — a 500 whose
body is:

```json
{
  "error": {
    "code": "internal_error",
    "message": "Something went wrong. The details are in the server log.",
    "traceId": "..."
  }
}
```

In the browser you get the root error boundary: "This page could not be
loaded", with Next's `digest` shown as the trace id. Sign-in may still work,
because it goes to Supabase Auth rather than to Postgres — which is exactly
the shape that makes this confusing. The application looks alive and every
page is empty or erroring.

Be aware that the 500 message overpromises. Several routes — `POST
/api/jobs/nightly` and all three handlers in `/api/media/uploads` among them —
catch with a bare `catch { return internalErrorResponse(traceId); }` and log
nothing, so "the details are in the server log" is not reliably true and the
`traceId` may appear nowhere.

### Locally

```bash
docker ps                          # is naitikos-postgres up and (healthy)?
pnpm db:up                         # start it — idempotent, keeps the volume
docker logs naitikos-postgres --tail 50
docker exec naitikos-postgres pg_isready -U naitikos -d naitikos
```

The container is `naitikos-postgres`, image `pgvector/pgvector:pg17`, published
on **5433**, not 5432 — deliberately, so that "which database did that migration
hit?" is a question you can ask. The volume is `naitikos-pgdata`, and `restart:
unless-stopped` means it should come back after a reboot on its own.

Then check the variable:

```bash
node -e "console.log(process.env.DATABASE_URL ?? 'unset')"
```

`databaseUrl()` throws when it is absent or empty — deliberately, with no
fallback to localhost, because "a silent fallback to `localhost` is how a
migration intended for a scratch database ends up running somewhere else". If
the message you got was that error rather than a connection refusal, the problem
is the environment, not the database.

**One thing `.env.example` does not tell you.** As of 7 September 2026 it
documents all six variables the application validates at startup, so copying
it and filling it in is now sufficient to boot. It leaves
`SUPABASE_SERVICE_ROLE_KEY` commented out and describes it as unused, which
matches `apps/web/lib/env.ts` — but the Supabase storage adapter throws at
construction without it. Nothing calls that adapter today, so the two
statements do not yet conflict in practice; the moment media upload is wired,
the key becomes required. Note also that `docs/auth.md` §8 says `cp
.env.example .env.local` where the file itself says "copy to `.env`" — pick
whichever your setup already uses and do not create both.

If the container will not start and the data directory is suspect, that is a
restore, and it has its own runbook: **[restore-drill.md](restore-drill.md)**.
Do not improvise it here, and do not run `pnpm db:reset`, which deletes the
volume.

### Hosted

Postgres is Supabase (§5.15). Check the project's status page and the connection
pooler; `max: 1` per client plus a module-scoped cache is what keeps serverless
invocations from exhausting the connection limit, so connection exhaustion
should not be self-inflicted — but the pooler being paused or the project being
suspended will look identical to an outage from here.

Two failure shapes are worth separating before assuming an outage:

- **Zero rows everywhere, no errors** is the `BYPASSRLS` case in §8, not a
  connectivity problem.
- **Errors on write and not on read**, or errors mentioning a missing column, is
  a schema mismatch — the application is running against a database that has not
  had its migrations applied. See **[migration.md](migration.md)**, and confirm
  with the `schema_migration` query in §3.1.

### How to tell it is fixed

`pg_isready` returns `accepting connections`, a `SELECT 1` succeeds through
`docker exec`, and a real page renders real rows. Then check whether the outage
stranded anything: the abandoned-run query in §3.1, and the stranded-idempotency
query in §4.

---

## 10. The app deployed but is broken

*Verified inventory of what exists; the recovery sequence is derived.*

### Establish which layer

| Test | Meaning |
| --- | --- |
| `GET /api/auth/session` returns 200 | The deployment is serving. Go to the next row |
| Signed-in pages 500 | Application or database. §9 first, then here |
| Pages render but are empty | `BYPASSRLS` (§8) or a schema mismatch (§9) |
| One surface throws, everything else is fine | A render bug — but note there is only one error boundary, so this presents as the whole content region failing |
| Writes fail, reads work | Usually a migration that has not been applied. See [migration.md](migration.md) |

### What to check, in order

1. **Did migrations run?** `SELECT id, applied_at FROM schema_migration ORDER BY
   applied_at DESC LIMIT 5;` and compare against `packages/db/migrations/`.
   Migrations are a discrete, gated step and never run on boot — "an application
   that migrates its own database on startup will eventually migrate it during a
   rollback" — so a deploy can absolutely ship ahead of its schema. `pnpm
   db:migrate` is the runner; it exits non-zero on failure so a pipeline halts
   rather than shipping a mismatch.
2. **Is the environment complete?** `serverEnv()` and the client schema both
   throw at module load, so a missing variable is a hard boot failure rather
   than a subtle one — a deployment that starts has passed that check. A
   deployment that will not start and gives no obvious reason is very likely
   this, and the error text lists the offending keys.
3. **Reproduce locally against a known-good tree.** `pnpm verify` runs
   typecheck, lint, test and build. It is the closest thing to a gate this
   repository has: `.github/workflows/` is empty, so nothing runs it for you.

### Getting back to known-good

**Roll the application back on the platform.** That is the intended lever and
§5.15 makes it the safe one:

> "Application rollback is instant via the platform. **Database rollback is not
> assumed to exist** — every migration must be forward-compatible with the
> previous application version, so a rollback never strands the schema. This is
> the single most important operational discipline in the document, because it
> is the one whose absence causes unrecoverable failures."

The practical reading at 11pm: **roll the application back, leave the database
alone.** The forward-compatibility discipline is what makes that safe, and it is
only safe in that direction. Do not attempt to reverse a migration to match a
rolled-back application.

Two things you might reach for and will not find:

- **There is no feature flag to disable a bad path.** §5.15 asks for them;
  `feature_flag` is seeded and read by nothing. Rollback is the only lever.
- **There is no version or build identifier surfaced anywhere in the
  application.** No `NEXT_PUBLIC_APP_VERSION`, no commit SHA, nothing on
  `/settings/developer`. Working out which build is live means asking the
  platform.

### How to tell it is fixed

A capture round-trips end to end: submit a Daily Close, watch the sync banner
clear, and see the row appear via the `recorded_at` query in §4. That exercises
the proxy, the guard chain, CSRF, the rate limiter, idempotency, the domain
write path and the database in one action — which is more informative than any
page loading.

---

## 11. What to capture while it is broken

Do this **before** you fix it. Most of these signals are transient, and two of
them are destroyed by the act of recovering.

**Capture first, because fixing destroys it:**

1. **The IndexedDB outbox**, if the symptom is sync. Screenshot the `entries`
   store or copy the records out. Retrying rewrites `attempts`, `status`,
   `nextAttemptAt` and `lastError`, and acknowledging deletes the record
   entirely. Once it is gone there is no server-side copy of what was queued.
2. **The `traceId`.** Every error response carries one, and the root error
   boundary shows Next's `digest`. Write it down before you close the tab.
3. **Server logs, now.** They are stdout, one JSON object per line, retained by
   the platform for 30 days hot (§5.13) and nowhere else — §9.4 keeps
   application logs out of Postgres deliberately. Copy the window around the
   failure while you can still find it by timestamp.

**Capture from the database, which persists:**

```sql
-- The run and its per-step detail.
SELECT id, status, started_at, finished_at, duration_ms, is_manual, error_message, steps
  FROM job_run ORDER BY started_at DESC LIMIT 5;

-- What was being emitted around the failure.
SELECT name, count(*) FROM app_event
 WHERE occurred_at BETWEEN '<from>' AND '<to>' GROUP BY name ORDER BY 2 DESC;

-- What changed, and when.
SELECT occurred_at, entity_type, entity_id, operation, actor, change_reason, trace_id
  FROM audit_log WHERE occurred_at >= '<from>' ORDER BY occurred_at DESC LIMIT 100;
```

### What you may not capture, and what to record instead

The `no-sensitive-log` lint rule is not a style preference and an incident is
exactly when it gets violated. §5.13:

> "Relying on a redaction *list* fails the moment someone adds a field and
> forgets — relying on a *type* fails loudly at compile time."

The enforcement is structural: `LogContext` has no `data` field, every logger
signature accepts names and numbers, and a value that genuinely aids debugging
goes in `protected` as a `Sensitive<T>` whose serialiser emits `[redacted]`. The
three sanctioned `console` calls in the repository are the three inside
`createConsoleLogger`, each with an explicit eslint-disable and a reason. Every
other console call is an error.

So, while debugging:

- **Do not add a temporary `console.log(payload)`.** It will fail lint, and the
  reason it fails lint is that a hosting provider's log aggregator is exactly
  where a journal entry must not go. If you need to see a value, log its *shape*
  — a length, a count, a type name, a boolean — or a `Sensitive<T>` wrapper and
  read the surrounding context.
- **Do not paste `audit_log.before_state` or `after_state` anywhere.** They hold
  whole entity snapshots: a journal entry, a symptom note. `createAuditReader`
  deliberately does not select them, and the reason given is that a viewer
  rendering them would put the most sensitive text in the database onto a
  settings page. Query `changed_fields` if you need to know *what* changed; the
  entity's own surface is where you find what it changed *to*.
- **Do not paste `idempotency_record.response_body`.** It is jsonb and it holds
  the full stored response of a successful mutation, which for a Daily Close is
  the day's answers.
- **Do not paste `observation.value_text`.** It is the content column for text
  metrics.
- **`job_run.error_message` is safe.** It is step names and error codes only, by
  construction, precisely so that a constraint violation cannot write the
  offending row's values into it.
- **`app_event` is safe.** The schema cannot represent user content — names and
  numeric measurements only — "which makes leakage impossible rather than
  prohibited".

### After it is over

The blueprint's own rule (§11.6): "Any operation performed twice manually gets a
runbook or a script." If you did something here twice, it belongs in this file.
If you found something this file got wrong, correct it — a runbook that has
diverged from the code is worse than no runbook, because it is trusted.

---

## 12. What this runbook does not cover

- **Restoring from backup, and the quarterly drill.**
  [restore-drill.md](restore-drill.md). §13.2 is blunt that this is the control
  that matters: "The restore drill is the control that matters — the others are
  hypotheses without it."
- **Applying, verifying and recovering from a migration.**
  [migration.md](migration.md).
- **Key rotation and re-encryption.** [key-rotation.md](key-rotation.md), which
  opens by saying the system has no encrypted objects and no key yet, so it is
  not executable today. If an incident ever turns out to involve a wrapped key,
  read its §1 before touching anything.
- **The AI layer.** No model runs in any path in this milestone; `ai.enabled` is
  seeded false and read by nothing.
