# Mind

**Status:** implemented, Week 4 · **Blueprint sections:** §4.7, §9.2, §10.10, §12
**Related:** [insights.md](insights.md) · [daily-close.md](daily-close.md) · [accessibility.md](accessibility.md)

---

## 1. This module has different rules from every other one

§4.7 says so directly:

> "Given the operator's clinical context — anxiety disorder, active Venlafaxine
> XR and Escitalopram — this module carries the highest duty of care in the
> system, and its design principles differ from every other module."

Four of those principles are structural rather than editorial, which means they
are enforced in code rather than reviewed for in a pull request.

| Principle | Where it is enforced |
|---|---|
| No negative framing, ever | `MIND_SCALES` labels and `toneFor` in `core/domain/mind/scales.ts`. `toneFor` cannot return an alarm tone — a test asserts the whole output set is `{neutral, accent, attention}`. |
| No causal claims about mental state | `trigger` and `copingResponse` are nullable free text with no vocabulary and no picker. `summariseEpisodes` returns `namedTriggers`, never `causes`. |
| Crisis-state awareness | `CrisisSurface` has exactly one field. There is no `message`, no `severity`, nothing a component could render advice from. |
| Journal is the most sensitive data | Consent is checked at the wire, in the domain, and by a database constraint. `journalList` does not select `content`. |

## 2. The three things worth arguing about

### 2.1 The journal list shows headings, never prose

The obvious design is date, first hundred and twenty characters, chevron. It
puts the darkest thing the operator has ever written on screen the moment they
open the tab — on a train, at work, next to someone.

So `JournalListItem` has no `excerpt` field, and the fallback heading is a word
count rather than a derived summary (a derived summary is an excerpt with a
different name). The enforcement is in the repository: `journalList` selects
`id, written_at, zone, title, mood_at_writing, prompt_id` and computes the word
count in SQL, so `content` never enters the result set and a component *could
not* render an excerpt if someone added the markup for one.

The entry itself is a separate route (`/api/mind/journal/:id`) with
`Cache-Control: no-store`, a `staleTime: 0, gcTime: 0` query so it leaves the
query cache on unmount, and a service worker that never caches `/api/` at all.
Three layers, because a cached journal entry is a copy of the most sensitive data
in the system sitting in a browser cache directory.

It is a separate route rather than a query parameter on the list for the same
reason: a single URL that *sometimes* returns prose is a URL whose caching,
logging and error-report behaviour has to be reasoned about case by case.

### 2.2 Mood at writing is not an observation

It is a column on `journal_entry`, and the reason is arithmetic. `mind.mood`
aggregates as `mean`; if a journal entry wrote one, "mood on 12 August" would
depend on **how many times the operator journaled that day** — three entries on
a rough evening would drag the day's figure toward the rough evening.

The Close's mood is one deliberate daily judgement and stays the only thing that
answers that question. The mood-at-writing stays where it is useful: next to the
words it accompanied.

### 2.3 The crisis plan does not appear when there is no plan

§4.7 requires the plan to be "entered by them when well". So when a run of severe
days is detected and no plan exists, **nothing is surfaced**.

The obvious alternative — "you seem to be having a hard week, would you like to
write a crisis plan?" — asks someone to do calm, careful, anticipatory work at
the exact moment they are least able to, and converts a bad week into a bad week
plus a form. `shouldInvitePlanning` is the mirror image: it returns true only
when the run is zero, so the invitation lands on a settled day.

**A gap is silence, not an answer.** An unrecorded day neither breaks nor extends
the run. Treating a gap as "fine" is how a system misses the fortnight somebody
stopped opening it.

## 3. What is where

| File | Owns |
|---|---|
| `core/domain/mind/scales.ts` | The 1–5 scales, their labels, the tone mapping, `describeMovement` |
| `core/domain/mind/episode.ts` | Anxiety episodes, severity bands, the trigger tally |
| `core/domain/mind/journal.ts` | Entry validation, consent, the list item, prompt rotation |
| `core/domain/mind/practice.ts` | Practice sessions and the before/after delta |
| `core/domain/mind/crisis.ts` | The stored plan, the run evaluation, the surface |
| `core/domain/medication/adherence.ts` | The register, adherence, chart annotations |
| `db/repositories/mind.repository.ts` | Persistence, and the list query that omits prose |
| `web/features/mind/` | Five screens and the crisis card |

## 4. Medication is Health's, and Mind reads it

§4.7: "Medication data lives in Health; Mind reads it." So the domain module is
`core/domain/medication/`, the route is `/api/medications`, and `/mind/meds` is
`?lens=psychiatric` over the same rows — §3.3(3)'s "one row, three lenses" made
literal by a query parameter rather than by a second table. When Health core
ships in V2, `/mind/meds` does not change.

### The adherence rule, restated because it is easy to get wrong

From the metric registry:

> "A day with no record is not counted as a missed dose — absence of data is not
> evidence of non-adherence, and conflating them makes every figure quietly
> wrong."

`windowAdherence` reports **three** quantities — days recorded, doses taken,
doses expected on recorded days — and assembles the sentence itself so no surface
can present the ratio without the unrecorded count beside it. A psychiatrist
asking "have you been taking it?" is asking a clinical question, and a figure
that silently counted un-logged days as misses would answer it wrongly in the
direction that changes prescribing.

## 5. Medication changes are on every chart

§4.7: "Medication changes are annotated on every chart in the system. A mood
trend without a 'started Escitalopram' marker is a misleading chart."

`medicationAnnotations` turns the register into markers — starts, stops, and dose
changes, where a dose change is the second and subsequent schedule whose dose or
frequency differs from its predecessor's. Doses are compared as decimals, so `10`
and `10.0` do not produce a phantom marker.

`loadMindOverview` returns them whether or not the caller asks, which is the
enforcement: a new chart cannot ship without them by forgetting.

**The chart layer changed to make this legible.** `TrendChart` previously drew an
annotation as an unlabelled dashed rule, which satisfies §8.9(2) literally and
communicates nothing. It now draws a numbered flag and lists the labels beneath
the plot, where they can wrap at 360px instead of overlapping each other.

## 6. What is deliberately not built

- **Therapy sessions** (`/mind/therapy`). §3.2 marks it V2.
- **Editing a journal entry.** The repository upserts — adding a paragraph to
  yesterday's entry is a normal thing to do — but the edit surface is not built.
  Shipping the read-only view is the honest half to ship first.
- **A crisis plan editor.** The table exists and the surface renders it; entering
  one is a settings-screen job and settings are not in this milestone. Rows are
  inserted directly for now.
- **Any averaging of the practice before/after delta.** An average delta over a
  fortnight would be the first inferential claim in Mind, and §2.1 keeps every
  non-adherence insight out of the MVP.
