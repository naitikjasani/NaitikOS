# Runbook — Schema Migration

**Status:** written 7 September 2026, against migrations `0000`–`0017` and
drizzle-kit 0.31.10 · **Blueprint sections:** §5.3, §5.4, §5.15, §9.1, §9.4,
§9.5, §9.6, §9.7, §11.5, §11.8, §13.2
**Related:** [restore-drill.md](restore-drill.md) ·
[../observations.md](../observations.md) · [../events.md](../events.md) ·
[../background-jobs.md](../background-jobs.md) · [../export.md](../export.md)

---

## 0. Verified, derived, and how to read this page

C3 says the operator will arrive here having not thought about the schema for
two months. So this page states, for every step, whether it is a thing that was
observed to be true or a thing inferred from code that has never been run in
this exact form.

| Marker | Meaning |
|---|---|
| **Verified** | Confirmed on 7 September 2026 by reading the file, or by a read-only query against the local container `naitikos-postgres` (`postgresql://naitikos:naitikos@localhost:5433/naitikos`). |
| **Derived** | Read out of the code and believed correct, but not executed while writing this. Treat the expected output as a prediction, not a promise. |

No step below was executed as a write. Nothing here has generated a migration,
applied one, or reset a database. Where a command's output is quoted, the
provenance is stated.

Section 10 records four real defects found while writing this page. They are
reported, not fixed.

---

## 1. The rule that governs everything

§13.2, in the row headed *"Migration destroys data"*:

> "Forward-compatibility requirement; dry-run against a production clone;
> verified backup immediately prior; **migrations never bundled with features**."

§11.8 says the same thing from the release side:

> "A schema-change release is a distinct event, never bundled with feature work.
> It gets its own PR, its own dry-run, its own deploy, and a verified backup
> taken immediately before. This is the one place the process is deliberately
> heavier than it needs to be, because it is the one place where a mistake is
> permanent."

The failure this prevents has two halves, and only the first is obvious.

**A rollback that cannot roll back.** Application rollback is instant; database
rollback is not assumed to exist (§5.15). If the column and the feature that
reads it ship in one commit, then reverting the commit reverts the application
to a version that does not know the column exists — while the column is still
there — and, worse, invites someone to "revert the migration too". There is no
supported path for that. The schema only moves forward.

**A deploy where the application is ahead of the database.** Migrations run as
a gated step *before* deployment (§5.15), which means there is always a window
in which the new schema is live and the old application is still serving. That
window is safe only if the migration is additive. Bundle the two and the window
inverts: the new application deploys against a database that has not been
migrated yet, and every request touching the new column fails.

The practical shape of the rule:

1. PR one — `migration(db): add X`. Schema file plus generated SQL plus the
   checklist in §5 below. Nothing reads the new structure yet.
2. PR two — `feat(<scope>): use X`. Ships once PR one is applied everywhere.

`migration` is its own Conventional Commit type (§11.2) precisely so that
`git log --grep '^migration'` is the schema's history without reading diffs.

---

## 2. What you are working with

**Verified** — all paths and scripts read from the files named.

| Thing | Where | Notes |
|---|---|---|
| Schema of record | `packages/db/src/schema/*.ts` | 18 domain modules, plus the `columns.ts`/`enums.ts` primitives, plus the `index.ts` barrel — which is drizzle-kit's only entry point. |
| Generator config | `packages/db/drizzle.config.ts` | `out: './migrations'`, `casing: 'snake_case'`, `strict: true`, `verbose: true`. |
| Migration SQL | `packages/db/migrations/0000…0017*.sql` | Committed, append-only, never edited once applied. |
| drizzle-kit's own state | `packages/db/migrations/meta/` | 18 `NNNN_snapshot.json` files plus `_journal.json`. Generated; do not hand-edit. |
| Migration runner | `packages/db/src/migrate.ts` | Standalone script, `max: 1` connection, exits non-zero on failure. |
| Applied-migration ledger | `drizzle.__drizzle_migrations` | **In the `drizzle` schema, not `public`.** Columns `id`, `hash`, `created_at` (epoch ms). |
| Test reset order | `packages/db/src/testing/reset.ts` | `RESET_ORDER`. See §5. |
| The RLS guarantee | `packages/db/src/schema/rls.test.ts` | See §5. |
| The invariant guarantee | `packages/db/src/schema/invariants.test.ts` | 16 tests, each inside a rolled-back transaction. |
| Extensions | `packages/db/docker/init/001-extensions.sql` | Runs once, as superuser, on an empty data directory. Deliberately *not* a migration. |

### Commands that exist

**Verified** against `package.json` (root) and `packages/db/package.json`. Do
not invent others.

| Command | What it does |
|---|---|
| `pnpm db:up` | `docker compose up -d postgres` — Postgres 17 + pgvector on **5433**. |
| `pnpm db:generate` | `drizzle-kit generate` in `packages/db`. Writes SQL and a snapshot. **Derived:** `generate` diffs the schema against the last snapshot rather than against the live database, so it should not connect — but `drizzle.config.ts` does supply `dbCredentials`, so point `DATABASE_URL` somewhere harmless regardless. |
| `pnpm db:migrate` | `tsx src/migrate.ts`. Applies pending migrations. |
| `pnpm db:studio` | `drizzle-kit studio`. |
| `pnpm db:down` | `docker compose down`. Keeps the volume. |
| `pnpm db:reset` | `docker compose down -v && docker compose up -d postgres`. **Destroys the volume.** See §7. |
| `pnpm --filter @naitikos/db run test` | The integration suite. Needs a running, migrated database. |
| `pnpm --filter @naitikos/db run seed` | Metric registry, feature flags, journal prompts, reference exercises and foods. Idempotent. |
| `pnpm verify` | `turbo run typecheck lint test build` across the workspace. |

`DATABASE_URL` must be set. There is no default, on purpose (`src/env.ts`): a
silent fallback to `localhost` is how a migration intended for a scratch
database ends up somewhere else.

### Reaching the database directly

**Verified.** There is no `psql` on this machine's `PATH`. Go through the
container:

```bash
docker exec -it naitikos-postgres psql -U naitikos -d naitikos
```

For a one-shot query, `docker exec naitikos-postgres psql -U naitikos -d naitikos -c "…"`.

### The state as of 7 September 2026

**Verified** by read-only query.

| Fact | Value |
|---|---|
| Rows in `drizzle.__drizzle_migrations` | 18 — matching `_journal.json` entries 0–17 |
| Tables in `public` (`relkind IN ('r','p')`) | 108: 107 ordinary, 1 partitioned parent (`sample`) |
| Tables without RLS enabled | 0 |
| Permissive policies in `public` | 0 — this is the design, see §5 |
| Extensions installed | `vector` 0.8.6, `pg_trgm` 1.6, `pgcrypto` 1.3, `btree_gist` 1.7, `plpgsql` |
| Non-internal triggers | `observation_append_only`, `domain_event_append_only` |
| `sample` partitions | `sample_2026_09`, `sample_2026_10`, `sample_2027_03`, `sample_2027_04`, `sample_default` |
| Rows in `observation` / `sample` / `metric` | 0 / 0 / 68 |

The local database holds no observations. That is a property of *this*
machine's container today, not of the system — every judgement below about
"a migration that succeeds on an empty database" is written because the local
database is exactly that.

---

## 3. Two kinds of migration

The split is not "simple versus complicated". It is "expressible in the Drizzle
schema DSL versus not", and it is worth being precise, because a surprising
amount *is* expressible and hand-writing it would put the schema of record out
of sync with the physical database.

### 3.1 Generated by drizzle-kit from `src/schema/*.ts`

**Verified** by finding each construct declared in TypeScript *and* present in
the committed SQL.

| Construct | Declared at | Emitted at |
|---|---|---|
| Tables, columns, enums, foreign keys | every schema file | `0016_people_and_places.sql`, all of it above the RLS block |
| **CHECK constraints** | `check(…)` in 13 schema files | `person_cadence_positive`, `ask_turn_outcome`, `trip_ordered` |
| **Partial indexes** (`WHERE deleted_at IS NULL`) | `.where(…)` on `index()` | `interaction_person_idx`, `visit_place_idx` |
| **Partial unique indexes** | `uniqueIndex().where(…)` | `place_name_unique`, `auth_identity_active_idx` |
| **Trigram GIN indexes** | `index(…).using('gin', sql\`${t.name} gin_trgm_ops\`)` in `body.ts`, `medical.ts`, `nutrition.ts` | `exercise_name_trgm_idx`, `food_name_trgm_idx`, `medication_substance_trgm_idx`, `skincare_product_name_trgm_idx` |
| **HNSW vector index** | `index('embedding_hnsw_idx').using('hnsw', t.vector.op('vector_cosine_ops'))` in `ai.ts` | `0000_init.sql` |
| **Generated `tsvector` columns + GIN** | `searchVector(…)` in `columns.ts` | `person.search_vector`, `ask_turn_search_idx` |
| **Composite primary keys** | `primaryKeyConstraint({ columns: [...] })` | `sample_id_observed_at_pk` |

If you are about to hand-write one of these, stop. Declare it in the schema file
and generate it, or drizzle-kit's snapshot will disagree with the database
forever and the *next* generate will try to add it again.

### 3.2 Hand-written, because Drizzle cannot express it

**Verified** by confirming the construct appears in the SQL and appears nowhere
in `src/schema/*.ts`.

| Construct | Migration | Why it cannot be generated |
|---|---|---|
| **Exclusion constraint** | `0002_medication_schedule_exclusion.sql` | `EXCLUDE USING gist (medication_id WITH =, tstzrange(valid_from, valid_to, '[)') WITH &&) WHERE (recorded_to IS NULL AND deleted_at IS NULL)`. A unique index compares for equality; this needs a range operator, therefore GiST, therefore `btree_gist` for the scalar side. Drizzle has no DSL for it. |
| **Triggers and `plpgsql` functions** | `0001_observation_immutable.sql`, `0006_event_log_immutable.sql` | The schema can declare columns; only a trigger can declare a prohibition. |
| **Partitioning** | `0015_sample_partitioning.sql` | `PARTITION BY RANGE (observed_at)`, the `ensure_sample_partition(date)` function, and a `DEFAULT` partition. The schema file for `sample` says so in its own header. |
| **RLS enable / FORCE, and the `anon`/`authenticated` revokes** | `0004`, `0007`, `0011`–`0017` | Not part of a table definition. Every table-adding migration repeats the same `DO $$ … $$` block. |
| **Extensions** | `docker/init/001-extensions.sql`, not a migration at all | `CREATE EXTENSION` needs privileges the application role does not have on Supabase. Keeping it out means the committed migrations stay runnable by an unprivileged role. |

### 3.3 The mixed migration, which is the normal case

`0016` and `0017` are the pattern to copy: drizzle-kit's generated block first,
then `--> statement-breakpoint`, then a hand-appended comment header and the
RLS block. `0011`–`0014` are the same shape. Editing the *tail* of a
freshly generated, not-yet-applied file is expected and correct. Editing any
part of an already-applied file is forbidden (§6).

Note the house convention visible in every hand-written file: the SQL opens with
a comment saying which blueprint section demanded it and what would break
without it. In year eight that comment is the only thing that explains the file.

---

## 4. The procedure

Assume a change of the form "add a table" or "add a column". Anything
destructive is §6 and §7 territory.

### Step 0 — Before anything

- **Verified:** `docker ps` shows `naitikos-postgres` healthy, or run `pnpm db:up`.
- **Derived:** §11.7 requires a 24-hour cooling period for anything touching
  the substrate or migrations. Write it, sleep on it, review it the next day.
- If this is production, take a verified backup first — §13.2 and §11.8 both
  demand it, and "verified" means restored, not merely written. See
  [restore-drill.md](restore-drill.md).

### Step 1 — Change the schema file

Edit the relevant `packages/db/src/schema/*.ts`. Use the primitives in
`columns.ts` rather than raw Drizzle types:

- `entityColumns` for a **mutable entity** — gives `id`, `createdAt`,
  `updatedAt`, `version`, `deletedAt`, `deleteReason` (§9.1, §9.4).
- `instant()` for time, never `timestamp()`. It is a `customType` that
  normalises Postgres's text format to ISO 8601 on read. `mode: 'string'`
  returns `2026-08-03 08:00:00+00`, which sorts *before* an ISO string for the
  same instant because `' '` < `'T'` — a mis-ordering with no error message.
  Note the consequence: no `.defaultNow()`; write ``.default(sql`now()`)``.
- `quantity()` for anything measured — `numeric(20,6)`, read as a string.
  Never a float (§5.3).
- `money()` for money — integer minor units plus an ISO-4217 code.
- `ianaZone()` alongside any captured instant. An offset is not a zone.
- `searchVector('col_a', 'col_b')` for full text — arguments are the
  *physical snake_case* names, because the expression is emitted into SQL.

**If you add a new schema file, re-export it from `src/schema/index.ts`.** A
table not reachable from the barrel does not exist as far as drizzle-kit is
concerned, and the generate will silently produce nothing.

### Step 2 — Generate

```bash
pnpm db:generate
```

**Derived** expected behaviour, from `drizzle.config.ts` and drizzle-kit's
documented semantics: a new `packages/db/migrations/00NN_<name>.sql`, a new
`meta/00NN_snapshot.json`, and a new entry appended to `meta/_journal.json`.
`strict: true` means it prompts before anything destructive; `verbose: true`
means it prints the statements. Both are set deliberately — an unattended
`DROP COLUMN` is not a risk worth the convenience at n=1.

### Step 3 — Read the generated SQL. Always.

This is the step the whole runbook exists to protect. `packages/db/README.md`
puts it in bold for the same reason: *"Read the generated SQL before committing
it. It is permanent."*

Read for, specifically:

- A `DROP` of anything. drizzle-kit infers renames from column diffs and does
  not always infer them correctly; a rename it fails to spot becomes
  `DROP COLUMN` + `ADD COLUMN`, which is data loss that passes every test on an
  empty database.
- A `NOT NULL` added to an existing column with no `DEFAULT`. Fine on an empty
  table, fatal on a populated one.
- A new unique index over data that is not yet unique.
- Anything touching `observation`, `domain_event`, `medical_event` or
  `audit_log`. Those are the tables where a mistake is not recoverable.
- Statements that reference an extension. If it is not in
  `docker/init/001-extensions.sql` *and* enabled in the Supabase project, this
  will pass locally and fail in production.

### Step 4 — Adjust or hand-write

Append hand-written SQL to the tail of the generated file, separated by
`--> statement-breakpoint`, following the shape of `0016`/`0017`. For a new
table this always includes the RLS block — copy it verbatim from
`0017_ask_threads.sql`; the version there uses `relkind IN ('r', 'p')`, which
the earlier ones do not.

Lead with a comment explaining why the hand-written part is hand-written.

### Step 5 — Apply locally

```bash
pnpm db:migrate
```

**Verified** from `src/migrate.ts`: it prints `Migrating naitikos at
localhost:5433` and then `Migrations applied.` On failure it prints
`Migration failed: …` and exits 1, so a pipeline halts rather than shipping an
application against a schema it does not match.

### Step 6 — Run the database suite

```bash
pnpm --filter @naitikos/db run test
```

**Verified** from `vitest.config.ts`: `fileParallelism: false`, because
migrations take locks and the suites share one connection. Coverage thresholds
are disabled here on purpose. The two files that matter most:

- `src/schema/rls.test.ts` — five assertions. Every table in `public` with
  `relkind IN ('r','p')` has `relrowsecurity`; every one has
  `relforcerowsecurity`; `pg_policies` for schema `public` is **empty**; the
  secured count equals the total count; and a behavioural probe creates a role
  `rls_probe`, grants it `SELECT ON metric`, and asserts it reads **zero** rows
  while the owner reads more than zero.
- `src/schema/invariants.test.ts` — the append-only trigger, the metric and
  source foreign keys, the polymorphic subject pairing, numeric precision, the
  medication-schedule exclusion constraint, the four Mind privacy checks, the
  sensitive-media encryption check, and the profile singleton.

Then `pnpm verify` for the rest of the workspace.

### Step 7 — Verify by hand

**Verified** query shapes — these were run while writing this page.

```bash
# The ledger. Note the schema: drizzle, not public.
docker exec naitikos-postgres psql -U naitikos -d naitikos -c \
  "select id, to_timestamp(created_at/1000) at time zone 'UTC' as applied_utc
     from drizzle.__drizzle_migrations order by id desc limit 5;"

# Any table missing RLS. Must return zero rows.
docker exec naitikos-postgres psql -U naitikos -d naitikos -c \
  "select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r','p') and not c.relrowsecurity;"

# Any policy at all. Must return zero rows.
docker exec naitikos-postgres psql -U naitikos -d naitikos -c \
  "select tablename, policyname from pg_policies where schemaname = 'public';"
```

The ledger row count must equal the number of entries in
`migrations/meta/_journal.json`. On 7 September 2026 both were 18.

### Step 8 — Commit

One PR, type `migration`, scope `db`. Body explains why the schema needed to
change, not what changed — the diff already says what.

---

## 5. The checklist that is easy to forget

Every item here has either bitten this repository or is one schema addition
away from doing so.

### 5.1 `RESET_ORDER` — mandatory for a new table

`packages/db/src/testing/reset.ts` holds `RESET_ORDER`, a frozen ordered list
of tables that `resetDomainTables()` clears between integration suites.
**Verified:** seventeen test files import it.

The file's own header records the incident: the Health suite left `condition`
rows behind, and the Mind/Skin suite's `delete from medical_event` — written
before Health existed — began failing on a foreign key, sixteen tests at a time,
in a file nobody had edited. The comment beside the Gym block
(`program_block` before `program`) is the same lesson.

Rules:

- **Children before parents.** Foreign keys are satisfied by order alone; there
  is no `CASCADE` here.
- A new domain table that any test writes to **must** be added, or its rows leak
  into the next suite and the failure surfaces somewhere unrelated.
- `observation_source` is deliberately *not* cleared: the rows are resolved once
  and cached per process, so deleting them leaves a repository holding an id
  that no longer exists.
- `observation` is cleared by disabling `observation_append_only` around the
  delete. That is the only code in the repository permitted to do this.

### 5.2 RLS is manual, not automatic

**Verified.** Nothing enables RLS on a new table for you. `0004_enable_rls.sql`
says so in as many words: *"A new table is NOT covered automatically."*
Migrations `0007`, `0011`–`0017` each repeat the enable/FORCE block because each
added tables that `0004` could not have known about.

The posture is: RLS **enabled**, **FORCEd**, and **zero policies**. RLS with no
policy denies everything, which is the intent — §5.4 forbids
client-direct-to-database access, so the PostgREST path must reach a database
that returns nothing even holding the anon key, and the anon key ships in a
browser bundle.

`rls.test.ts` is the actual guarantee; the migration is only today's application
of it. Two consequences a migration must respect:

- **A policy appearing in `pg_policies` is not a test failure to be patched.** It
  is an architectural change requiring an ADR.
- **A new *kind* of relation can slip past.** When `0015` made `sample`
  partitioned, the parent became `relkind = 'p'` and was invisible to a test
  that only looked at `'r'` — the suite would have passed with RLS off on the
  largest table in the schema. The predicate is now `IN ('r','p')`. If you
  introduce a foreign table or a materialised view, check the predicate again.

### 5.3 Indexes for the queries that will actually run

§9.6 sets two guardrails: **no index is added without a measured query**, and
index bloat is reviewed annually. The temptation at n=1 is to over-index because
storage is free; the real cost is write amplification on the outbox drain, which
is the one path where latency is user-visible.

The patterns already in the schema, worth copying:

- Composite `(subject, time DESC)` with `WHERE deleted_at IS NULL` — the
  workhorse. Partial, so tombstones are excluded from the index rather than
  merely from the result.
- `uniqueIndex(...).where(isNull(deletedAt))` for "unique among the living".
- GIN over a generated `tsvector` for text; trigram GIN for typo tolerance.

**Recorded deviation, verified in `packages/db/README.md`:** §9.6 asks for a
date-truncated expression index on `observation` and there is not one.
`date_trunc(text, timestamptz)` is `STABLE`, not `IMMUTABLE`, so Postgres
refuses it; forcing it with `AT TIME ZONE 'UTC'` would compile and be wrong in
`Asia/Kolkata`. Day queries are half-open range scans instead. Do not
"fix" this.

### 5.4 Soft delete and bitemporal columns

- **Mutable entity** → `entityColumns`. It brings `deletedAt` and
  `deleteReason`. §9.4: nothing is hard-deleted. A tombstone without a reason is
  a mystery in year six.
- **Observation** → no `deletedAt`, ever. Immutable rows do not acquire one.
- **Clinically significant** → bitemporal, and only here. §9.5 draws the
  boundary at `medical_event` and its subtypes: valid time (when the fact was
  true) and transaction time (when the system was told). `medication_schedule`
  carries `valid_from`/`valid_to` and `recorded_to`, and the exclusion
  constraint in `0002` is scoped to `recorded_to IS NULL AND deleted_at IS NULL`
  — the constraint is on what the system currently *believes*, not on what it
  has ever believed.

Full bitemporality outside the clinical domain is not wanted. A bodyweight needs
`observed_at` and `recorded_at`, two timestamps, not two intervals.

### 5.5 The export

**Verified, and gentler than expected.**
`packages/db/src/repositories/export.repository.ts` discovers tables by walking
the schema module for `instanceof PgTable`, not from a hand-maintained list — so
a new table appears in the export the moment it exists. §9.10 promises "every
table", and a list would silently stop being complete.

What is *not* automatic is the description. `TABLE_DESCRIPTIONS` is a
per-table map; a table with no entry gets
`` `The ${name} table. No description was written for it; see the application
source.` `` That placeholder is legible but it is a hole in the P2 obligation —
§9.10's whole claim is that "someone in 2046 with the archive and no application
can understand it".

So: **add a sentence to `TABLE_DESCRIPTIONS`**, written for a reader who has
never seen this system. If the table is bookkeeping rather than record, add it
to `OPERATIONAL_TABLES` instead.

### 5.6 Partitioned tables

If the new table is partitioned, or you add a partition to `sample`:

- Every unique constraint must include the partition key. `sample`'s primary key
  is `(id, observed_at)` for exactly this reason, which is why the importer
  deduplicates on `(source_id, metric_key, observed_at)` rather than on the key.
- New partitions need RLS applied as they appear. `ensure_sample_partition()`
  does this itself — it runs `ENABLE` and `FORCE ROW LEVEL SECURITY` on each
  child it creates, because `0004`'s blanket grant ran long before.
- The nightly `maintain-partitions` step calls that function for the month
  ahead. It runs **before** `downsample-samples`: creating a partition takes a
  brief `ACCESS EXCLUSIVE` lock on the parent, and taking it against a quiet
  table beats queueing behind a collapse deleting a month of rows. See
  [../background-jobs.md](../background-jobs.md).

### 5.7 The rest

| Check | Why |
|---|---|
| New schema file re-exported from `src/schema/index.ts` | Otherwise drizzle-kit cannot see it. |
| Repository interface defined in `core`, implemented in `db` | §5.0's layering rule; `boundaries/element-types` fails the build otherwise. |
| Any new numeric event payload field reviewed | `events.md` — events reference, they do not restate. |
| `pnpm --filter @naitikos/db run seed` still idempotent | If the migration touches `metric`, `feature_flag`, `journal_prompt`, `exercise` or `food`. |

---

## 6. Things that must never be done

| Never | Why |
|---|---|
| **Edit an already-applied migration file.** | The runner matches on a hash of the file's contents, stored in `drizzle.__drizzle_migrations.hash` (64 hex characters, verified). Editing it means the local database and every other copy have diverged with no record of how. §9.4: forward-only, never edited once applied. A correction is a new migration. |
| **Hand-edit `meta/_journal.json` or a snapshot.** | They are drizzle-kit's model of the world. Desynchronise them and the next generate produces a diff against a schema that never existed. |
| **`UPDATE` or `DELETE` on `observation`, except the three supersession columns.** | The `observation_append_only` trigger rejects it with `restrict_violation`. §9.1: *"If a weight from 2027 can be silently edited in 2031, then no number in the system can be relied upon and the entire premise fails."* Corrections are additive — insert a new row and set `superseded_by_id` on the old one. Supersession is itself write-once. |
| **`UPDATE` or `DELETE` on `domain_event`, at all.** | Stricter than `observation`: there is no permitted column. A corrected event is a new event carrying the original's id as its `causationId`. Payload shape changes are handled by upcasting on read, never by rewriting stored rows. A replay over an edited log rebuilds a plausible timeline of a history that never happened. |
| **Drop a column holding recorded medical history.** | §9.4 makes deletion a tombstone, not a removal, and `audit_log` is *"append-only and permanent… never pruned"*. A dropped column takes the audit trail's `before`/`after` payloads with it in meaning if not in bytes. If a field is genuinely obsolete, stop writing it and leave it. Storage is not the constraint; the record is. |
| **Change a believed-interval row in place.** | §9.5, and it is what `medication_schedule` exists to prevent: a dose change is *"a new schedule rather than an edit that erases the old dose"*. `UPDATE medication_schedule SET dose = …` destroys the answer to "was I on 75 mg or 150 mg when the side effects started?" Close the current interval (`recorded_to`) and insert the new one. The exclusion constraint will reject an overlap. |
| **Add a permissive RLS policy to make a test pass.** | §5.4, and `rls.test.ts` says it in its own header. This requires an ADR. |
| **Put `CREATE EXTENSION` in a migration.** | It needs privileges the application role does not have on Supabase. Add it to `docker/init/001-extensions.sql` *and* enable it in the Supabase project. |
| **Let the application migrate itself on boot.** | §5.15: *"An application that migrates its own database on startup will eventually migrate it during a rollback."* `src/migrate.ts` is standalone for this reason. |
| **Run `pnpm db:reset` against anything you care about.** | It is `docker compose down -v`. The `-v` removes the `naitikos-pgdata` volume. It is a local-development command and nothing else. |

---

## 7. Rollback — what is and is not reversible

Be blunt about this, because the instinct to write a "down" migration is strong
and this repository deliberately has none.

**There are no down migrations.** **Verified:** every file in
`packages/db/migrations/` is forward-only; there is no `down` directory, no
`.down.sql`, and `src/migrate.ts` exposes no reverse path. §5.15:

> "Database rollback is not assumed to exist — every migration must be
> forward-compatible with the previous application version, so a rollback never
> strands the schema. This is the single most important operational discipline
> in the document, because it is the one whose absence causes unrecoverable
> failures."

What that means in practice:

| Situation | Recovery |
|---|---|
| Application is bad, schema is fine | Roll the application back. Instant, via the platform. The schema stays where it is — which is safe precisely because the migration was additive and shipped separately (§1). |
| Migration was additive and unwanted (a column nobody uses) | Leave it. An unused column costs nothing. Removing it is a *new* migration, reviewed on its own merits, with the §6 rules about medical history applying. |
| Migration was destructive and has been applied | **You cannot undo it.** The path is restore-from-backup, and it is the only path. See [restore-drill.md](restore-drill.md). This is the failure §11.5 places the production-clone dry-run gate in front of, and §13.2 places the verified-prior backup in front of. |
| Migration failed part-way | Depends on whether the statements ran in one transaction. See the failure table in §8. |

The honest summary: **the forward-compatibility discipline is the rollback
plan.** There is no second mechanism, and building one would be a worse use of
the effort than making the discipline reliable.

---

## 8. Failure modes

| Symptom | Cause | What to do |
|---|---|---|
| **Generated SQL contains a `DROP COLUMN` you did not ask for** | drizzle-kit read a rename as a drop-plus-add. | Delete the generated `.sql` and its `meta/00NN_snapshot.json`, remove the `_journal.json` entry, and hand-write an `ALTER TABLE … RENAME COLUMN`. `strict: true` should have prompted; the prompt is easy to accept by reflex at midnight, which is why Step 3 exists. |
| **`Migration failed: relation "x" already exists`** | The ledger and the files disagree — usually a migration applied, then its file was renamed or its hash changed. | Compare `drizzle.__drizzle_migrations` row count against `meta/_journal.json` entry count. If the database is local and disposable, `pnpm db:reset && pnpm db:migrate && pnpm --filter @naitikos/db run seed`. If it is not disposable, do not improvise — restore. |
| **Ledger has more rows than there are files** | Someone checked out an older branch. | Return to the branch that matches. Never delete ledger rows to make a migration re-run. |
| **Passes locally, fails on a database with data** | *The most common real failure, and the one worth expecting.* A `NOT NULL` without a default, a unique index over non-unique rows, a CHECK that historical rows violate, a foreign key with orphans, a type narrowing that truncates. On the local container — verified today at 0 observations and 0 samples — every one of these succeeds. | Do the dry-run against a restored production clone (§11.5's gate). Absent that pipeline, restore a backup into a scratch database and apply there first. Split the change into three migrations: add nullable → backfill → add the constraint. |
| **`0015` raises `sample holds N rows; partitioning requires recreating the table`** | The partitioning migration is being applied to a database that has already ingested device data. | Working as designed — it refuses rather than dropping the table. Migrate the rows out and back, or partition by hand. Re-running it against an already-partitioned table is a no-op, deliberately, so it does not block a restore drill. |
| **`type "vector" does not exist` / `operator class "gin_trgm_ops" does not exist`** | Extension missing. Locally, the init script only runs on an **empty** data directory, so a volume created before the extension was added will not have it. On Supabase, extensions are provisioned through the dashboard. | Locally: `pnpm db:reset` recreates the volume and re-runs `001-extensions.sql`. On Supabase: enable it in the project, then re-run the migration. Check with `select extname from pg_extension;`. |
| **`rls.test.ts` reports table names** | A new table shipped without the RLS block. | Add the block from `0017_ask_threads.sql` as a new migration. Do not `ALTER TABLE` by hand and move on — the next fresh database will not have it. |
| **Integration tests fail in an unrelated suite after adding a table** | `RESET_ORDER` gap (§5.1) or wrong order. | Add the table, children before parents. |
| **A sample import lands in `sample_default`** | No partition exists for that month. **Verified:** partitions today are 2026-09, 2026-10, 2027-03, 2027-04 — the months between have none. | Call `select ensure_sample_partition('YYYY-MM-01'::date);`. The nightly `maintain-partitions` step covers the month ahead only, not gaps behind it. |
| **CI catches nothing** | **Verified:** `.github/workflows/` is empty. There is no CI. | See §10. Until it exists, "applied locally but not in CI" is not a failure mode this repository can have — and that is worse, not better. |

---

## 9. Production

§5.15 places production on **Supabase for Postgres, auth and storage; Vercel for
the application**, with migrations as *"a discrete, gated step before deployment
— never automatically on boot"*.

### 9.1 The honest state of the deploy path

**Verified, and it matters more than anything else in this section:** the
production path is **not built**. As of 7 September 2026 the repository contains

- no `.github/workflows/*` — the directory exists and is empty;
- no `vercel.json` and no Vercel configuration of any kind;
- no `supabase/` directory, no project reference, no CLI configuration;
- an empty `scripts/` directory, despite §6.2 naming
  "seed, export, import, backup, restore-drill, key-rotation,
  migration-generation, embedding-backfill, health-check".

So §11.5's pipeline — including *"migration dry-run against a production clone"*,
described there as "the most important gate in the pipeline" — does not exist.
Neither does the automated backup that §13.2 requires immediately prior. Do not
read the blueprint's CI diagram as a description of this repository.

Until that is built, applying a migration to a hosted database is a manual
operation, and it is the manual operation with the least margin for error in
the whole system.

### 9.2 Applying against a hosted database — derived, never executed

The mechanism is the same script with a different `DATABASE_URL`. Everything
else differs.

| Difference | Consequence |
|---|---|
| **Extensions are not yours to create.** `001-extensions.sql` never runs there. | `vector`, `pg_trgm`, `pgcrypto`, `btree_gist` must be enabled in the Supabase dashboard first. The init script says this: *"Anything added here must also be enabled in the Supabase project, or a migration that depends on it will pass locally and fail in production."* |
| **`anon` and `authenticated` roles exist.** Locally they do not. | The `REVOKE` blocks in `0004`/`0007`/`0011`–`0017` are guarded by `IF EXISTS (SELECT 1 FROM pg_roles …)` and are therefore no-ops locally and real there. Their effect has never been observed. |
| **The connection is pooled.** `.env.example` notes production points at Supabase's pooled string. | `src/migrate.ts` opens its own `max: 1` connection, which is correct — but a transaction-mode pooler does not support session-level state. Use the **direct** connection string for migrations, not the pooler. **Derived**; verify against Supabase's current guidance before the first run. |
| **The database is not empty.** | Everything in §8's "passes locally, fails with data" row applies for the first time. |
| **There is no undo.** | §7. Take and verify a backup first — [restore-drill.md](restore-drill.md). |
| **Postgres major version is pinned to match.** | `docker-compose.yml` runs `pgvector/pgvector:pg17` because Supabase's current major is 17. Running 18 locally would reintroduce exactly the dialect drift §5.3 refuses. When Supabase moves, the compose file moves. |

The ordering §5.15 requires, and the reason it is that way round: **migrate,
verify, then deploy.** The migration is additive (§1), so the old application
keeps working against the new schema for the whole window. Reverse the order and
the window becomes an outage.

---

## 10. Problems found while writing this page

Reported, not fixed. Each was verified.

1. **`public.schema_migration` is dead.** §9.4 says *"Schema versioning is the
   migration directory plus a `schema_migration` table."* The table is declared
   in `packages/db/src/schema/operations.ts:250` with `id`, `checksum`,
   `applied_at`, `applied_by`, `is_data_migration`, and it holds **0 rows**.
   Nothing writes to it: the only other references in the codebase are its own
   index declaration and its listing in `export.repository.ts`'s
   `OPERATIONAL_TABLES`. The real ledger is drizzle-kit's
   `drizzle.__drizzle_migrations`, which carries no `applied_by` and no
   `is_data_migration` flag. Either `src/migrate.ts` should populate it or the
   table should be dropped — an empty table implying a control that does not
   exist is worse than neither.

2. **`pnpm db:seed` does not exist.** `packages/db/README.md` and the header of
   `packages/db/src/seed/index.ts` both instruct the operator to run it. The
   root `package.json` defines `db:generate`, `db:migrate`, `db:studio`,
   `db:up`, `db:down` and `db:reset` — but no `db:seed`. The working command is
   `pnpm --filter @naitikos/db run seed`. This is exactly the C3 failure the
   runbook rule exists to prevent: a documented command that does not run.

3. **`packages/db/README.md` is stale in two places.** Its layout table says
   migrations `0000–0002 applied` when 18 are applied, and its "recorded
   deviations" section still claims *"`sample` is not yet partitioned"* —
   contradicted by `0015_sample_partitioning.sql`, by `relkind = 'p'` on
   `sample`, and by the five partitions in the database. A reader returning
   after two months would trust it.

4. **`0004_enable_rls.sql` cites a test file that does not exist.** Its comment
   says *"`0004_rls_coverage.test.ts` asserts that every table in `public` has
   `relrowsecurity`"*. The file is `packages/db/src/schema/rls.test.ts`. The
   guarantee is real; the pointer to it is wrong.

Two smaller observations, offered without a recommendation:

- Every RLS block filters `c.relname <> '__drizzle_migrations'` while scanning
  schema `public`. The ledger actually lives in schema `drizzle`, so the
  predicate has never matched anything. Harmless, but it encodes a wrong belief
  about where the ledger is, and someone will one day search `public` for it.
- Several domain tables are absent from `RESET_ORDER` — `body_measurement`,
  `therapy_session`, `note`, `entity_tag`, `media_object`, `media_attachment`,
  `embedding`, `memory_fact`, `crisis_plan`. None currently leaks, because no
  suite writes to them (`therapy_session`, for instance, has no write method at
  all, by design). `review` is excluded deliberately and cleared by its own
  suite, with a comment saying so. The others are one test away from §5.1's
  incident recurring.
