# core/statistics

Correlation, changepoint detection, trend fitting, moving averages.

**Owns:** every number the user ever sees. Blueprint §10.0: "Every number the user sees came from a SQL query. Every correlation came from a statistical test in `packages/core/statistics`." A language model narrates these results; it never produces them.

## What is built

| File | Owns |
|---|---|
| `types.ts` | `DailyValue` / `DailyEstimate` / `DailyBand`, and the one place floats are permitted |
| `moving-average.ts` | Trailing moving average over a **calendar** window; `summariseTrend` |
| `trend.ts` | Ordinary least squares, the confidence band, capped projection, `TREND_CAVEAT` |

Changepoint detection and correlation arrive with the insight engine (§10.6), which §2.1 keeps out of the MVP.

## Why floats live here and nowhere else

§5.3 bans floats for measured quantities. That rule governs the *record*; it does not govern a regression. These outputs are drawn on a 360px screen, never written back to `observation`, never exported as fact, never compared for equality. The decimal-to-float boundary is crossed in exactly one place — `derivation/rollup.ts` — and stated there.

Anything that flows *back* into the record stays `Decimal` end to end (`domain/gym/volume.ts`, `domain/gym/records.ts`).

## The honesty properties

- **A thin window produces a gap, not a confident number.** `movingAverage` returns `null` until a majority of the window has readings. One reading in seven days averages to itself, which is the raw number wearing a trend line's clothes.
- **A fitted line carries its caveat.** `TREND_CAVEAT` lives here rather than in a chart component, because the reason is a domain fact and a caveat in `core` is one a redesign cannot quietly drop.
- **`r` is never evidence.** §10.6's multiple-comparisons problem; `rSquared` travels with `n` and `spanDays`, and nothing emits a p-value.

**Testing:** property-based where the property is the point (§11.4) — a detector that finds a changepoint in pure noise is a bug example-based tests will not catch.

Held to the 95% coverage bar (§11.4).

Blueprint §8.9(4), §10.0, §10.6, §11.4.
