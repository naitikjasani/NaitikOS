# @naitikos/core

★ **The durable layer.** The only part of this system intended to survive twenty years.

## The rule

> Domain logic must be able to compile and run with zero framework imports.
> — Blueprint §5.0

No React. No Next. No Drizzle. No Supabase. No Tailwind. Nothing with a version number that will churn.

This is enforced twice over:

1. **Dependency declaration.** This package's `package.json` lists exactly one runtime dependency: `@naitikos/shared`. With hoisting disabled (`.npmrc`), an undeclared import fails to resolve before ESLint runs.
2. **`boundaries/external`.** A framework import here fails the build with a message explaining why.

§5.0 rates this decision as "worth more over twenty years than every other technical decision in this section combined", because it is what makes the eventual framework rewrite a *UI* rewrite rather than a *product* rewrite.

## What this package owns

| Directory | Owns | Status |
| --- | --- | --- |
| `errors/` | The closed `DomainError` union (§5.12) | **Implemented** |
| `domain/` | Entities, value objects, invariants | Week 1 schema milestone |
| `observations/` | The observation substrate (§9.1) | Week 1 schema milestone |
| `temporal/` | Clock, HLC, bitemporal intervals (§5.7, §9.5) | Week 1 schema milestone |
| `units/` | `Quantity` and total conversions (§6.2) | Week 1 schema milestone |
| `statistics/` | Correlation, changepoint, trend (§10.0) | V2 — AI layer |
| `detectors/` | The nine detector families (§10.6) | V2 — AI layer |
| `derivation/` | Observations → derived facts (§10.1) | V2 — AI layer |

Each directory carries a README stating its scope and the blueprint sections that govern it. They are documentation of intent, not stubs — nothing here pretends to work.

## What it does not own

- **Persistence.** `core` defines `interface ObservationRepository`; `packages/db` implements it. Dependency inversion is what actually makes the durable layer durable (§6.2).
- **Transport, presentation, or anything asynchronous by nature.** Those live above.
- **Network calls.** That is `packages/ai`, deliberately separated because `core` must stay deterministic.

## Testing

Coverage threshold is currently 90%, rising to the §11.4 target of **95%** once `units/`, `statistics/`, and `detectors/` are populated. The bar is set high here and nowhere else because a wrong unit conversion corrupts conclusions silently, for years, and is discovered long after the data has been acted on.

`statistics/` and `detectors/` use **property-based** testing rather than examples — a detector that finds a changepoint in pure noise is a bug that example-based tests do not catch (§11.4).
