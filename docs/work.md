# Work

**Status:** complete against §3.2's `/work` block, shipped 31 August 2026 (§12's
V3 Q1, built early). Projects, tasks and the career log first; learning, the
calendar import and focus sessions the same day.
· **Blueprint sections:** §4.8, §9.2, §9.3, §5.3, §5.4, §5.7, §10.9
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

## 8. Learning, calendar and focus

These three ship together because they share the property §2 was already
arguing for: none of them owns a fact another module owns. Notes live in the
polymorphic `note` table, energy lives in `mind.energy` observations, and
recurrence lives in whichever calendar the `.ics` came out of. What is left is
mostly a set of decisions about what *not* to record.

**Putting a book down is an outcome, not a failure.** `abandoned` is a
first-class `learning_status`, and the word on screen is "Put down" rather than
the blunter one the enum uses. A queue that can only be finished accumulates
guilt, and a queue that accumulates guilt stops being added to — at which point
it no longer records what was actually being read, which was the only thing it
was for. §4.8 wants the link between what was learned and what it was for, and
a book closed after forty pages with a sentence about why serves that better
than one parked at "in progress" for three years. The reason is asked for and
never required, the same rule tasks use in §3.

**Progress is `null`, not 0%, without a declared total.** A book, a course and
a talk count in three different units, so the total is declared per item with
its unit stored beside it, and `learningProgress` returns `null` when no total
was declared. §10.9 asks for *"insufficient data"* rather than a guess, and a
progress bar is a prediction like any other: sitting at zero for a book that is
half read is not the absence of a claim, it is a specific wrong one. The list
says *"180 pages in"* or *"No progress recorded"* instead.

**Notes are a lens, not a table.** §2 promised no `learning_note` and there is
none. `/work/learning/notes` reads the polymorphic `note` table filtered to
`entity_type = 'learning_item'` — §P3, a new lens over one substrate rather
than a second notes system with a second search index to keep in step for
twenty years. Every note is written with `ai_consent = 'none'` (§10.10). What
the operator thinks about what they read is their own reasoning, and §10.10's
scopes all default to off precisely so that consent to send a class of data
anywhere is asked for rather than assumed by whatever code happened to write
the row.

**`/work/learning/queue` renders the same board as `/work/learning`.** §3.2
lists both, so both exist and both are linkable, but the queue *is* the
learning surface and there is nothing on the parent page it would want to hide.
A second component showing a filtered subset would be two things to keep in
step — every change to how an item renders its progress, its unit or its
put-down reason landing twice, with the second copy the one that falls behind.
If a split later earns its keep, the route is already there to hang it on.

§4.8 states the calendar's purpose and it is not scheduling:

> **Calendar** — read-only import in V3. Its value is context: the load,
> travel, and meeting density that explains a bad week in every other domain.

**The parser is hand-written, and that is the cheaper option.** This system
needs a strict subset of RFC 5545: `VEVENT`s with a `UID`, a start, optionally
an end, a summary, a location and a partstat. Every general-purpose library
brings recurrence expansion with it, and expansion is the one thing a read-only
import must not do.

**`RRULE` is deliberately not expanded.** An event carrying one is imported as
its single `DTSTART` occurrence and flagged `hasUnexpandedRecurrence`. The
alternative is not neutral: silently importing one instance of a weekly standup
as though it were the whole series understates a year of meeting load by a
factor of fifty, on the one series whose entire job is explaining a bad week in
another domain. A flag is visible. A fiftyfold undercount is not.

**Attendees are a count. Identities are never stored, and `DESCRIPTION` is
dropped.** §4.8 asks for meeting density, and a number answers that completely.
The names on an invitation are other people's personal data arriving in a
system that has no consent model for them — they never agreed to be in this
record and cannot revoke anything from it. Meeting bodies are dropped for the
adjacent reason: agendas, dial-ins and links that belong to an employer are not
load signal, and the safest place to hold data you do not need is nowhere.

**The import upserts on `(source, external_id)` but never overwrites
`is_travel`.** A calendar is re-read repeatedly and events genuinely change —
moved, re-roomed, declined — so the source wins for everything it is
authoritative about. Travel is the exception: the importer guesses it once from
a word list, the operator is allowed to correct the guess, and a re-read is not
a licence to revert the correction (P5). A flag that silently reverts every
Monday is a flag nobody bothers to set.

**What a day's load actually counts:**

| Event | Contributes |
|---|---|
| Travel | Marks the day, and zero meeting minutes. A flight is not a meeting, and folding six hours of it into meeting minutes would make the series that explains a bad week explain it wrongly. |
| An all-day marker | Nothing. A holiday or a conference day has no stated duration, and treating it as 1,440 minutes would swamp every real number in the series. |
| A declined meeting | Nothing. It is not load. |
| An unanswered invitation | Counted. `is_accepted` is `null` rather than `true` so the two stay distinguishable, and the unanswered one is usually the one that was attended anyway. |
| A timed event with no end | Zero minutes. Inventing a default half hour puts a fabricated figure into a series whose only purpose is being compared against real ones. |

**There is no composite load score.** Four named figures — meeting minutes,
meeting count, focus minutes, travel — and nothing that folds them into one. A
composite needs weights and the weights would be invented. Six hours of
meetings and six hours of uninterrupted deep work are both a full day and they
are not the same day; a single number renders them identical while looking
authoritative about a judgement nobody made deliberately. It is the same
argument §5 makes against giving a project a "health" score, and it applies
harder here because this number would be the one carried into other domains.

**Interruptions are typed in, never detected.** Counting them automatically
means watching what the operator is doing — window focus, keystroke gaps,
notification delivery. That is a surveillance apparatus, and building one
inside a system whose premise is that the record belongs to its subject would
be a category error rather than a feature with a privacy caveat. It is also
worse data: the person who was there is the only one who knows that the phone
call was fine and the colleague at the door was not.

**`focusByHour` attributes a session wholly to the hour it started in.** Not
smeared across the hours it spans. The question §4.8's "energy mapping across
the day" is asked to answer is *when do I start doing real work*, and spreading
one three-hour block over three bars turns a decisive morning into a flat day.
Smearing would also force a ruling on what a session crossing midnight means —
a quantity of arithmetic in service of a chart nobody would read differently.
The bands are labelled as hours with recorded deep work, never as peak hours: a
morning nobody logged is not a morning nobody worked.

§3.2's `/work` block is now complete — overview, career, tasks, projects,
learning, queue, notes, calendar, focus. What §4.8 asks for and still has no
surface is short:

| Not built | Why |
|---|---|
| Focus cross-referenced with sleep and mood | §4.8 names it directly. Both series are day-keyed through `dayKeyInZone` precisely so they can be stacked, and stacking them is a charts job. Saying anything about the two beyond adjacency is governed by §10.6's five controls, and none of them is satisfied by two strips on a page. |
| Energy mapping over `mind.energy` | The hour bands say when deep work happened, not what energy it happened at. §2 refused an energy table for the right reason and the observations are already on the substrate; nothing reads them from this side yet. |
| Recurring meetings as a series | Never, by design. `hasUnexpandedRecurrence` flags them and stops there. Expansion belongs to the source calendar (§2), and an import that is only supposed to be reading has no business reimplementing it. |
