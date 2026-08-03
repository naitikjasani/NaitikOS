# core/observations

The observation substrate — the spine of the system.

**Owns:** the `Observation` model, the metric registry contract, provenance (`ObservationSource`), and the append-only semantics from §9.1: observations are never updated and never deleted; a correction is a new observation that supersedes the old one, and both persist.

**Why it lives in `core` rather than `db`:** blueprint §P3 makes every domain a lens over this one substrate. Skin queries training volume by metric key without knowing Gym exists. That only works if the substrate's *meaning* is defined below every feature, framework-free.

Blueprint §9.1, §9.2, §P3.
