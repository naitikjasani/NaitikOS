# People and Places

**Status:** complete against §3.2's `/life/people` and `/life/places`, shipped
6 September 2026. These were the last two [V3] routes in the route table with
nothing behind them.
· **Blueprint sections:** §3.2, §5.0, §5.3, §5.4, §9.2, §9.4, §10.0, §10.6, §8.9
**Related:** [sleep.md](sleep.md) · [insights.md](insights.md) ·
[timeline.md](timeline.md)

---

## 1. There is no §4 section for either of these, and that is the interesting part

Every other pillar arrived with a §4 subsection setting out what it is for.
These two have two words each in the route table and nothing else. That absence
is a design opportunity rather than a licence: without a spec to satisfy, the
right question is what each route can answer that no other page can, and to
build exactly that.

**People answers one question: who have I not spoken to.**

**Places answers a different one, and it is the more load-bearing: what was
going on that would move every series at once.**

Both are small on purpose. What follows is mostly a record of what was left out.

## 2. This is not a CRM, and the distinction decides every column

A contacts app stores facts *about people*. This stores facts about **the
operator's contact with them**.

That is not pedantry. Everything else in this database is the operator's own
record of their own life, held under P7's local-only posture because it is
theirs to hold. A third party's details are not theirs in the same way — and
that person will never see the row, never correct it, and never know it exists.

So, absent by decision:

| Not stored | Why |
|---|---|
| Phone, email, address | Belongs in an address book — a system built to sync it and to be wiped with a lost phone |
| Closeness, importance, sentiment | A number ranking one's friends is a thing to have written down exactly never |
| Year of birth | Somebody else's personal data with no bearing on any question here |
| What was said | An interaction records *that* contact happened, and whatever note the operator chose to write |

A field absent from the Zod contract cannot be sent at all, which is a stronger
guarantee than a repository that declines to persist it.

`relationship_kind` is six coarse buckets. A finer taxonomy — "close friend"
against "friend" — is a judgement about a person, stored permanently, where
that person cannot see it. Six is enough to answer the question the page exists
for.

## 3. The cadence is set, never inferred

The obvious feature is to learn the natural rhythm of a relationship from its
history and flag departures from it. It is also precisely what §10.0 forbids:
*"the model never computes, discovers, or asserts."*

A system telling someone they are drifting from a friend, on the evidence of a
gap between two timestamps, is asserting something about a relationship it
cannot see. It cannot see the message sent from a phone, the afternoon nobody
logged, or the fact that this is simply how the two of them are.

So `contactStatus` compares against a cadence the operator typed. With none, the
state is `untracked` — **not "fine"**, and not a default of ninety days. §8.9's
"missing data is shown as missing", applied to an absent intention rather than
an absent measurement.

The page copy is careful with the word *overdue*. The badge says the state, the
line beneath says how long it has been and what that is measured against. It is
a prompt to look, never a verdict.

### Two small decisions with reasons

**The grace period scales.** Three days past a weekly call is a different thing
from three days past an annual one. `dueGraceDays` is a tenth of the cadence,
floored at a day and capped at a week.

**`never` ranks below `due`, not above `overdue`.** Someone with a cadence and
no recorded contact is almost always someone added five minutes ago. Putting a
fresh row at the top of an alarm list every time one is created would make the
top of the list mean nothing within a fortnight.

**Status compares days, not instants.** A call at 23:50 and one at 00:10 the
next morning are a day apart in the only sense this page cares about; comparing
instants would report "0 days" for one and "1 day" for the other on the strength
of twenty minutes.

## 4. Birthdays are a day and a month

Stored as `--MM-DD`, the RFC 6350 partial date the vCard spec uses for exactly
this case, so the omitted year is explicit rather than encoded as a sentinel
nobody remembers the meaning of.

The validity check is split across two layers, and the split is the point:

- The **column CHECK** enforces `^--[0-1][0-9]-[0-3][0-9]$`. It is the
  guarantee, and it holds against a hand-edited row at 2am.
- **`validatePerson`** rejects `--02-30`, which the regex accepts and which is
  not a day. A CHECK expressive enough to know how long February is would be a
  calendar implemented in SQL.

29 February is accepted, because the year is unknown by construction and
refusing it would refuse a real birthday held by real people. In a common year
it is shown on the 28th: moving it to 1 March would put it in the wrong month,
and hiding it would be worse than either.

The look-ahead wraps across the year end, so a 3 January birthday is four days
away on 30 December rather than 361 days ago.

## 5. Places exist because a trip explains a discontinuity

§10.6's detectors watch for changes in series. A fortnight abroad moves sleep
midpoint, weight, skin state, training volume and step count **simultaneously**,
for reasons that have nothing to do with anything the system is measuring.

§5.3 already insists on this one row at a time:

> A workout at '7am' during travel is a materially different fact from one at
> 7am at home.

A visit is that same fact at the scale of a fortnight, recorded once rather than
inferred from a hundred timezone offsets. `travelDays` is the function an
insight consults before reporting a disrupted fortnight as a finding, and the
number at the top of `/life/places` is days away in the last thirty.

`place.zone` is the load-bearing column: it is what lets a visit match a run of
foreign observation offsets. A typo there leaves the explanation silently unable
to match — a bug that looks like missing data — which is why the zone is checked
in `core` and not only at the wire.

### A trip is not a visit

A fortnight covering three cities is one thing the operator remembers and three
things the timezone data shows. Collapsing them makes "how many trips last year"
unanswerable; splitting them without a container makes it wrong. So a trip
groups visits, and a visit can have no trip — which is the normal case for home.

### Days, not instants, and both ends inclusive

An arrival has a precise moment, but the question is "where was I on the 14th",
and a half-open instant range puts a red-eye landing at 02:00 on the wrong side
of it. Both ends inclusive because a one-day visit is `arrivedOn === departedOn`,
which a half-open range cannot express without an off-by-one.

## 6. An open-ended visit is implicitly closed by the next arrival

This is the one piece of real logic in the module, and the naive reading is
wrong in a way that only shows up once there is data.

Home is open-ended by construction — nobody types a departure date for their own
house before a weekend away. Taken literally, that makes home overlap **every
trip ever recorded**, and `findOverlaps` fills with the one arrangement that is
not a mistake. An overlap list that is mostly noise is an overlap list nobody
reads.

So `resolveVisits` sorts by arrival and closes each open-ended visit at the next
arrival. That is not a workaround; it is how people actually keep this record.
Home is where you are when you are not somewhere else.

The handover day belongs to both — you departed and arrived on it — so the
effective end is the next arrival rather than the day before it. `placeOnDay`
resolves the tie in favour of the arrival, since that is where the night was
spent, and `findOverlaps` treats a shared boundary as touching rather than
overlapping. Every journey with a connection looks like that.

## 7. Overlaps are reported, not refused

A person is in one place at a time, so any genuine overlap is a mistake — nearly
always a departure date typed later than it should have been.

The write is still accepted. The fix is editing one of the two rows, and a write
that refused the newer one would make that impossible from the page showing the
problem. P5: the operator is always right, and always able to correct the
record.

`findOverlaps` is quadratic in the worst case with an early break that makes the
common case linear. A sweep over sorted intervals is the right algorithm for a
hundred thousand rows and the wrong one for the forty a person accumulates in a
decade (§5.5).

## 8. Nothing here is derived, and nothing will be

An inferred relationship, or an inferred trip from a run of foreign timezone
offsets, would be §10.0's forbidden move: the system asserting something about
the operator's life from a signal merely *consistent* with it.

`calendar_event.is_travel` is a guess and is labelled one. These are not
guesses, and there is no import path that would make them into guesses.

## 9. What the wire does and does not accept

`POST /api/social`, one discriminated union, ten kinds. Permission is
`observation:write` — nothing here changes how any other record is interpreted,
so §5.4's blast-radius split puts both pillars on the narrow side.

**No `dayKey` on an interaction.** The server derives it from the instant and
the zone, the same rule `/api/learning` applies to a focus session: a client
that could send the pair separately could send them disagreeing, and a contact
pointing at two different days is invisible to the per-day joins it feeds.

**No contact status, no travel days.** Both are derived on read. A client that
could write one would be a second source of truth for a figure the server
already computes — §9.3(4)'s drift.

**Coordinates are strings.** §5.3's no-floats rule reaches the wire: a
coordinate parsed to a JS double and re-serialised is not the coordinate that
was sent.

**A delete reason is optional.** §9.4 argues for *asking* why something was
deleted, not for refusing to delete without an explanation. A mandatory reason
field is a field that gets filled with "x" within a week, at which point the
audit log records nothing and everybody has been inconvenienced.

## 10. Reading a person's last contact

The list needs, per person, the day of their most recent interaction. Loading
every interaction and reducing in JavaScript works at forty people and stops
working at four hundred.

`interaction_person_idx` is ordered `(person_id, occurred_at DESC)` and filtered
on live rows precisely so a correlated `LATERAL` with `limit 1` walks a single
index entry per person. It is written as raw SQL rather than composed through
the query builder, because a `LATERAL` correlated on the outer table is not
something Drizzle's `leftJoin` expresses, and writing it out is honest about
what it is.

The *status* is computed in `core`, not in the repository. §5.0 puts that
judgement below the database, which is also what makes it testable in
milliseconds without Postgres.

## 11. Soft delete, and the one case where it is not enough

`person` is soft-deleted like every other entity (§9.4): interactions point at
it, and a dangling interaction is a record of contact with nobody.

`purge` remains the one path that actually removes data, and it is the right one
when the answer is *"this person should not be in my database at all"* — which,
for a table holding facts about somebody who never consented to being in it, is
a request that deserves to be honoured completely rather than by hiding a row.

## 12. What is not built

**No map.** `place` carries optional coordinates, unindexed. There is no
geocoding and no radius query; the latitude is there so a future map has
something to read, not because anything reads it today. §5.5's position on
speculative indexes: an index costs a write on every insert forever in exchange
for a query nobody has written.

**No import from a phone's contacts.** That would pull in exactly the fields
§2 above declines to store, and deleting them after the fact is not the same as
never having had them.

**No reminders.** The cadence is shown on a page the operator opens; it does not
fire a notification. §5.9 makes every notification justify itself, and "you have
not called your mother" is a sentence a piece of software should be very slow to
send.

**Nothing on the Life Timeline yet.** A trip is a natural `life_span` and a
visit is arguably a `life_event`, but wiring them would mean one fact in two
tables with no rule about which wins. The join belongs in a commit that decides
that, not in this one.
