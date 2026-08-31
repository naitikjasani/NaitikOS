# Reviews

**Status:** shipped, 31 August 2026 (§12's V3 block). Weekly, monthly, quarterly
and annual — one drafting engine, four period shapes.
· **Blueprint sections:** §4.12, §10.0, §10.7, §9.3, §5.4, §8.3
**Related:** [work.md](work.md) · [goals.md](goals.md) ·
[insights.md](insights.md) · [observations.md](observations.md)

---

## 1. The draft is deterministic, and works with no model

§4.12 describes the feature in one line:

> Model-drafted from the record, human-edited.

Read carefully, that is two claims and only the second one involves a person.
"From the record" is the load-bearing half, and §10.0 settles what it means:

> The model never computes, discovers, or asserts.

So `assembleDraft` is an ordinary function in `@naitikos/core`. It takes
`ReviewInputs` — counts and means gathered from repositories — and returns
sections of prose built from them. It makes no network call. There is no API
key on the path, no budget check, no retry, and nothing to be down. Given the
same inputs it returns the same bytes, and its tests assert exactly that.

This is the same decision the [Consultation Pack](health.md) already records,
for the same reason. A document that only exists when a third party is up is a
document you cannot plan around, and the one morning it produced nothing would
be the morning it mattered. A review skipped because the drafting service was
returning 503s is a review not done, and §4.12's whole premise is that the
review happens.

The consequence worth stating plainly, because both the page and this file say
it: **every figure in a draft came from a query.** Nine days closed means nine
rows. A mean mood of 6.4 is the arithmetic mean of the `mind.mood` observations
inside the period's zoned bounds. Nothing in the draft is a paraphrase of a
number, an approximation of one, or a number no query produced.

A model may later be asked to improve the *phrasing* of the connective prose —
§10.11 budgets for that, exactly as it does for the pack. It will never be asked
for the figures.

## 2. The coverage line leads, and that is the whole design

Every draft opens with coverage: how many of the period's days had a Daily
Close, how many observations the period holds, and which sections had no data at
all.

It leads rather than trailing because of what a review *is*. The document is a
summary of a period, and a summary of a period with four days of data in it is a
summary of four days wearing a week's label. A reader who sees "6.4 mean mood"
at the top and the sample size at the bottom has already formed the belief the
sample size was supposed to qualify.

This is §10.9's "insufficient data" rule applied to a document instead of a
chart, and it is the same argument the insight detail page makes when it puts
the limitation above the effect size. Order is not cosmetic on a page whose
figures will be believed.

A section with no data says so in a sentence and prints no figure. It is never
rendered as a zero: "no gym sessions logged" and "zero gym sessions" are
different claims, and only the first one is checkable.

## 3. Unedited is not complete, enforced in three places

§4.12, and this is the sentence the feature is built around:

> The draft is the labour-saving part; the editing is the value. A review the
> user did not edit is a review they did not do, and the system should treat an
> unedited draft as incomplete rather than as a completed review.

The failure mode being designed against is specific and unglamorous: a person
presses "draft", skims it, presses "complete", and now has a row that looks
identical to a review they actually thought about. Six months later the archive
contains twenty-six of those and cannot distinguish them from the four that were
real. The record is worse than if the feature had never shipped, because it now
holds a confident-looking history of reflection that did not happen.

So the rule is enforced three times, deliberately:

| Where | What it refuses |
|---|---|
| `contracts/reviews.ts` | The wire has no `complete` without an `editedContent`. The `edit` kind requires a non-empty body; the `draft` kind cannot set a state at all. |
| `core` — `isReviewComplete` | Refuses an empty body, and refuses one byte-identical to the draft. The domain owns the judgement, not the transport (§5.0). |
| `review_complete_requires_edit` | A database `CHECK`: `state <> 'complete' OR edited_content IS NOT NULL`. |

Three enforcement points for one rule reads like duplication until you ask what
a single one would leave open. A contract alone is bypassed by the next caller —
a script, a migration, a repository method written in a hurry. A `CHECK` alone
catches the null and misses the case that matters more: text pasted straight
back from the draft, non-null and unedited. Only `core` can see that, because
only `core` has both strings.

And the UI says so out loud. **Mark complete** is disabled while the edited text
is empty or byte-identical to the draft, with the reason printed next to the
button rather than left for the operator to infer from a greyed control. A
disabled button with no explanation is a bug report waiting to be filed; a
disabled button with §4.12's sentence under it is the system explaining its own
standard.

## 4. A re-draft never clobbers an edit

`upsertDraft` writes `draft_content`. It does not touch `edited_content`, and
does not touch `state`.

The situation is ordinary: a review is drafted on Sunday, half-edited, and left.
On Wednesday three more days of the period get backfilled and the operator asks
for a fresh draft. If re-drafting overwrote the edit, that click would silently
destroy the only part of the document that had any value — the human half, which
by §4.12 *is* the review — in exchange for regenerating the half that is free to
regenerate.

So the two columns are genuinely separate storage, and the asymmetry is the
point:

- `draft_content` is derived. It can be rebuilt from the record at any time, and
  overwriting it loses nothing.
- `edited_content` is not derived from anything. Nothing can reconstruct it. It
  is the only irreplaceable text in the table.

A re-drafted review with an existing edit shows both, side by side, and lets the
operator decide what to carry across. The system does not merge them. A merge
would need a rule for which sentence wins, that rule would be invented, and the
casualty would be the operator's own writing.

## 5. Periods are ISO weeks, and calendar months, quarters and years

`periodContaining(kind, dayKey)` is the only thing that computes a boundary, and
every caller goes through it. The boundaries:

| Kind | Runs |
|---|---|
| `weekly` | Monday to Sunday — ISO 8601 week. |
| `monthly` | The 1st to the last day of the calendar month. |
| `quarterly` | Jan–Mar, Apr–Jun, Jul–Sep, Oct–Dec. |
| `annual` | 1 January to 31 December. |

ISO weeks rather than "the last seven days" for the reason the whole pillar
exists: reviews are compared with each other. A trailing seven-day window drafted
on a Tuesday and again on a Friday produces two overlapping "weeks" whose figures
cannot be laid beside each other, and a `review_period_unique` index on
`(kind, period_start)` would be meaningless because no two starts would ever
collide. Fixed boundaries mean week 34 is the same seven days whoever asks and
whenever, which is what makes a run of them a series.

Monday rather than Sunday because ISO 8601 says so and because every other day
key in this system already resolves through `dayKeyInZone`. A second week
convention would be a second thing to reconcile, forever, for no gain.

The boundaries are drawn in the operator's zone, not in UTC. A week that ended at
05:30 local on Monday because someone chose the cheaper `toISOString()` would put
Sunday evening's observations into the following week — and Sunday evening is
when a weekly review is actually written.

**A period that has not closed cannot be drafted.** `isPeriodClosed` gates the
button, and the disabled state carries its reason: a review of a period that has
not ended is a review of a partial record. This is the same refusal §2 makes
about coverage, moved one step earlier — better to withhold the document than to
produce one whose figures are structurally short and whose label does not say so.

## 6. Prompts are questions, never conclusions

Every draft ends with prompts, and every one of them is interrogative.

`REVIEW_PROMPTS` holds sentences like *"Mood averaged 6.4 across 12 observations.
Does that match how the fortnight felt?"* — a figure the record vouches for,
followed by a question only the operator can answer. What it never holds is
*"your mood was low because work was heavy"*, and the prohibition is not stylistic.

§4.7 forbids exactly that sentence. §10.6 puts any claim stronger than adjacency
behind five controls, and none of them is satisfied by two figures appearing in
the same document. A review is the single place in this system most likely to
manufacture a false causal story, because it lays a dozen unrelated series side
by side in prose, in a document written to be reflective — the precise conditions
under which a confident-sounding sentence gets believed and then repeated.

So the draft juxtaposes, and asks. It does not explain. What connects a heavy
week to a bad night is the operator's own knowledge of what happened, and the
value of the review is that they write it down — which is the same reason §3
refuses to let an unedited draft count.

The prompts also select for what is *absent*. A period with no gym sessions gets
a prompt about that; a period with an unusually large number of dropped tasks
gets one about that. Selection is deterministic — a rule over the inputs, checked
in tests — not a ranking, and not a judgement about which absence matters more.

## 7. What is not built

| Not built | Why |
|---|---|
| Automatic drafting on a schedule | A review generated on a cron at 06:00 Monday is a notification, and §1.4 counts notifications as a cost. The draft is cheap and instant; the operator asks for it when they sit down to do the work. |
| Model-improved phrasing | §10.11 budgets for it and §1 explains why it would only ever touch connective prose. Nothing needs it yet, and the version with no model is the version that always works. |
| Review-to-review comparison | Two consecutive weeks in one document is a chart, and putting a delta in prose ("mood up 0.4") is one sentence away from explaining the delta. It belongs in [charts.md](charts.md), under §10.6's controls. |
| A completion streak | A streak turns a reflective practice into a scoring one, and the first missed week converts the whole feature into a source of guilt. §4.12 wants the review done, not the counter kept. |
