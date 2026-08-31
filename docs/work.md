# Work

**Status:** projects, tasks and the career log shipped 31 August 2026 (§12's V3
Q1 block, built early). Learning, calendar and focus are schema-only.
· **Blueprint sections:** §4.8, §9.2, §9.3, §5.3, §5.4, §5.7
**Related:** [goals.md](goals.md) · [observations.md](observations.md) ·
[charts.md](charts.md)

---

## 1. The pillar is justified by its joins, not by itself

§4.8 ends with the sentence the whole module is shaped around:

> work load is a major input to Mind, Sleep, and Gym adherence. This pillar is
> the missing variable that explains a great many patterns in the others, which
> is why it earns its place despite being the least "quantified-self" of the
> five.

Read as a design constraint, that says the value of Work is *comparability*.
Every table is therefore shaped to be joined against a day, and the two derived
columns exist for exactly that:

| Column | Why it is stored rather than derived |
|---|---|
| `task.completed_day_key` | The question is always "what did I close on the day I slept badly". A zoned `date_trunc` in a `WHERE` clause is not sargable, so deriving it would make the index decoration. |
| `focus_session.day_key` | Same argument, same join. |

`completed_at` and `completed_day_key` are written together or not at all, and
`task_completed_together` is a `CHECK` constraint rather than a repository
habit. A task that is done but invisible to every per-day query is the one
failure this design cannot tolerate, and a convention is not a guarantee.

## 2. What the schema deliberately does not contain

Three tables a Work module would normally grow, and the reason each is absent.

**No `learning_note`.** `/work/learning/notes` will read the polymorphic `note`
table with `entity_type = 'learning_item'`. §P3 asks for new lenses rather than
new systems, and a second notes implementation means a second search index to
keep in step across twenty years.

**No energy table.** §4.8's "energy mapping across the day" is a lens over
`mind.energy` observations the substrate already holds. Copying them into Work
would create the second source of truth §9.3(4) exists to prevent.

**No recurrence model.** Calendar import is read-only (§4.8), so an expanded
occurrence is what arrives and what is stored. An `RRULE` column would mean this
system reimplementing expansion and getting it subtly wrong against the source
it is only supposed to be reading.

## 3. Tasks are minimal, and the minimality is the feature

§4.8:

> **Tasks** — deliberately minimal. Not a competitor to a dedicated task
> manager. Its purpose is linkage: a task attached to a goal, a project, or a
> health action.

There is no priority column, no estimate, no recurrence, no sub-task and no
manual sort order. Each would be a field the operator felt obliged to fill in
before doing the thing they opened the app to record, and §1.4's capture-friction
counter-metric is the one this module is most likely to lose against.

Four buckets: overdue, today, this week, **someday**. The fourth is the one that
matters. A task manager that forces a date onto everything produces a list where
every date is a lie and the overdue count stops being believed within a
fortnight. An undated task sits undated indefinitely; `staleTasks` surfaces it
after sixty days as a question — *still things you mean to do?* — and closes
nothing on the operator's behalf.

Dropping asks why; finishing does not. A completed task explains itself; in year
three a dropped task with no reason is indistinguishable from a forgotten one.
The field is asked for and never required — an honest blank beats an invented
reason.

## 4. The career log's real metric is silence

§4.8 states the problem before the feature:

> Solves a real recurring problem: reconstructing a year of work at review time
> from memory. Every shipped thing gets one line on the day it ships.

So the number that matters is not how many entries exist. A log with forty
entries all typed the week before a review *is* a memory reconstruction with
extra steps. `loggingGap` measures days since the most recent entry, against
`occurred_at` rather than `created_at` — backdating an entry to the day it
happened closes the gap it was written to close, which is the behaviour the
protocol wants to reward.

Fourteen days of silence gets one sentence. Not a badge and not a streak: a log
that shames you for a quiet fortnight is a log you stop opening.

Two rules are enforced rather than suggested:

- **Feedback and recognition need a source.** Enforced in `core`, again in the
  contract, and stated in the form before you type. At review time the first
  question asked of "good work on the migration" is who said so, and an entry
  that cannot answer is worse than no entry because it looks like evidence.
- **Visibility is three counts, never a percentage.** "Seen", "not seen" and
  "not recorded" are three different answers, and a ratio folds the third into
  one of the other two. That produces a confident number out of an incomplete
  one, on the page most likely to be read before a conversation about money.

## 5. The overview asserts nothing

`/work` draws tasks-closed-per-day as an `AdherenceGrid` over four whole weeks —
the same component the routine and medication screens use, so laying it next to
them is a matter of looking at two pictures rather than reconciling two day-key
conventions.

It carries no interpretation. §4.7 forbids *"your mood is low because you
skipped the gym"*, and the prohibition runs in both directions: a heavy week and
a bad night sit next to each other on this page and the system says nothing
about which produced which. Anything stronger than adjacency is governed by
§10.6's five controls, and none of them is satisfied by two columns on a screen.

A project shows open tasks and career entries side by side and never combines
them. Eleven open tasks with nothing logged is a different situation from two
open tasks with six entries, and a single "health" score renders them identical
while looking authoritative.

## 6. Nothing here queues offline

The observation path queues through the outbox because an observation is an
append with an idempotent insert behind it. A task close is a **state
transition**, and the outbox replays in queue order rather than causal order — a
close replayed after a reopen would leave the row in the wrong state with
nothing anywhere to detect it.

So `/api/work` is online-only, and the task form says so rather than letting the
operator discover it when a queued task never appears. The same reasoning
`goalClient.ts` and `registerClient.ts` already record.

## 7. One name collision worth remembering

The enum is `work_task_status`, not `task_status`, because the event log already
owns a `task_status` for `deferred_task`'s pending/running/succeeded lifecycle.

The database half failed loudly: drizzle-kit found the name in its snapshot,
emitted no `CREATE TYPE`, and produced a migration that died on
`invalid input value for enum task_status: "open"`. The TypeScript half would
have failed quietly — a second `export const taskStatus` reachable through the
schema barrel is an ambiguous re-export, which ESM resolves by exporting
neither, with no error at all.

## 8. Not built yet

| Surface | State |
|---|---|
| `/work/learning`, `/work/learning/queue`, `/work/learning/notes` | `learning_item` exists; notes will read the shared `note` table. No UI. |
| `/work/calendar` | `calendar_event` exists with `(source, external_id)` as the re-import idempotency key. No importer. |
| `/work/focus` | `focus_session` exists. No UI, and no automatic interruption counting — that would need to watch what the operator is doing, which is a surveillance apparatus this design has no intention of building. |
