# @naitikos/db

**Semi-durable.** The ORM is replaceable; the schema is not, and PostgreSQL underneath is the actual asset.

> The data outlives the application. The schema, the export format, and the semantics of a recorded fact are the durable artifacts. The UI is scaffolding.
> — Blueprint P2

## Getting started

```bash
pnpm db:up        # Postgres 17 + pgvector on :5433
pnpm db:migrate   # apply migrations — never runs automatically (§5.15)
pnpm db:seed      # metric registry + feature flags; idempotent
pnpm --filter @naitikos/db test   # integration tests against the running database
```

`DATABASE_URL` must be set — copy `.env.example` to `.env`. There is deliberately no default: §5.15 treats a preview environment reaching production data as an incident, and a silent fallback to `localhost` is how a migration ends up somewhere unintended.

## Layout

| Path | Owns | Status |
| --- | --- | --- |
| `src/schema/` | Table definitions, one file per domain | **Implemented — all 71 tables** |
| `migrations/` | ★ Generated SQL, committed, append-only, never edited | **0000–0002 applied** |
| `src/seed/` | Reference data and (later) synthetic generators | Reference data done |
| `src/client.ts` | Connection factory | **Implemented** |
| `src/repositories/` | Query implementations behind `core`-defined interfaces | Week 2 |
| `src/views/` | Materialised rollup definitions | Week 3 |

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

## Two recorded deviations from §9

**No date-truncated expression index on `observation`.** §9.6 asks for one. `date_trunc(text, timestamptz)` is `STABLE`, not `IMMUTABLE` — its result depends on the session `TimeZone` — so Postgres refuses it in an index. Forcing it with `AT TIME ZONE 'UTC'` would compile and be wrong: in `Asia/Kolkata` every observation before 05:30 would land on the previous day. Day queries are half-open range scans over `observation_observed_at_idx`, with bounds computed in the correct zone by `core/temporal`.

**`sample` is not yet partitioned.** §9.7 specifies monthly partitions and a 90-day retention policy. Deferred until wearable ingestion (V3): the table stays empty until then, and converting an empty table is free.
