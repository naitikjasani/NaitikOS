# Timeline

**Status:** implemented, Week 2 · **Blueprint sections:** §3.2, §3.3 R5, §4.7, §5.3, §8.2, §8.9, §9.6
**Related:** [events.md](events.md) · [ADR 0005](adr/0005-domain-events-as-integration-log.md)

---

## 1. Why it is a projection

§3.3 R5 gives the timeline a job:

> "**Timeline is the escape hatch.** Any entity anywhere links to its position on
> the timeline; the timeline links back to every entity. This is the connective
> tissue that makes the system feel like one thing."

The obvious implementation is a `UNION ALL` across sixteen domain tables. It is
rejected, and ADR 0005 records why:

- It is re-planned on every request, over sixteen differently-shaped tables.
- It is **edited every time a domain is added** — so the escape hatch becomes the
  thing you have to remember to update, which is the failure mode §3.3 R5 exists
  to prevent.
- Sorting a union by time across sixteen tables cannot use an index well.

Projecting instead means **a new domain appears on the timeline by emitting
events, with no timeline code change.** That is the whole argument.

```
domain_event ──► timeline.project handler ──► timeline_entry ──► one indexed scan
   (append)          (pure projector)           (denormalised)
```

---

## 2. What an entry is

A row that can be **rendered without touching a domain table**, and **expanded by
following its links**. That split is the design: the list view is one indexed
scan; detail is a join the user asked for.

```ts
type TimelineEntry = {
  eventId: string;          // one entry per event
  sequence: number;         // the keyset cursor
  eventType, category, significance, clinical;
  occurredAt: string;       // the instant
  zone: string | null;      // the capture zone (§5.3)
  occurredOn: string;       // the day it belongs to, pre-computed
  title: string;            // rendered by the projector
  detail: string | null;
  correlationId: string;    // groups one user action
  links: TimelineLink[];    // back to every entity (§3.3 R5)
  media: TimelineMedia[];
  searchText: string;       // title + detail. Never payload.
};
```

Denormalising on write is a deliberate trade — the timeline is read constantly
and written once per event. It is *safe* because of ADR 0005's payload rule: the
fields above are labels and references, never authoritative values, so a stale
entry cannot disagree with a number.

---

## 3. The projector

`packages/core/src/timeline/project.ts`. Pure, and **total**.

### 3.1 Total, deliberately

Every registered event type produces an entry. There is no `null` return and no
"unknown event" branch that silently drops rows: an event that reaches here and
produces nothing is data the user created and cannot see, which is the worst
failure this surface can have short of losing the row.

A type with no bespoke renderer falls back to its registry `describes` string.
Ugly, and visible — which is the correct kind of wrong. `registry.test.ts`
asserts that no type is currently taking that fallback.

### 3.2 Pure, so a rebuild is trustworthy

Projecting the same event twice produces byte-identical entries. That is what
makes truncate-and-rebuild a routine operation. The integration test asserts the
rebuilt page equals the original page, and separately that a row read back
through Postgres equals what `projectEvent` produced — which is what catches a
jsonb key reorder or a numeric-becomes-string round-trip.

### 3.3 Phrasing: descriptive, never evaluative

§8.2 forbids colour-encoding valence, and the same applies to language.

| Event | Renders as | Not |
|---|---|---|
| `Medication.Skipped` | "Venlafaxine XR skipped" | ~~"Missed dose"~~ |
| `DailyClose.Completed` (partial) | "3 of 7 recorded" | ~~"Incomplete"~~ |
| `Workout.SetLogged` (PR) | "Personal record" | ~~"🏆 New PR!"~~ |

A skip is a decision the user made. §4.0: "A partial close counts as a close."
P6 rules out a tool that scolds, and P6 also rules out badges.

### 3.4 The mind domain renders no values

```ts
'Mood.Logged':           () => ({ title: 'Mood recorded',            detail: null }),
'AnxietyEpisode.Logged': () => ({ title: 'Anxiety episode recorded', detail: null }),
```

§4.7 gives Mind the highest duty of care. A list reading "Mood: 2 · Mood: 3 ·
Mood: 2" is a running commentary on someone's mental state, rendered by valence,
which §8.2 forbids. The value is one tap away in the entity it links to.

`searchText` is title and detail only — asserted for **every** type, not just the
mind ones. §4.7's journal text must not become searchable through the timeline,
and `Journal.Created`'s payload carries no content for the same reason.

### 3.5 The day an entry belongs to

`occurredOn` is computed in the **capture** zone, not UTC and not the reader's
current zone.

§5.3: "A workout at '7am' during travel is a materially different fact from one
at 7am at home, and discarding the zone destroys information you cannot
recover."

Concretely: 18:00 UTC is 23:30 in Asia/Kolkata *the same day*. Bucketing by UTC
would file most of the user's Daily Closes under the following date. This is the
same class of error as the `date_trunc` deviation in the schema — it compiles,
looks right, and is wrong by one day for half the entries.

`Intl.DateTimeFormat('en-CA', { timeZone })` rather than offset arithmetic,
because an offset is not a zone: a fixed `+05:30` cannot express a DST
transition, and hand-rolled offset maths is wrong twice a year everywhere that
observes one.

---

## 4. Querying

```
GET /api/timeline?from=…&until=…&categories=body,mind&search=…&limit=50
```

| Parameter | Notes |
|---|---|
| `from` / `until` | Half-open, so adjacent pages never double-count |
| `categories`, `eventTypes` | Comma-separated |
| `includeDetail` | **Default false** — see below |
| `clinicalOnly`, `withMediaOnly` | Partial indexes back both |
| `search` | Full-text over title and detail. Capped at 200 chars |
| `entityType` + `entityId` | §3.3 R5's "links back to every entity" |
| `grouping` | `none` · `day` · `week` · `month` · `correlation` |
| `afterSequence` | Keyset cursor — **not** an offset |
| `direction` | Default `backward` (newest first) |
| `limit` | Default 50, max 200 |

### 4.1 `includeDetail` defaults to false

A workout of forty sets emits forty `Workout.SetLogged` events. A collapsed
timeline showing all of them buries the rest of the day. The default query adds
`WHERE significance = 'primary'`, which a partial index serves.

### 4.2 Keyset pagination, not `OFFSET`

`OFFSET 40000` re-scans forty thousand rows on every page — and worse, it
*shifts* if an event is inserted mid-scroll, so a user paging back through five
years silently skips entries. A keyset cursor on `sequence` is stable and
O(page).

`hasMore` comes from fetching `limit + 1`, not from `COUNT(*)`. An exact count
over a five-year timeline is a full scan on every page, for information the UI
uses to decide whether to render one button.

### 4.3 Search uses `websearch_to_tsquery`

Not `to_tsquery`, which raises a **syntax error** on a stray apostrophe — so
typing `don't` in the search box would return a 500. `websearch_to_tsquery`
accepts what a person actually types: quoted phrases, `or`, `-exclusion`, and
unbalanced syntax.

### 4.4 Entity links use jsonb containment

```sql
links @> '[{"entityType":"medication","entityId":"…"}]'::jsonb
```

A GIN index serves it, so "everything touching this medication" is one indexed
lookup rather than a join to sixteen tables.

Links are built by the projector from the envelope's `subject` (relation
`subject`) plus every `*Id` field in the payload (relation `related`). That
convention is why `registry.test.ts` asserts reference fields are named `*Id` or
are on an explicit list of label fields.

---

## 5. Grouping and gaps

`groupEntries` preserves arrival order rather than re-sorting — the store has
already sorted by sequence, and re-sorting here would silently override a
`direction=forward` query.

**Correlation grouping** is the one worth understanding: it collects everything
from a single user action, so a Daily Close appears as one group of a dozen
entries rather than a dozen unrelated rows. The group is labelled from its most
significant entry, because a UUID is not a heading.

### `emptyDaysInRange` is not cosmetic

§8.9(3): "Gaps are gaps… Interpolation across a week of no data is fabrication."

A timeline that silently skips empty days makes a three-week gap in the record
look like three consecutive entries — the single most misleading thing this
surface could do. The walk is bounded at 2,000 days so a malformed range cannot
spin.

---

## 6. Indexes

`timeline_entry` carries nine, including partial ones on
`significance = 'primary'`, `has_media`, and `clinical`. The partial indexes are
what make the three default filters cheap; a full index on a boolean column that
is false 95% of the time is mostly wasted pages.

The `searchVector` is a **generated** tsvector column with `'english'` pinned
explicitly rather than left to `default_text_search_config` — a search index
whose stemming changes when the database is restored onto a differently
configured host is a genuinely confusing failure.

---

## 7. Rebuilding

```ts
await timeline.clear();
await bus.replay({ handlerNames: ['timeline.project'], ignoreLedger: true });
```

`clear()` truncates. Safe by construction (ADR 0005 rule 3): the projection is
derived and the projector is pure. **The event log is what must never be
truncated.**

`ignoreLedger` is required — the ledger correctly records that the handler has
already seen every event, which stops mattering the moment the table it wrote to
is empty.

The nightly `rebuild-timeline` step exists for the case where a projector change
means stored entries are stale. It is not registered yet, because nothing has
changed the projector since the projection was created.

---

## 8. Gotchas

- **`sequence: -1`** on an entry means the event was projected before it was
  appended. That is a programmer error; 0 would silently sort it to the beginning
  of history, so -1 is loud instead.
- **A progress photo's media is marked `isEncrypted`.** The timeline renders a
  placeholder rather than requesting a signed URL it cannot decrypt — otherwise
  every skin photo shows a broken image, which looks like a bug.
- **`zone` is `null`, not the profile zone**, when the event carried none. The
  fallback is applied to `occurredOn`; leaving `zone` null keeps §5.3's
  information loss visible rather than papered over.
- **`dayKeyInZone` returns a non-date** for malformed input — it slices the first
  ten characters. One entry groups under a nonsense heading rather than the whole
  timeline failing to render.
