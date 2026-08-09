# Charts

*Blueprint §8.9. "Charts are the highest-risk area of the design system, because
a misleading chart in a health application produces a wrong decision about a
body."*

---

## The decision that shapes everything else: no charting library

§8.9 says "exactly one package imports the charting library", and names Recharts.
The invariant that sentence protects is that **features never import one** —
which importing none at all satisfies strictly.

The plot layer is about four hundred lines of SVG and integer arithmetic. What a
library would have bought is animation, a legend implementation, and a tooltip:
the frame already has a legend, the crosshair readout is the tooltip, and §8.6
wants restraint in motion anyway.

What it buys instead is C2. A plot layer with no dependencies will still build in
2046. Recharts at the version pinned today will not, and the migration off it
lands exactly when the charts have twenty years of data behind them and nobody
remembers how the axis logic worked.

This is a deviation from §8.9's letter and it is recorded here rather than
quietly taken.

---

## Charts never see instants

`SeriesPoint.at` is a **day key** — `YYYY-MM-DD`, already resolved in the zone
the observation was captured in. Not an ISO instant.

The reason is §5.3. A renderer handed an instant would re-derive the day in the
*runtime's* zone, which files every Indian evening under the following date —
exactly the bug the `date_trunc` note in the schema and the `dayKeyInZone` helper
both exist to prevent. Pushing the resolution up to `core`'s `dailyRollup` means
the chart layer contains **no temporal logic at all**: `charts/calendar.ts` is
Howard Hinnant's civil-date algorithms on integers, with no `Date` anywhere.

That also satisfies §11.3's ban on raw `Date` construction without an exemption.

---

## Where each §8.9 invariant lives

| Invariant | Implementation |
|---|---|
| (1) Y-axis truncation must be labelled | `resolveYDomain()` returns `isTruncated`; `ChartFrame` renders the badge, `TrendChart` draws the break glyph. There is **no way** to get a truncated axis without the flag. |
| (2) Annotations for interventions | `ChartData.annotations` → vertical rules for instants, shaded spans for ranges, and a text list for screen readers |
| (3) Missing data is shown as missing | `linePath` starts a new subpath at every `null`; `bandPath` closes one shape per contiguous run |
| (4) Confidence must be visible | `bandPath`, plus a dashed stroke and a widening band for `isProjection` points |
| (5) Colour never encodes valence | every stroke is `--color-data-N` chosen by the series' **fixed slot**, never its rank |
| (6) Every chart has a table | `ChartFrame`, always, with an em dash for a gap and never a zero |
| (7) Readable at 360px | measured pixel width via `ResizeObserver`; margins budgeted at the narrow case |

### On (1), specifically

A weight chart from 74–76 kg is legitimate, useful, and visually dramatic. §8.9
calls an unlabelled truncated axis "a lie told in a health application", so the
truncation is reported *by the geometry function* rather than by a prop somebody
could forget to pass. A domain that happens to contain zero is not badged — a
warning that fires on every chart is a warning nobody reads.

### On (3), specifically

`bandPath` closes one shape per contiguous run rather than emitting a single
polygon. One polygon spanning a gap renders as a solid block across the missing
fortnight — the same lie as an interpolated line, drawn larger.

---

## The components

### `TrendChart`

Line, with an optional band, annotations, and a scrub-to-read crosshair.

The readout is a **fixed strip above the plot**, not a floating tooltip. That is
a mobile decision: a tooltip anchored to the touch point is under the finger that
summoned it. The strip stays put and is legible while scrubbing.

Nearest-point selection is **by x only**. Two-dimensional nearest sounds better
and is worse — on a two-series chart it selects whichever line the finger is
closer to vertically, so dragging along the axis makes the readout jump between
series. Readers track time; the axis they scrub is time.

Dots are drawn only when a series has ≤ 24 points. A dot per point on a
ninety-day series is noise, not information.

### `BarChart`

**Horizontal, and forced to a zero baseline.**

Horizontal because twelve muscle groups with vertical bars at 360px gives each
label 28 pixels, which forces 45° rotated text — the single most common
unreadable thing in a dashboard. Horizontal gives every label a full line and
costs only vertical space, which a phone has.

Zero-baselined because a truncated bar chart is a *different and worse* lie than
a truncated line chart: a bar's **length** is the encoding, so halving the axis
doubles the apparent difference. `zeroBaseline: false` is not honoured here.

Values are direct-labelled selectively — at the end of the bar, and only when the
bar is long enough to hold the label without collision. Never a number on every
mark.

### `AdherenceGrid`

The calendar heatmap, and the one chart that must be exactly right about absence.
It distinguishes four states that a naive implementation collapses into two:

| State | Rendered as | Why it matters |
|---|---|---|
| Recorded, with a value | filled, shaded by magnitude | the thing happened |
| Recorded, value zero | filled at the palest step | a zero-volume session is not a rest day |
| Not recorded | an empty outlined cell | absence of evidence, not evidence of absence |
| Outside the range | nothing at all | a future Tuesday has not been missed |

The third and fourth are the ones that get conflated, and the result is a wall of
failure for every day before the operator started using the system. §9.2 makes
the same point about medication: "a day with no record is not counted as a missed
dose — absence of data is not evidence of non-adherence, and conflating them
makes every figure quietly wrong."

Weeks are columns and weekdays are rows, so a "Tuesdays are the problem" pattern
reads along a row. Days flowing left to right hide weekday patterns entirely, and
weekday patterns are most of what adherence actually has.

---

## The sequential ramp

§8.9(5) and the dataviz rule: magnitude takes a *sequential* palette — one hue,
light to dark — never a categorical one and never a rainbow. There is no
sequential ramp in the token set, so the grid's steps are mixed from the single
categorical hue toward the chart surface in OKLab:

```css
.nos-grid__cell--1 { background: color-mix(in oklab, var(--color-data-1) 22%, var(--color-surface-raised)); }
.nos-grid__cell--2 { background: color-mix(in oklab, var(--color-data-1) 45%, var(--color-surface-raised)); }
.nos-grid__cell--3 { background: color-mix(in oklab, var(--color-data-1) 70%, var(--color-surface-raised)); }
.nos-grid__cell--4 { background: var(--color-data-1); }
```

Mixing toward the surface makes lightness monotone **by construction** rather
than by inspection — the property a sequential scale must have and the one a
hand-picked ramp usually misses. Because the mix target is whichever surface is
in force, it inverts correctly in dark mode with no second palette.

---

## The trend line's caveats are part of the deliverable

A straight line through ninety bodyweight readings looks authoritative. It is the
single most over-trusted object a health application can draw, so `TREND_CAVEAT`
lives in `core` — where a redesign cannot quietly drop it — and renders beneath
the line:

> A fitted line over readings that are not independent day to day. The band is
> indicative, not a confidence interval you should act on.

Three structural caveats sit behind that sentence:

1. **Daily bodyweight is autocorrelated.** Water, food volume and glycogen
   persist for days, so OLS's independent-residual assumption fails and the band
   is *narrower than the truth*.
2. **A line is a model.** `projectForward` caps at fourteen days, flags every
   point, and uses the wider *prediction* interval rather than the interval for
   the mean — because "where will I actually be" is what a projection is read as.
3. **`r` is not evidence.** §10.6 is explicit about multiple comparisons, so
   `rSquared` travels with `n` and `spanDays` and nothing emits a p-value.

The moving average carries its own honesty property: it returns `null` until a
majority of the window has readings. One reading in seven days averages to
itself, which is the raw number wearing a trend line's clothes — the most
misleading output the module could produce.

---

## A bug worth recording

`formatTick` derived its decimal places from the step's *magnitude*
(`step >= 1 ? 0 : …`). A step of `2.5` is `>= 1`, so a 72.5 / 75 / 77.5 axis
labelled itself **73, 75, 78** — two ticks out of three wrong.

`2.5` is exactly the step a 74–79 kg bodyweight axis picks. The places are now
derived from the step's own digits, and `scales.test.ts` names the case.

---

## Files

```
packages/design-system/src/charts/
  types.ts            series shape, slots, the invariant checker
  calendar.ts         civil-date arithmetic on integers — no Date
  scales.ts           extents, nice ticks, scales, path building
  useElementWidth.ts  ResizeObserver, and why not a viewBox
  ChartFrame.tsx      legend, table, truncation badge, annotation list
  TrendChart.tsx      line, band, projection, crosshair
  BarChart.tsx        horizontal, zero-baselined
  AdherenceGrid.tsx   calendar heatmap
```
