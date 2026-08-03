# core/derivation

Pure functions: observations in, derived facts out.

**Owns:** the transformations behind semantic memory (§10.1) — baselines, typical ranges, rolling trends, adherence rates.

**Why deterministic:** §10.1 requires these facts be "derived deterministically, stored as rows with supporting evidence and a confidence" and never model-generated, because "a semantic memory that drifted from the data would silently poison every downstream inference — and would be undetectable."

Every derived value carries provenance marking it as derived (§9.2), so it stays distinguishable from a measured one forever.

Blueprint §9.2, §10.1.
