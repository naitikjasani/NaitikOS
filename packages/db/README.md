# @naitikos/db

**Semi-durable.** The ORM is replaceable; the schema is not, and PostgreSQL underneath is the actual asset.

> The data outlives the application. The schema, the export format, and the semantics of a recorded fact are the durable artifacts. The UI is scaffolding.
> — Blueprint P2

## Getting started

```bash
pnpm db:up        # Postgres 17 + pgvector on :5433
pnpm db:migrate   # apply migrations — never runs automatically (§5.15)
pnpm db:seed      # metric registry, feature flags, journal prompts; idempotent
pnpm --filter @naitikos/db test   # integration tests against the running database
```

`DATABASE_URL` must be set — copy `.env.example` to `.env`. There is deliberately no default: §5.15 treats a preview environment reaching production data as an incident, and a silent fallback to `localhost` is how a migration ends up somewhere unintended.

## Layout

Verified against the running database on 7 September 2026 — every figure below
came from a catalogue query rather than from memory, because the previous
version of this table was wrong in four places at once.

| Path | Owns | Status |
| --- | --- | --- |
| `src/schema/` | Table definitions, one file per domain | **Implemented — 103 tables** |
| `migrations/` | ★ Generated SQL, committed, append-only, never edited | **0000–0017, all 18 applied** |
| `src/seed/` | Reference data and (later) synthetic generators | Reference data done; no synthetic generators |
| `src/client.ts` | Connection factory | **Implemented** |
| `src/repositories/` | Query implementations behind `core`-defined interfaces | **Implemented — 43 repositories** |
| `src/views/` | Materialised rollup definitions | **Empty, and see below** |

The complete §9 model ships now, including domains with no UI for a year. §2.1: *"The schema is the expensive thing to change later; the UI is not."*

## The two kinds of data

Everything in `src/schema/` follows from §9.1's split:

| | **Observations** | **Entities** |
| --- | --- | --- |
| Mutability | **Immutable.** Never updated, never deleted. | Mutable, versioned |
| Correction | A superseding row referencing the original | An update; prior state in `audit_log` |
| Columns | `id` + explicit fields, no `deletedAt` | `entityColumns` — version + soft delete |

## Invariants the database enforces

These are not conventions. Each fails at the database, and each has a test in `src/schema/invariants.test.ts`.

| Invariant | Mechanism | Section |
| --- | --- | --- |
| Observations are append-only | `BEFORE UPDATE OR DELETE` trigger | §9.1 |
| Supersession is write-once | Same trigger | §9.1 |
| Every observation names a registered metric | Foreign key to `metric` | §9.3(1) |
| Every observation names its source | Foreign key to `observation_source` | §9.3(2) |
| No two believed schedules for one medication overlap | GiST exclusion constraint | §9.6 |
| Exactly one profile, forever | Check + unique index | C1 |
| Crisis plan never enters an AI scope | Check constraint | §4.7 |
| Journal entries confined to `none` or `journal` scope | Check constraint | §4.7 |
| Therapy content is never model-generated | Check constraint | §4.7 |
| Sensitive media cannot be stored unencrypted | Check constraint | §5.5 |

## Editing the schema

1. Change `src/schema/*.ts`, then `pnpm db:generate`.
2. **Read the generated SQL before committing it.** It is permanent.
3. Re-export any new file from `src/schema/index.ts`, or drizzle-kit will not see it.
4. A migration applied anywhere is immutable. Corrections are new migrations, never edits (§9.4).
5. Every migration must be forward-compatible with the previous application version — §5.15 calls this "the single most important operational discipline in the document", because database rollback is not assumed to exist.

## Recorded deviations from §9

**No date-truncated expression index on `observation`.** §9.6 asks for one. `date_trunc(text, timestamptz)` is `STABLE`, not `IMMUTABLE` — its result depends on the session `TimeZone` — so Postgres refuses it in an index. Forcing it with `AT TIME ZONE 'UTC'` would compile and be wrong: in `Asia/Kolkata` every observation before 05:30 would land on the previous day. Day queries are half-open range scans over `observation_observed_at_idx`, with bounds computed in the correct zone by `core/temporal`.

**No materialised views, despite `src/views/` and §5.6.** §5.6 specifies
"Postgres materialised views" for rollups. There are zero in the database and
`src/views/` is an empty directory; the implementation is a plain `metric_rollup`
table (`relkind = 'r'`, confirmed) intended to be refreshed by the
`refresh-rollups` job step.

**No decision record explains the substitution**, so this notes the deviation
without inventing a reason for it. The argument available in favour of the table
is that Postgres has no built-in incremental refresh — `REFRESH MATERIALIZED
VIEW` recomputes the whole relation — so a nightly full recompute over a
twenty-year record (C2) gets slower every year, which is the opposite of what a
rollup is for. Whether that was the reasoning at the time is not recorded, and
this file should not pretend otherwise. The empty directory should either hold
something or go.

`refresh-rollups` is named in `JOB_STEPS` and not yet registered, so nothing
currently writes `metric_rollup` either.

## One deviation that has been closed

**`sample` is now partitioned.** This file previously said it was not, and that
it was "deferred until wearable ingestion (V3)". Wearable ingestion shipped, and
migration `0015_sample_partitioning.sql` converted the table: `sample` is a
partitioned parent (`relkind = 'p'`), maintained ahead of itself by the
`maintain-partitions` job step and collapsed behind itself past ninety days by
`downsample-samples`. Both are registered.

The development database currently holds `sample_2026_09`, `sample_2026_10`,
`sample_2027_03`, `sample_2027_04` and `sample_default` — four monthly children
with a **five-month gap** between the second and third, which
`maintain-partitions` does not create. It is almost certainly residue from tests
calling `ensure_sample_partition` directly with far-future timestamps. Harmless
locally, and worth not mistaking for the job having run.

The claim that "converting an empty table is free" turned out to be right, which
is the only reason the deferral cost nothing.
