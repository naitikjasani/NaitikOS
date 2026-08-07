# ADR 0005 — Domain events are an integration log, not a second system of record

- **Status:** Accepted
- **Date:** 3 August 2026
- **Blueprint sections:** §9.1 (two kinds of data), §9.3 (the shape of the graph), §9.4 (audit), §5.2 (background work)

## Context

The blueprint has no domain event system. It has three append-only or
append-only-adjacent structures, and they already overlap:

| Structure | Records | §  |
|---|---|---|
| `observation` | A value that was true at a moment. Immutable, never deleted. | §9.1 |
| `audit_log` | Every mutation to every entity, with before/after. Never pruned. | §9.4 |
| `medication_event`, `product_event`, `routine_log` | Domain-specific occurrences | §9.2 |

The milestone asks for a fourth: a strongly typed, immutable domain event for
every meaningful action, with an event bus, replay, and a timeline projected
over it.

That is a real addition, and the obvious implementation is the dangerous one.
§9.3 states the property at risk:

> Cross-cutting entities read widely and write narrowly. Goals own definitions,
> not progress. Insights own findings, not data. **This is what stops derived
> state from becoming a second, drifting source of truth.**

If a `WeightLogged` event carries `{ value: 74.2, unit: 'kg' }` *and* an
`observation` row carries the same numbers, there are now two places to read a
bodyweight from and nothing keeping them equal. In a twenty-year medical record
that is not a stylistic problem — §9.1 says plainly that if a number cannot be
relied upon, "the entire premise fails".

## Decision

**Build the event system, and define it as an integration log rather than a
system of record.**

Three rules make that concrete:

1. **Events reference; they do not restate.** Every event carries
   `subject: { type, id }` pointing at the authoritative row. The payload holds
   only what a timeline row or a job router needs in order to act *without a
   join* — a label, a metric key, a count. Never the authoritative value.
2. **The write comes first, in the same transaction.** An event is emitted only
   after the row it describes exists, and both commit together. There is no
   window in which an event refers to something that is not there.
3. **Replay rebuilds projections, never entity state.** Replaying the log
   reconstructs the timeline and re-runs handlers. It does not reconstruct an
   observation, because the observation is the truth and was never derived from
   the event.

## What the event log is the system of record for

Something, or it would not be worth having. It owns the three facts nothing else
in the schema captures:

- **Causality.** `correlationId` and `causationId` — that a `WorkoutCompleted`
  and eleven `SetLogged` events were one user action, and which caused which.
  `audit_log` has a `traceId` but no parent link.
- **Ordering across domains.** A single monotonic sequence over every domain, so
  "what happened that week" is one indexed scan rather than a union over sixteen
  tables. This is what makes §3.2's Timeline surface implementable at all.
- **Intent.** `audit_log` records that a row changed. An event records that a
  person *did something*. "Medication skipped" is not a mutation; it is a
  decision, and it is the more clinically interesting of the two.

## Alternatives rejected

**Full event sourcing — events as truth, tables as projections.** The
architecturally pure option and the wrong one here. §9.1 has already chosen its
spine: "There is one observation log and one entity graph." Re-seating that on an
event store would mean rewriting the §9 schema, rebuilding the migration history,
and accepting that every read goes through a projection that can lag. §11.7's
24-hour cooling period exists for changes like this; the answer after cooling is
still no, because the blueprint's model is *already* append-only where it matters
and event sourcing would buy a second mechanism for a guarantee it has.

**Reuse `audit_log` as the event log.** Tempting — it is already append-only and
permanent. Rejected because §9.4 is explicit that "the audit log is not the
application log", and the same reasoning separates it from a domain log: audit
rows are keyed by mutated entity and carry whole before/after row states, which
means they carry journal text. A timeline query that scans `audit_log` is a
timeline query that reads the diary. Keeping them apart is a privacy boundary,
not tidiness.

**No event log; project the timeline directly over the domain tables.** Viable
today with three tables and unviable at sixteen — a sixteen-way `UNION ALL` with
per-branch filtering, re-planned on every query, and edited every time a domain
is added. §3.3 R5 makes cross-cutting reads go through the substrate precisely to
avoid that shape.

## Consequences

**Intended.** The timeline is one indexed table. A new domain appears on it by
emitting events, with no timeline code change (the milestone's stated
requirement). Background work is triggered by events rather than by polling.
Causality becomes queryable.

**Cost, stated honestly.** A fourth append-only structure to understand, and a
discipline that must hold: *events reference, they do not restate.* The moment a
payload carries an authoritative value, this ADR has been violated and the
drift it exists to prevent has started. `events.payload.test.ts` asserts the
rule structurally for every registered event type, so the violation fails CI
rather than being noticed in year three.

**Storage.** §9.7's arithmetic applies: roughly 50 human actions a day is under
400,000 event rows over twenty years. A rounding error for Postgres, no
partitioning needed.

**Not a queue.** §5.2 permits "exactly one scheduled entry point — a nightly job
at 03:00". The bus dispatches synchronously in-process on commit; deferred work
is a row in a job table that the single nightly runner drains. Introducing a
second scheduler would need its own ADR and would have to justify itself against
C3.

## Revisit if

A projection appears that genuinely cannot be rebuilt from the entity tables —
where the event log holds information the rows do not. At that point the log has
become a system of record for something, and either the entity model is missing a
field or this ADR needs amending. Either way it is a deliberate decision, not a
drift.
