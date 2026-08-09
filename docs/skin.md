# Skin

**Status:** state, routine, products and the capture protocol implemented, Week 4.
Encrypted photo upload **not** implemented — see §5.
**Blueprint sections:** §4.2, §9.2, §9.8, §14.2 · **Related:** [media.md](media.md) · [insights.md](insights.md)

---

## 1. The photography protocol is the module

§4.2 does not hedge:

> "Photographs taken under inconsistent lighting, distance, angle, or time of day
> are not merely lower quality — they are *actively misleading*, because apparent
> change is dominated by capture variance rather than skin change."

A year of face photos taken at whatever hour under whatever light does not show
whether skin improved. It shows the weather.

### Advisory, always. Never blocking.

§14.2's ninth finding is the governing constraint:

> "A luminance-based lighting check will produce false warnings, and a warning
> that is wrong even twenty percent of the time is a warning that gets ignored
> within a fortnight, taking the credible warnings with it. *Fixed:* §4.2 and
> §9.8 now make protocol checks **advisory and recorded, never blocking**."

`evaluateProtocol` therefore returns a plain value. No `Result`, no error path,
nothing a caller could turn into a refusal — the worst outcome available to the
function is a low score and a list of advisories.

Three consequences visible in the UI: the advisory dot is amber rather than red;
no message is phrased as an instruction ("this one is warm artificial", never
"retake"); and the first photo in a series scores `null` rather than 0%, because
there was nothing to be consistent *with*.

### The overlay is the mechanism, not the score

§14.2 again: "The ghost overlay is the primary mechanism, because it actually
works — it makes the correct behaviour easier than the incorrect one, which is
the only reliable form of enforcement."

So `GhostOverlay` is a component with almost nothing in it: the previous photo in
the series at 35% opacity, desaturated. Grayscale so the operator aligns *edges*
rather than comparing colour — a full-colour ghost invites a judgement about
whether today looks better, which is the comparison view's job and is exactly the
judgement capture variance corrupts. The opacity is not adjustable, because a
slider is a setting nobody adjusts and everybody has to think about, in a flow
that has ten seconds before it stops happening daily.

### The weights, and why luminance is not the heaviest

| Check | Weight | Why |
|---|---|---|
| Distance (`framing`) | 3 | A face at arm's length under a window looks like different skin from the same face at half a metre under a ceiling light |
| Lighting condition | 3 | Colour temperature dominates apparent redness |
| Time of day | 2 | Correlated with light and with the skin's own diurnal state |
| Flash | 2 | Specular highlight reads as oiliness |
| Median luminance | 2 | Finding 9 says it will produce false warnings, so it gets a vote rather than a veto |
| Alignment reference | 1 | Lowest not because it matters least, but because the overlay already enforces it far better than a score can |

Luminance uses the **median** of the trailing baseline, not the mean: one photo
taken with a lamp on would drag a mean far enough to make every subsequent photo
look non-compliant — Finding 9's failure mode arriving through the statistic
rather than the threshold.

## 2. One row per day, and re-logging edits it

`skin_state` carries a unique index on `observed_on`, so a day has one row for
its whole life. The operator revises it — logs in the morning, counts lesions
properly that evening — so the write is an upsert on the day.

The observations follow the same rule from the other direction. §9.1 makes the
log append-only, so `planSkinState` takes the day's current observations and
emits `supersedes` for each. Without that, correcting a 2 to a 4 would leave
`mean` aggregation reporting **3** — a number the operator never entered and
cannot see the source of.

That is why `logSkinDay` reads before it writes: it needs the stored row id (or
the day sprouts orphaned region rows) and the stored observation ids (or the two
readings both stay current). The client sends ids anyway — §5.7 wants a record to
have its identity from the moment it exists offline — and they are used when the
day is new. When it is not, the stored ids win, because the offline device cannot
know which of its days the server has already seen.

## 3. Three regions, and lesions separate from scars

§4.2 tracks face, chest and back separately, and the schema comment says why: "an
aggregate score hides a chest flare during a good face week." The overview chart
therefore draws three lines rather than the overall score.

Lesions and scars are different numbers by §4.2's requirement of "scar tracking
as distinct from active lesions". Summing them would produce a figure that
improves when inflammation settles and worsens when it leaves a mark — two
unrelated processes fighting over one axis.

## 4. The payoff question, answered honestly

§4.2's payoff question is "my chest acne worsened three weeks after starting that
moisturiser". `changesBefore` answers it with a **list of what changed** in the
window before a flare, with a `daysBefore` on each and nothing resembling a
score, a rank, or the word "cause".

That restraint is the whole point. A suspected-trigger ranking over n=1 with a
fortnight of lag would be wrong far more often than the twenty percent Finding 9
says destroys a warning's credibility. A list of what changed is something the
operator can reason about; a ranked list of suspects is something they would
either believe or stop reading.

Product state is **replayed from events**, never read from the cached column: a
product introduced, dropped and reintroduced has three events and one row, and
only the replay gets the current period right. `refreshActiveProducts` recomputes
the `is_active` cache from the replay, and an integration test asserts the two
agree.

## 5. What is not built, stated plainly

**The encrypted photo upload.** The capture protocol ships — overlay, region and
pose selection, the protocol block, the luminance measurement, the scoring. The
upload does not.

`core/media/pipeline.ts` and the sensitive-tier storage path have existed since
week 2 and are wired end to end for documents. Wiring a *browser* capture through
client-side encryption needs a key-derivation flow — a passphrase, a wrapped
master key, somewhere to keep it — that §5.5 specifies and that week 4 could not
fit alongside two whole domains and the detector battery.

The ordering matches §14.4's recorded fallback:

> "if week 4 slips, skin *photography* defers to v0.2 while skin *state* ships.
> Deferring photos is acceptable; deferring encryption is not."

So **nothing is stored**. There is no half-encrypted path to retrofit, and the
capture screen says so on its face rather than leaving it to be discovered in
month three.

Also not built, and smaller:

- **Product authoring and product events.** The register renders, with reaction
  history and "started 9 days ago". Adding a product is a form; rows are inserted
  directly for now.
- **Routine definition.** Adherence is computed and rendered; defining a routine
  is not built. Same reason, same fix.
- **Treatment courses** (`/body/skin/treatments`). The isotretinoin history has a
  table and no surface.
- **The comparison view** (`/body/skin/photos/compare`), which needs photos.

## 6. The routine engine is not Skin's

§9.2: "A generic routine engine reused by skincare, dental hygiene, and
supplements. One implementation, three consumers — the alternative is three
near-identical adherence systems."

The domain module is `core/domain/routine/`, the route is `/api/routines?kind=`,
and only the *screen* lives under `features/skin`. Three decisions in it:

- **Optional steps are excluded from both sides of the ratio.** A routine with
  eight steps of which three are nice-to-have is a five-step routine for
  adherence, and including the optional three would make a perfect night 62%.
- **A `partial` step counts as completed.** The question is "did the routine
  happen", and a step done imperfectly happened. Half credit would invent a
  precision the record does not have.
- **A day with no log is not a missed routine, but it *does* end a streak.** The
  ratio refuses to guess; the streak refuses to flatter. Letting silence pass
  through a streak would leave a fortnight of not opening the app showing a
  "17-day streak", which is the kind of flattering nonsense that makes a number
  worthless.

Tapping a step cycles done → skipped → cleared. Three states, because "cleared"
is not "skipped": one says the step did not happen, the other says nothing was
recorded, and every adherence figure in the system depends on the difference.
