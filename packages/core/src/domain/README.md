# core/domain

Entities, value objects, and the invariants that define them — one file per domain.

**Owns:** the meaning of a workout, a medication, a skin observation. Constructors that reject invalid states, and predicates that express domain rules.

**Does not own:** persistence (`packages/db`), transport (`packages/api`), or presentation. Nothing here knows a database exists.

Blueprint §5.0, §9.2. Populated in the Week 1 schema milestone.
