# core/derivation

Pure functions: observations in, derived facts out.

**Owns:** the transformations behind semantic memory (§10.1) — baselines, typical ranges, rolling trends, adherence rates.

## What is built

`rollup.ts` — the function every chart in the application goes through. It exists because of one sentence in §9.2:

> Summing bodyweight over a week is nonsense and averaging training volume hides a taper; **the registry is what stops a chart from doing either.**

That is a claim the registry cannot make on its own — `metric.aggregation` is just a column until something reads it. `dailyRollup` is the something. Every chart passes a `MetricDefinition` and gets the combining rule for free, and there is deliberately **no way to ask for a sum of a `mean` metric**: the aggregation is not a parameter.

It is also where the decimal-to-float boundary is crossed, once, for values that will be drawn rather than stored (see `statistics/README.md`).

`recordedDays` is separate from `dailyRollup` on purpose: "did I do the thing" and "what was the number" are different questions, and a grid built by testing `value > 0` would show a rest day and a zero-volume day identically.

**Zone handling:** a day is a day in the zone the observation was *captured* in, from `observation.observedZone` — never the reader's current setting. §5.3: a trip to London does not retroactively move three weeks of Indian evenings onto the previous date.

**Why deterministic:** §10.1 requires these facts be "derived deterministically, stored as rows with supporting evidence and a confidence" and never model-generated, because "a semantic memory that drifted from the data would silently poison every downstream inference — and would be undetectable."

Every derived value carries provenance marking it as derived (§9.2), so it stays distinguishable from a measured one forever.

Blueprint §9.2, §10.1.
