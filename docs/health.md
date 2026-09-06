# Health core

**Status:** shipped, 10 August 2026 (§12's October block, built early — see
[validation.md](validation.md) for where the roadmap stands). ·
**Blueprint sections:** §4.4, §9.2, §9.5, §9.9, P5
**Related:** [documents.md](documents.md) · [insights.md](insights.md)

---

## 1. What this module is for

> *What is my clinical state, what am I taking, and what has actually happened
> to me?* — §4.4

Five things: vitals, labs, conditions, symptoms, appointments. Plus the one that
makes them worth having — the pre-visit question list, which is where P5's
promise is either kept or quietly dropped:

> "The deliverable of a medical insight is *a better question for your next
> appointment*, printed and ready."

## 2. The two clocks, and why the conditions screen looks like that

§4.4 is unusually direct:

> "Learning in October that a condition began in March must not rewrite history
> — the March onset is recorded, and the fact that you did not know until
> October is also recorded. Any other design produces a record that quietly lies
> to a clinician."

So a condition carries `validFrom` (when it began) and `recordedFrom` (when the
record started being believed), and the screen renders **both**: *"Began March
2026. Recorded October 2026."*

Three consequences that fall out of that and are easy to undo by accident:

- **The onset field never defaults to today.** A default of today is how every
  backfilled diagnosis ends up claiming it started the afternoon somebody typed
  it in.
- **A status change is a new row.** `reviseCondition` closes the predecessor's
  `recordedTo` and inserts a successor with the same `validFrom`. Two rows for
  one diagnosis is the point: it is what makes *"what did my file say in
  March?"* answerable after the diagnosis was corrected in October.
- **`refuted` is a status, not a deletion** (§9.4). A wrong diagnosis is
  clinically relevant history — it explains why a medication is in the register.
  The screen says so in a sentence, because a person scanning their own record
  otherwise wonders why something they were told was wrong is still there.

## 3. Reference ranges are stored, never looked up

§9.2:

> "Reference ranges are stored per result, not looked up — ranges vary by
> laboratory and change over time, and a 2027 result compared against a 2035
> range is a clinical error."

There is therefore **no table of canonical ranges anywhere in this codebase**,
and there never will be. Every `lab_result` row carries the range exactly as its
own report printed it.

Three things follow.

**The printed flag beats any recomputation.** `effectiveFlag` returns the
laboratory's flag when there is one. When there is not, it computes one from the
printed bounds and marks it `derived` — and the screens render that word.
A laboratory flags against rules this system does not have (sex, age, fasting
state, assay method), and a derived *normal* sitting beside a printed one in the
same styling is a small lie told confidently.

**The trend chart draws no reference band.** It was designed and dropped. A
shaded band implies one range across the whole series, which is exactly what
§9.2 says does not exist. Instead each point carries its own printed range in
the table beneath the chart.

**A range shift is stated out loud.** `rangeShifts` returns the distinct printed
ranges in the order they appear, and returns an empty array when they never
changed. Ferritin at 42 against 30–400 in March and 42 against 20–250 in October
is a laboratory changing its assay, not a person changing — and on a chart with
a moving band, nobody notices which one moved.

## 4. Units: where a lab pipeline actually breaks

An Indian laboratory prints 25-OH-D in ng/mL; a European one prints nmol/L. 30
ng/mL and 75 nmol/L are the **same level**. Plotted on one axis without
conversion they draw a spectacular deficiency correction that never happened.

`toCanonical` is the single point where that is prevented, and it refuses rather
than guesses in three cases: an unregistered unit, a dimension with no
conversion (no registered molar mass for the analyte), and a value outside the
analyte's plausible bounds.

Two additions to the unit registry were needed and are worth knowing about:

| Dimension | Members | Why it is shaped that way |
|---|---|---|
| `rate` | `bpm` only | Heart rate and respiratory rate are both counts per minute, and `convertQuantity` converts freely *inside* a dimension. Sixty beats becoming sixty breaths is a fabricated vital sign, so a second rate unit needs its own dimension and a deliberate decision. |
| `iu_concentration` | `µIU/mL`, `mIU/L` | IU are substance-specific and never convert to mass. These two are the same quantity under two names (1 µIU/mL = 1 mIU/L), which is the exact confusion the dimension absorbs — two labs reporting one TSH in what looks like two units. |

## 5. An uncatalogued analyte is stored and has no trend

The catalogue knows fifteen analytes; a full-body panel prints thirty lines.

Every confirmed result gets a `lab_result` row — the record is the record. Only
*catalogued* analytes get an observation, because an observation needs a metric,
a metric needs a unit and an aggregation, and inventing those from a PDF is the
move P5 forbids.

The consequence is **reported, not silent**: `recordPanel` returns
`withoutTrend` with a reason per result, and the confirmation screen says
"recorded, but this will not appear on a chart". A value the operator believes
is being tracked and is not is worse than one they know is only on the report.

Adding an analyte is six lines in `domain/health/analyte.ts` — **and a re-seed**,
because the metric registry is what validates on write and it lives in Postgres.
That caught a real failure during development: TSH's unit changed in the
catalogue and the write kept failing until `pnpm --filter @naitikos/db seed` ran.

## 6. Vitals

Plain observations, no table — §9.2 only makes something an entity when it has
internal structure, and a vital sign is a number at a moment.

That creates exactly one problem, and it is the whole of `vitals.ts`: a blood
pressure is **two metrics and one measurement**. Both observations share
`subject = { type: 'vital_reading', id }`, so the pair reassembles with a
group-by and nothing new in the schema. Six weeks later, *"was that 118 taken
with the 76 or with the 92?"* has an answer.

Two rejections happen before anything is written:

- **A systolic with no diastolic.** A keyboard slip. Admitting it writes a number
  that plots forever with no partner and no way to tell it from a real one.
- **A diastolic at or above its systolic.** Arithmetic, not clinical judgement —
  the pressure between beats cannot exceed the pressure during one, so the pair
  is transposed.

**Nothing classifies a blood pressure.** No colour, no badge, no category.
Guideline thresholds differ between bodies and assume measurement conditions
this system does not capture. A number and its trend is a question for an
appointment; "elevated" on a phone screen is an answer nobody here is entitled
to.

## 7. The question list

`deriveQuestions` is pure, deterministic, and takes five pre-fetched lists. No
model, no ranking model, no learning. The same inputs produce the same list, and
each question's id is derived from its source row — so re-deriving after a new
lab result does not duplicate what is already there, and a deleted question
stays deleted.

**Every line is a question.** `"Should I increase my dose?"` is a treatment
proposal wearing a disguise. `"This was 14.2 ng/mL on 12 September, below the
printed range of 30 – 100 ng/mL — what should be done about it?"` is a fact and
an open question. Each is built from a template that states an observation and
then asks, so the property is structural rather than a matter of care.

**Ordering is by what is hardest to raise later**, not by how interesting the
finding is:

| Rank | Source | Why there |
|---|---|---|
| 0 | Critical lab value | Worth reading today, not at the next visit |
| 1 | Side effect never mentioned to a prescriber | The single most common thing a person means to raise and does not |
| 2 | Out-of-range lab value | The reason most people book the appointment |
| 3 | Medication adherence | A fact about the denominator, not a failure |
| 4 | A diagnosis suspected for 90 days | It will keep until this visit, but not indefinitely |
| 5 | A recurring symptom | Still there next month |

**The list is capped at eight**, and what was cut is stated. A list of thirty
questions is one that gets folded into a pocket and not read.

**Adherence is counted, never scolded.** The evidence line says *"days with no
record are counted as unknown, not as missed — the real figure is this or
better"*, because `windowAdherence` computes the denominator over recorded days
only (§4.7).

## 8. What is not built

Named rather than half-wired, because a stub that returns nothing looks exactly
like a feature that found nothing.

| Not built | Why, and what it costs |
|---|---|
| The Consultation Pack | §12 puts it in December. The question list is its input and exists; the printable pack does not. |
| The medical timeline (`/timeline/medical`) | Every write here goes through `medical_event`, so the query is a filter on one table. The route is absent under §3.3 R6 rather than empty. |
| Treatment courses, procedures | Tables exist and are populated by nothing. Isotretinoin and the root canals are the operator's real history and both belong here; neither is on §12's October list. |
| Editing a lab result | §9.1 makes corrections supersessions, and the supersession UI does not exist for labs. A wrong value is currently corrected by re-confirming — which appends. This is the sharpest remaining edge. |
| Symptom ↔ medication correlation | December, and behind §10.6's five statistical controls. Not a UI gap. |

## 9. The medication detail page

`/body/health/medications/:id`, §3.2's "detail + adherence + side effects".
Added 6 September 2026.

### The dose history is why it exists

The register shows the current dose. It cannot show how the operator got there,
and for a psychiatric medication that is most of the clinically interesting
information: 37.5 mg for a fortnight, then 75, then 150 is a titration, and it
reads completely differently from a single jump. A prescriber asks about it.

The schema already held this. §9.5 makes a dose change a **new
`medication_schedule` row with its own validity interval**, never an update of
the old one, and `0002_medication_schedule_exclusion` adds a database constraint
forbidding two overlapping believed schedules. So the history is read, not
reconstructed — and this page is the only surface in the system where that
design is visible, which is a fair argument that it should have existed sooner.

There is no inline "change dose" field, for the same reason. It would be the one
place in the product where the temptation to `UPDATE` a believed row appeared,
and the dose history is exactly what that update would erase.

### The order of the sections is an argument

Dose history above adherence. Adherence is the figure a person comes for and the
figure most likely to be read as a verdict; putting the titration above it
frames the quarter as *what was being taken*, so a run of skipped days beside a
dose increase reads as a fact about the increase rather than about the person.

### Ninety days, not the register's thirty

Thirty answers *am I taking it*. This is the page opened before an appointment,
and a quarter is the interval those run at. It is also long enough to contain a
dose change, which is what makes the two halves of the page relate to each other
rather than sit side by side.

### The side effects are labelled as suspicions in the heading

"Side effects you suspected of this" — not a footnote, because a list of effects
under a medication's name *looks* like an attribution whatever the data means.
The column is `suspectedMedicationId` and §9.2 fixes what it means: "linked but
never asserted as causal by the system." The specific reason it matters here is
in `domain/health/side-effect.ts`: an SNRI, an SSRI and isotretinoin share a
long list of overlapping documented effects, so a system that picked one would
be guessing with a confident interface.

Effects logged with no suspected cause do not appear. An effect with no
attribution is not evidence about this one.

### One adherence calculation, still

`windowAdherence`, in `core` — the same function the Consultation Pack and both
register lenses call. §4.4's claim that Health holds the register "consumed by
Mind, Skin, and adherence detection across the system" only stays true while
there is one calculation, and the part that would silently drift if copied is
the rule that a day with no record is not a missed dose.

A schedule with no daily denominator — `as_needed`, or anything less frequent
than daily — says so on its own row rather than leaving a blank ratio to be
inferred. `expectedDosesPerDay` refuses on purpose: a weekly medication forced
into a daily denominator reports 0 of 1 on six days in seven for a perfectly
adherent operator.

## The medical timeline

`/timeline/medical`. §9.2's payoff, collected: every clinical write inserts a
`medical_event` alongside its subtype row, so this is "a query over one table
rather than a ten-way union that has to be edited every time a clinical domain
is added". A tenth clinical domain appears here without a line changing.

Rendered clinically rather than chronologically flat, per §10.7 — intervals
above events. A condition active for four years and a lab drawn on one morning
are not the same kind of fact, and a list sorted by date loses exactly the
duration that makes the page useful to a clinician. An open interval reads
"since March", never "March to today", which would assert an end nobody recorded.

**The date control is the point of the page.** §9.5's bitemporality exists so
the record can answer what your file said in March after a correction in
October, and §4.4 says a record that cannot is one that "quietly lies to a
clinician". That query is a date field here rather than an export flag, because
the moment it matters is a consultation where someone asks what you were told at
the time.

A past view states how many entries it is *hiding* relative to today. A
reconstruction that silently contained less would read as data loss rather than
as history.

Where the two axes disagree — a condition that began in January and was recorded
in June — the card says both. A timeline showing one of them is the record a
clinician cannot reconcile with their own notes.

## The Consultation Pack

Added December 2026. §10.7, and V2's stated highest-value deliverable —
December's gate is "at least one Consultation Pack taken to an actual
appointment".

**It lives at `/timeline/medical/pack`.** It shipped at `/body/health/pack`,
which was wrong: §3.2 puts it under the medical timeline and §10.7 introduces it
as that timeline's payoff rather than as a Health screen. The old path
permanently redirects rather than 404ing — it may sit in a browser history, and
a dead link on the morning of a consultation is the worst possible time to
discover a route moved.

### It is deterministic, and that is the design

§10.11 routes "Consultation Pack synthesis" to Opus at `xhigh`, and what that
call contributes is the *phrasing* of the questions and the connective prose.
Every fact on the page — every medication, every lab value, every date — is
assembled by `lib/platform/consultation-pack.ts` from the record, because §10.0
puts the model outside the path of any number a person reads.

The consequence is that the pack works with no model, no API key and no budget
remaining. That is not a degraded mode. A document taken into a consultation
must not depend on a third party being up, and a pack that produced nothing on
the one morning it mattered would be worse than not having one.

### Filter what leads, never what is included

A pack containing everything would be forty pages and read in none of the ten
minutes available. A pack that filtered hard would omit the interaction the
clinician needed.

The rule: **everything in the window is in the pack; relevance decides the
order.** Anything judged irrelevant is demoted to an "also on record" block
rather than dropped. The cost of burying a record is a clinician reading one
more line; the cost of omitting it is a drug interaction nobody mentioned.
Those are not comparable, so the design does not trade between them.

`SPECIALTY_WORDS` is a hand-written keyword list — the same technique the Teeth
module uses — with the same honest limitation: it will miss things. That is
*why* nothing is dropped. A classifier that removed records would need to be
right; one that only reorders needs to be useful.

Two overrides on top of the keyword match:

- **An out-of-range lab leads regardless of specialty.** A flagged value is the
  one thing on the page a clinician of any discipline wants to see, and burying
  it behind a word list that did not happen to contain the analyte's name would
  be the filter causing the harm it exists to avoid.
- **A stopped medication does not lead**, whatever it matches. §10.7's section
  is "current medications"; a drug stopped two years ago belongs in the pack —
  a prescriber needs to know it was tried — but not at the top of the page.

### The adherence wording is load-bearing

`adherenceNote` produces "52 of 62 scheduled doses were logged (84%). An
unlogged day may be a dose taken and not recorded."

"84% adherence" would be a claim about behaviour. This is a claim about
logging, and a prescriber will hear the first unless it is said the second way.
§4.7's rule that an unlogged day is not a missed dose matters most here,
because this is the one surface where the reader can act on it.

An as-needed medication gets no figure at all, and a window with nothing
scheduled says so rather than reporting 0%. 0/0 is not 0%, and a denominator
invented to avoid a blank would be the system reporting non-adherence it never
observed.

### The limitation is printed

`PACK_LIMITATION` is the first thing under the heading, on paper and on screen.
A document that looked like a medical record without saying it was
self-recorded would be presenting itself as something it is not — to someone
with thirty seconds to decide how much to trust it. It also states that
adherence counts *logged* doses, and that a derived lab flag was computed from
the printed range rather than printed by the laboratory.

### One question list, not two

The pack calls `deriveQuestions` — the same function `/body/health/appointments/[id]`
uses, with the same inputs. Two implementations of "what should I ask" would be
two things to keep in step, and the one that got stale would be the one printed
and carried into the room.

Editing happens on the appointment screen, which owns the saved list. The pack
has no editor for the same reason.

### Print

`components.css` carries the print rules. Controls are `.nos-no-print`;
sections avoid page breaks; the text drops to black ink. Nothing in the pack
conveys meaning through background colour, so `print-color-adjust` is
deliberately not forced — a pack that needed colour would fail §8.13 on paper
as surely as on screen.
