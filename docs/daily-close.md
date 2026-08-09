# The Daily Close

> Blueprint §4.0, §1.5, §12 week 2. Code: `packages/core/src/close/`,
> `apps/web/features/daily-close/`, `packages/db/src/repositories/daily-close.repository.ts`.

§12 calls the Close "the week's actual deliverable and everything else is
supporting". §1.5 makes the count of completed Closes the North Star. It is the
one screen the whole product turns on, and §4.0 constrains it harder than
anything else in the system.

## The specification, and what each clause forces

> "Capture the day's minimum viable record in under sixty seconds, every day,
> forever."

> "Single screen, no scrolling on a phone. If it does not fit, something must be
> cut."

> "Every field is optional. A partial close counts as a close. This is
> deliberate: a system that rejects incomplete data trains you to skip it
> entirely on a bad day, and bad days are the most clinically interesting days
> you have."

> "Never more than eleven interactive elements."

> "Adding a field requires removing a field. The Close is a fixed budget, not a
> growing form."

### The form is generated, not written

`buildCloseForm(registry, medications, dayKey, zone)` builds the field list from
`metric.in_daily_close`. A hand-written screen with six hard-coded fields would
be shorter today and would make the budget unenforceable — the eleven-element
cap becomes a comment somebody has to remember, and comments lose to shipping
pressure over twenty years.

Generated from data, the budget is arithmetic, checked on every build by
`close/form.test.ts`. A seventh Close metric fails the test rather than silently
lengthening the ritual.

It also makes the medication toggles possible at all: §4.0 wants one per
*active* medication, which is not knowable at authoring time.

### What counts as an "interactive element"

One **decision**, not one DOM node. A 1–5 tap scale renders five buttons and
costs one. The stricter reading would put the six MVP scales alone at thirty and
make §4.0 unsatisfiable given it also lists seven contents — so it cannot be
what the section means. The two readings differ by a factor of five, which is
why the choice is recorded rather than assumed.

Current budget: **6 metrics + 1 note = 7**, leaving room for four medication
toggles.

### Overflow is surfaced, never silent

"If it does not fit, something must be cut" is an instruction to a person. The
code's job is to make the person aware, so `CloseForm.overflow` carries what did
not fit and the screen renders a warning. The note line survives an overflow
even though it is last: on a day when the Close overflows, the free-text line is
the most clinically interesting thing in it.

## Re-submitting the same day

The operator closes at 21:00 with four fields and remembers the rest at 23:30.
That is the normal case, not an edge case, and four rules govern it.

1. **A partial close is a close.** The completion marker is written even when no
   other field is answered.
2. **Re-submitting corrects; it does not duplicate.** §9.1 makes the second
   submission a supersession — a new observation with the old one pointing at
   it, both surviving — rather than an edit.
3. **An unchanged answer writes nothing.** Otherwise a replayed outbox entry
   builds a correction chain of identical numbers, which turns "how many times
   did I revise this?" into noise.
4. **The completion marker is written once per day.** `system.daily_close.
   completed` is the North Star input, so a second marker would double-count
   that day forever.

Rule 3 depends on comparing by *decimal value* rather than by string, because
`numeric(20,6)` reads a stored `1` back as `1.000000`. A string comparison would
find every boolean "changed" on every re-submission.

## `observed_at` versus `recorded_at`

§9.5 splits *when it happened* from *when the system was told*, and the Close is
where they routinely differ — a close submitted at 00:40 is usually about
yesterday.

- Closing the **current local day** → `observed_at` is now. True and precise.
- Closing an **earlier day** → the last instant of that day, which is the latest
  moment the answers could describe.

`recorded_at` is always now, so the divergence stays visible rather than being
flattened into one timestamp.

Local noon was considered and rejected: it puts a fact in the middle of a day
that had not finished when the fact was formed, and it would sort a back-filled
close *before* observations genuinely captured that evening.

A close for a **future** day is refused rather than clamped. The append-only
record has no mechanism for un-recording a day that has not happened, and the
plausible cause is a phone with a wrong clock — the same fault the HLC's drift
ceiling guards against.

## The write

`planDailyClose` is pure: it takes a submission, the day's current state and a
clock, and returns a plan. `DailyCloseRepository.commit` executes that plan in
**one transaction**.

The split is what makes §4.0's rules testable from a literal instead of from a
database. Every interesting case — partial close, re-submission, unchanged
answer, cleared note, medication toggle — is a plan-level unit test.

One transaction because §5.7 lets the outbox "replay any request any number of
times", which is only safe if the request is a single unit. A Close that
committed its observations and then failed on the note would, on replay, write
the observations again as corrections of themselves.

## The note

§4.0's "one free-text line, optional" is a `note` row with
`entity_type = 'observation'` and `entity_id` = the day's completion marker.

Not a `journal_entry`: that is a Mind-module concept with prompts, a mood
snapshot and its own consent scope (§4.7). A one-line note in the Close is
cross-cutting, which is exactly what the polymorphic `note` table is for.

Anchoring it to the completion observation means one note per close,
discoverable from the close, with no separate "which note belongs to today?"
query to get wrong.

The note is an entity, so it is edited in place and its prior text is preserved
in `audit_log` (§9.4) rather than in a supersession chain. Two mechanisms for
history would be one too many. Clearing it tombstones the row; nothing is
hard-deleted.

## Medications

The Close's medication toggles are fully implemented — form generation, budget
arithmetic, and `medication_event` writes with tombstoning on change.

**The medication register itself is not built.** §12 puts it in week four, and
`loadDailyClose` passes an empty list today. That is the honest state of the
register rather than a stub: the moment rows exist, the toggles appear, and the
change is a repository read rather than a redesign.

## Compounding Days

§1.5's North Star: "the count of days in the trailing 90 on which a Daily Close
was completed."

`compoundingDays` counts **distinct local days**, bucketed by the zone each
close was *captured* in rather than the zone the caller asked about. A close
written at 23:00 in Kolkata and read from London is still that day's close;
re-bucketing it into the reader's zone can move it onto a day that already had
one, quietly deleting a Compounding Day.

There is no streak, anywhere, deliberately. §5.9 bans streak notifications; the
concept fails for the same reason — a streak makes the cost of one missed day
the loss of everything before it, which is exactly the pressure that ends a
twenty-year record in month three. A count in ninety recovers from a bad week on
its own.

## Routes

| Route | What it is |
|---|---|
| `/today` | The Now panel: is today closed, and the Compounding Days count |
| `/today/close` | The Close, full page, `?day=YYYY-MM-DD` to back-fill |
| `GET /api/close` | The form *and* the day's current answers, in one response |
| `POST /api/close` | Record a close. Idempotent, replay-safe |

§3.2 suggests the Close as a modal on Today. It is a route instead: §4.0
requires "a single screen, no scrolling on a phone", and a modal over a page
that already has two cards cannot honour that on a small viewport. The route is
the honest reading of the constraint that matters more.

`GET` returns the form and the answers together because a form with no current
values renders every field empty on a re-close — which is how an operator
overwrites a morning's answers by accident.
