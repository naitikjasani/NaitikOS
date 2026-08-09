# core/detectors

Stage 1 of the Insights Engine: deterministic detection. No model involvement.

**Owns:** the two detector families §2.1 puts in the MVP — adherence and streak —
and the battery that applies §10.6's five statistical controls to them.

**Does not own** the other seven families in §10.6's table. They are V2, and
adding one means passing it through `runBattery` rather than around it.

## The controls, and where each one is

| Control | Where |
|---|---|
| 1. Minimum-N gates | in each detector, reported as `InsufficientData` |
| 2. Benjamini–Hochberg across the whole battery | `battery.ts` → `statistics/fdr.ts` |
| 3. Pre-registered hypotheses | `PRE_REGISTERED` in `battery.ts` |
| 4. Out-of-sample confirmation | `battery.ts`, via `heldFindingIds` |
| 5. No insights before day 60 | `baselineState` — **applies to inference, not to counts** |

Control 5's reading is a deviation from the literal text of §10.6 and is argued
in [`docs/insights.md`](../../../../docs/insights.md) §3. If the reading is wrong,
the fix is one boolean.

`doesNotProve` is a required field on `Finding`, so a detector cannot construct
one without writing that sentence.

Blueprint §10.6, §2.1.
