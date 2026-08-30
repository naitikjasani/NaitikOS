# Nutrition

**Status:** shipped, 30 August 2026 (§12's November block, built early — see
[validation.md](validation.md)). · **Blueprint sections:** §2.2, §4.3, §9.2,
§8.9, §8.13, §5.11
**Related:** [health.md](health.md) · [goals.md](goals.md) · [gym.md](gym.md)

---

## 1. The module has a pass/fail gate, and it is a stopwatch

§2.2 does not describe Nutrition as a set of features. It sets a condition:

> If logging a meal takes longer than ten seconds, the module has failed.

Everything below is downstream of that sentence. It is also the reason this
module has more instrumentation than any other feature in the system — a gate
nobody measures is a sentence in a document.

**Do not confuse this with §14.1's ten-second fallback.** That is a one-tap
degraded Daily Close for a bad night. Same duration, unrelated idea. They are
kept apart deliberately, because collapsing them turns a ship gate into a UI
affordance and the gate stops existing.

### How it is measured

Two figures, on `/settings/developer` beside §1.4's health metrics:

| Figure | Where it comes from | Budget |
|---|---|---|
| Median meal-log duration | `nutrition.log.duration`, emitted by `MealLogScreen` | ≤ 10 000 ms (`NUTRITION_LOG_BUDGET_MS`) |
| Meals logged without hand entry | `meal.capture_tier`, read by `mealRepository.tierMix` | ≥ 80% (`ASSISTED_TIER_FLOOR`) |

The mix leads and the latency lags. When the ranking, the templates or the
parser stop working, hand entry rises first and the median follows it up within
a week — reading only the median reports a healthy system right up to the point
it is not.

The clock starts when the picker **mounts**, not at `performance.timeOrigin`.
§2.2's claim is about the picker; folding a cold boot into it would make the
number a measure of Next.js. It ends when the write is durable in IndexedDB, not
when the server answers — §5.7 means the operator is finished before the network
is, and measuring past that point measures their signal.

Why the tier is a column and not a telemetry dimension: §5.11's `app_event` is
deliberately anaemic (names and numbers, no dimensions) and the guarantee is
that the schema *cannot* represent user content. Adding a dimension weakens it.
Telemetry is also discarded after ninety days, and "this meal was a template
tap" is a fact about the meal worth keeping. Migration `0009`, shipped alone per
§13.2.

## 2. The four tiers

§4.3's design assumes the overwhelming majority of meals are repeats.

| Tier | Interaction | Cost | Where |
|---|---|---|---|
| `template` | One tap on a saved meal | ~2 s | `MealLogScreen`, top three tiles |
| `suggestion` | Tap tiles, quantities already defaulted | ~5 s for three foods | The 12-tile grid |
| `parsed` | A typed line resolved against the library | ~8 s | `parseMealText` |
| `manual` | Entered or edited by hand | Unbounded, and not claimed otherwise | `QuantitySheet`, `FoodDetailScreen` |

**The tile's default quantity is the last quantity used for that food.** A
person eating 100 g of oats every morning types "100" exactly once, ever. That
single decision is most of the difference between five seconds and twenty-five.

Where there is no default — a food never eaten — the tile opens the quantity
editor instead of guessing. Inventing "1 serving" would put a number nobody
chose into an append-only log (P5).

### Undo, not confirm

§4.3 asks for confirmation on tier 3 only, and §8.12 says why:

> Confirmation dialogs train people to click through them; undo actually
> protects data.

A dialog seen three times a day is a dialog nobody reads. A template tap writes
immediately and produces an undo toast carrying the meal id.

## 3. The parser is deterministic

`parseNutritionLabel` and `parseMealText` are a regex and the nutrient
catalogue. No model. §10.11 routes natural-language parsing to Haiku 4.5 and
that path is December's; this one sits underneath it and stays as the fallback,
for the same reason the lab parser does — a parse that only works online is a
parse that fails at the table.

Three cases the meal splitter is built around, each of which broke a simpler
implementation:

- `3 eggs` — "eggs" is a pseudo-unit **and** the food.
- `scoop whey` — no leading number at all; the unit leads.
- `100g oats` — the unit is glued to the number.

Label rows below `LABEL_REVIEW_FLOOR` are **flagged, not dropped**. A nutrient
that quietly goes missing from a version is a food that quietly stops counting
towards a target, which is invisible until a month of data is wrong.

## 4. Foods, versions, and why nothing is ever edited

§9.2:

> Historical meals keep pointing at the version that was true when eaten.

A `meal_item` references a `food_version`, never a `food`. A reformulation is a
new version with its own `effectiveFrom`, so a 2026 dinner still reports 2026's
macros after a 2029 label change. `FoodDetailScreen` therefore has **no edit
control and an "add a version" one** — the absence is the feature. Editing in
place would silently rewrite three years of dinners.

A **template** is the opposite kind of object. It stores `foodId`, not a
version, because "my usual breakfast" means the oats as they are today. It is
resolved to the current version at the moment it is used, which is why a
template can go stale — the log screen greys it out and says why rather than
quietly logging a shorter meal.

## 5. The counters, and the only non-derived numbers in the module

`food.timesEaten` and `food.lastEatenAt` exist so the suggestion ranking never
aggregates over `meal_item`. They are written inside `logMeal`'s transaction,
and they are the module's one place where a number is stored rather than
derived. Three tests in `meal.repository.test.ts` exist for them, each named
after the failure it prevents:

1. **A replayed meal counts twice.** `ON CONFLICT DO NOTHING` protects the rows
   and has no opinion whatsoever about `timesEaten += 1`. §5.7 makes replay
   ordinary — the outbox retries on every flaky connection — so an explicit
   replay check is the only thing standing between that and a ranking that
   believes breakfast is eaten twice as often as it is.
2. **A deleted meal leaves its count behind**, so a food eaten once and removed
   outranks a food eaten once and kept, forever.
3. **An unresolvable item is silently dropped.** Millilitres against a per-gram
   basis is refused (`incomparable_unit`) and *named*, and the rest of the meal
   still lands. There is no density on a food row, so converting would be an
   invented number in an append-only log.

The ranking itself is `core`'s: `score = timesEaten × 0.5 ^ (daysSince / 14)`.
The slot is a **bonus** for foods and a **filter** for templates — a food eaten
at breakfast is still plausible at lunch; a saved meal called "usual breakfast"
is not.

## 6. Totals are read from the log, never recomputed

`dayTotals` reads `observation`, not `meal_item`. The log is the system of
record (§9.1) and the totals were written there when the meal was. Recomputing
would be a second implementation of `mealTotals` that could disagree with the
first, and the two disagreeing is a class of bug that only shows up in a
screenshot months later.

The one silent skip in `mealTotals` is an **uncatalogued nutrient key** — a
food carrying a nutrient the registry does not know. It is documented in place
rather than reported, because the alternative is a warning on every screen for a
condition the operator cannot act on.

`proteinBySource` reports `unclassifiedGrams` as its own figure rather than
folding it into `grain_other`. A food nobody has classified is not a grain, and
attributing it to one would quietly make the split wrong in a direction nobody
could see.

## 7. Targets are time-bounded

A bulk and a cut have different targets. A single mutable row would erase the
bulk the moment the cut began, and §4.10 needs both in order to say that a bulk
target and a visible-abs goal are in tension. Setting a target **closes** its
predecessor rather than overwriting it, which is why past targets stay on
`/body/nutrition/targets`.

There is deliberately **no default tolerance band**. §4.3 is explicit: an
invented ±10% reading "within" is a claim the operator never made. Without a
band, `evaluateTargets` reports the bare fact — under or over — which is less
helpful than a verdict and considerably more honest.

`unknown` is not `under`. Nothing logged is not the same as nothing eaten, and
reporting a blank morning as a shortfall is the guilt framing §4.7 and §14.1
both rule out.

## 8. Charts

`/body/nutrition/trends` draws ninety days per macro against the target that was
in force **on each day**, as a second series rather than a reference line — so
it appears in the chart's data table (§8.9(6)) and moves when the target moved.

A day with no meals is a `null` point, not a zero. §8.9(3): "gaps are gaps.
Interpolation across a week of no data is fabrication." A day nobody logged is
not a day of zero protein, and drawing it at the baseline would put a cliff into
the chart that describes forgetfulness rather than eating.

The axis starts at zero. §8.9(1) permits marked truncation, but a macro
legitimately reaches zero and a truncated axis on a nutrient chart makes an
ordinary day look like a crisis.

## 9. Quick capture: `c h`, and no `c f`

`c h` opens hydration — three presets (250 / 500 / 1000 ml) writing
`nutrition.water`. One number, no library behind it, and a stepper from 0 to
3000 in steps of 50 would be sixty taps for a number the operator already knows.

**There is no `c f` for food, and that is a decision rather than an omission.**
A meal needs the suggestion ranking, which is server data the app shell does not
have. Fetching it when the sheet opened would put a round trip in the middle of
the ten-second budget — making the sheet *slower* than `/body/nutrition/log`,
which arrives server-rendered with that data already in the response. A second,
slower path that looks faster is a trap. The command palette lists "Log a meal"
first instead, which is the shortest keyboard path that is also the fastest one.

## 10. Blueprint feedback

Two things worth correcting in the blueprint rather than working around:

1. **§4.3 and §2.2 cite "§10.6" for natural-language parsing.** §10.6 is the
   Insights Engine. Model routing is §10.11.
2. **§4.3 lists supplement tracking as a Nutrition feature.** §9.2 already
   assigns supplements to the shared routine engine, alongside skincare and
   dental hygiene — "one implementation, three consumers". Building a second one
   here would be exactly the duplication §9.2 was written to prevent. It is not
   built here.

## 11. Where things are

| Layer | Path |
|---|---|
| Domain | `packages/core/src/domain/nutrition/` — `nutrient`, `nutrients`, `food`, `template`, `targets`, `ranking`, `parser`, `metrics` |
| Gate | `packages/core/src/validation/metrics.ts` — `mealLogLatency`, `mealTierMix` |
| Repositories | `packages/db/src/repositories/{food,meal,nutrition-target}.repository.ts` |
| Seed | `packages/db/src/seed/foods.ts` — 37 hand-entered staples |
| Contracts | `packages/api/src/contracts/nutrition.ts` |
| Service | `apps/web/lib/platform/nutrition.ts` |
| Routes | `apps/web/app/api/nutrition/{route,parse/route}.ts` |
| Screens | `apps/web/features/nutrition/` |
| Pages | `/body/nutrition`, `/log`, `/foods`, `/foods/[id]`, `/meals`, `/targets`, `/trends` |

The seeded foods are **hand-entered estimates**, stated as such in
`SEED_SOURCE_NOTE`. IFCT is not redistributable, so nothing here claims to be
it. §9.9's provenance argument applies to a food label as much as to a lab
result: where a number came from is part of the number.
