# core/detectors

Stage 1 of the Insights Engine: deterministic detection. No model involvement.

**Owns:** the nine detector families in §10.6 — changepoint, correlation, adherence, streak, threshold, cycle, anomaly, stagnation, divergence — plus the statistical controls that keep them honest.

**The controls are not optional.** §10.6 is explicit that a naive implementation "will generate spurious findings continuously... it would quietly make the insight surface untrustworthy, and an untrustworthy insight surface in a health application is worse than none." All five are mandatory:

1. Minimum-N gates per detector.
2. Benjamini–Hochberg FDR control across the **whole nightly battery**, not per-detector.
3. Pre-registered hypothesis pairs; exploratory findings labelled as such.
4. Out-of-sample confirmation before promotion to the inbox.
5. No insights before day 60.

Every finding must state what it does **not** prove.

Blueprint §10.6.
