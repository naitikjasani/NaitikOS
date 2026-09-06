# Appearance

**Status:** complete against §2.3's "Appearance — the aggregate lens over skin,
physique, grooming, and hair", shipped 6 September 2026. Two of the four
elements have data; the other two are named rather than omitted.
· **Blueprint sections:** §2.3, §3.3, §4.2, §4.6, §8.9, §10.0
**Related:** [skin.md](skin.md) · [observations.md](observations.md)

---

## 1. There is no appearance score, and there will not be one

This is the only decision on this page that really matters, so it goes first.

A page called Appearance is the surface in this system most likely to become a
self-esteem scoreboard. A composite figure over skin state, weight trend and
photo-protocol compliance would be trivial to compute, would look authoritative,
and would be **a value judgement about a person's body dressed as a
measurement** — with weights nobody could justify, changing daily, for a
quantity that does not exist.

§10.0 forbids the model asserting. The same reasoning applies with *more* force
to the application, because a deterministic score is more convincing than a
model's and no more entitled to be believed.

So the page lays two figures next to each other and says nothing about how they
combine. It says that, too, in as many words, because a reader who has used any
other health app will be looking for the number and should find out immediately
that there isn't one.

## 2. The lens owns no data — that is the whole test

P3 is the claim this page exists to prove:

> There is no "gym database" and no "skin database." There is one observation
> log and one entity graph. *Gym* and *Skin* are queries with a UI attached.

Appearance is the purest test of that in the system, because it is a pillar in
the navigation with **no table, no repository, and no metric of its own.**

`loadAppearance` calls `loadSkinOverview` rather than querying. That is not
laziness: it is what guarantees this page and `/body/skin` cannot disagree about
what the last ninety days looked like. A second query here would be a second
definition of *how is the skin*, and the two would diverge the first time one
was changed.

If a figure ever appears on this page that is computed here, the lens has become
a sixth pillar with a private opinion, and the divergence is a matter of time.

### The physique card is a door, not a figure

§4.6 makes the honest bodyweight number the seven-day moving average, not the
raw reading. Reproducing a headline weight on this page would mean a second
place deciding which number to lead with — exactly the drift a lens exists to
avoid. So the card explains what lives on `/body/composition` and links to it.

That looks like an omission and is a deliberate one.

## 3. One window for everything

Ninety days, for both elements, and the same number for both is the point.

An aggregate lens showing skin over a fortnight beside weight over a year would
invite a comparison between two windows. §4.7's prohibition on asserting a cause
is defeated by an axis mismatch as easily as by a sentence — two lines that
appear to move together because one is compressed is a claim, made silently.

## 4. Grooming and hair are named, not hidden

§2.3 lists four elements. Two have schema, capture protocols and a year of
design behind them. Grooming and hair have nothing: no table, no metric, no
capture path.

§3.3 R6 would ordinarily say a module with nothing behind it should be absent:

> `[V2]` and `[V3]` routes do not exist in the shipped MVP. Not hidden, not
> disabled, not greyed out — **absent**. A visible-but-empty module teaches the
> user that the system is a graveyard.

That rule is about **routes**, and it is why `/body/appearance` did not exist
until it had something to show. It does not extend to a lens naming what it does
not cover — the opposite. A page called Appearance silently showing two of four
things would imply the record was empty for the other two *because nothing had
happened*, which is §8.9's failure applied to a whole domain.

And it matters more here than anywhere else in the product. This is the one page
where a person could read a gap in the system as a gap in themselves. The
absences are therefore written as sentences about what the system would need,
not as "not built":

- **Grooming** would need a routine of its own, in the way skincare has one, and
  nothing has yet made the case that a haircut interval belongs in a
  longitudinal health record.
- **Hair** would need standardised photography under the same capture protocol
  skin uses, because change is slow enough that capture variance would dominate
  it entirely. That is a real piece of work, not a missing page.

## 5. What the page shows

| Element | Shown | From |
|---|---|---|
| Skin | Per-region latest state and 90-day mean, with recorded-day count; flare count | `loadSkinOverview` |
| Physique | A link and an explanation of why the number is there and not here | — |
| Grooming | Why it is not tracked | — |
| Hair | Why it is not tracked | — |

The recorded-day count travels with the mean everywhere it appears, for the
reason `regionTrends` gives: a mean of 4.0 from two days is not a mean of 4.0
from thirty, and a figure without its denominator invites exactly that reading.

Flares are **counted, never explained**. `/body/skin` puts what changed in the
fortnight before a flare next to it and says nothing about cause; this page does
not even do that much, because a count on an aggregate page beside a weight
trend would be an invitation nobody asked for.
