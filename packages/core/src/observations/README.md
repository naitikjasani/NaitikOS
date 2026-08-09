# core/observations

The observation substrate — the spine of the system.

**Owns:** the `Observation` model, the metric registry contract (`MetricDefinition`, `MetricRegistry`), the MVP registry itself (`mvp-metrics.ts`), provenance (`ObservationSource`), the hybrid logical clock (§5.7), and the write path — validation, unit conversion, bounds, and the append-only semantics from §9.1.

**Why the registry lives here rather than in `db`:** it was seed data until the Daily Close needed it. §4.0's form is *generated* from `metric.in_daily_close` and its eleven-element budget is arithmetic over these rows — both domain rules, and §5.0 puts domain rules below the database. A Close that needed Drizzle in order to know its own field list could not be tested without Postgres. `packages/db/src/seed/metrics.ts` inserts what is defined here.

**Why the whole module lives in `core`:** blueprint P3 makes every domain a lens over this one substrate. Skin queries training volume by metric key without knowing Gym exists. That only works if the substrate's *meaning* is defined below every feature, framework-free.

**Append-only is not a convention here.** There is no `update`, no `deletedAt`, and no setter. A correction is a new observation with the old one pointing at it, and migration `0001_observation_immutable` makes the database refuse anything else.

Blueprint §9.1, §9.2, §9.3, §5.3, §5.7, P3. Prose: [docs/observations.md](../../../../docs/observations.md).
