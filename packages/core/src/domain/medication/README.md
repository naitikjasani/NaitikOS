# core/domain/medication

The register, adherence, and the chart annotations §4.7 requires on every chart
in the system.

Not under `domain/mind`, because §4.7 is explicit: "Medication data lives in
Health; Mind reads it." `/mind/meds` is a filtered lens over these rows
(§3.3(3): "one row, three lenses").

**The rule that governs every function here**, from the metric registry: "A day
with no record is not counted as a missed dose — absence of data is not evidence
of non-adherence, and conflating them makes every figure quietly wrong."

`windowAdherence` therefore reports days recorded, doses taken and doses expected
*on recorded days*, and assembles its own sentence so no surface can present the
ratio without the unrecorded count beside it.

Blueprint §4.4, §4.7, §9.5.
