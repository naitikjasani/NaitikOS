# Runbook — The Restore Drill

**Status:** written 7 September 2026 · **never executed end to end** · **Blueprint sections:** §5.15, §5.16, §9.4, §9.7, §9.10, §11.6, §13.2
**Related:** [export.md](../export.md) · [media.md](../media.md) · [storage.md](../storage.md) · [background-jobs.md](../background-jobs.md)

---

## 1. The premise

§13.2 ranks data loss as the only risk in the technical table marked **Fatal**, and it is
explicit about which of the mitigations is doing the work:

> "Append-only observations; soft delete; permanent audit log; automated backups;
> **quarterly tested restore**; monthly independent export. The restore drill is the
> control that matters — the others are hypotheses without it."

Backups are Supabase's, taken automatically (§5.15). Nobody has ever restored one. Until
somebody does, the sentence "there are backups" is a claim about a dashboard, not a claim
about the record. The purpose of this drill is to convert that claim into a fact, four
times a year, and to find out what is broken about the procedure while there is still a
working production system to compare against.

§11.6 states what this file has to be:

> "The operator executing a restore in eighteen months will have forgotten everything, and
> the runbook is written for that person — with exact commands, expected output, and what
> to do when it goes wrong."

That person is you, under C3, two months out of contact with the system and probably not
in a good mood.

---

## 2. Read this before anything else: what is verified and what is not

**Most of this procedure has never been run.** A runbook that says "you will see X" about a
step nobody has taken is exactly the confident-but-untested artefact this codebase refuses
everywhere else, so every section and every step below carries one of two tags.

| Tag | Means |
|---|---|
| **[verified]** | Executed, read-only, against the local development database on 7 September 2026. The stated output is what actually came back. |
| **[derived]** | Read out of the code, the migrations, or `docker-compose.yml`, and **never executed**. The commands use real flags of real tools and the reasoning follows from the source — neither has been proven. |

The distribution is uncomfortable and should stay visible: **§3 to §6 and all of §8 are
[derived]. No dump has ever been taken, no target has ever been stood up, and no restore
has ever been performed.** What is [verified] is the shape of the thing being restored —
the schema, the RLS posture, the migration ledger, the partitions, the extensions — which
is what §7's verification compares against.

**The first person to execute this runbook should edit the tags as they go**, replacing
[derived] with [verified] and correcting whatever turns out to be wrong. That edit is the
most valuable output of the first drill, more valuable than the restore itself.

### What was actually run, on 7 September 2026 [verified]

Read-only queries against the local development container (`naitikos-postgres`, up and
healthy, `pgvector/pgvector:pg17`, published on `0.0.0.0:5433`), plus `ls`, `cat`, and
`pnpm exec node -e` invocations that only print. Nothing was written, no migration was
applied, no container was recreated.

| Fact | Value observed |
|---|---|
| Server version | `PostgreSQL 17.10 (Debian 17.10-1.pgdg12+1) on aarch64-unknown-linux-gnu` |
| Database encoding / collation / ctype / locale provider | `UTF8` / `C` / `C` / `c` |
| Extensions | `btree_gist 1.7`, `pg_trgm 1.6`, `pgcrypto 1.3`, `plpgsql 1.0`, `vector 0.8.6` |
| Migration ledger | `drizzle.__drizzle_migrations` — **18 rows**, `max(created_at) = 1788668597473` |
| Tables in `public` | 107 with `relkind = 'r'` (includes the `sample` partitions) plus 1 with `relkind = 'p'` |
| RLS | all 108 have `relrowsecurity` **and** `relforcerowsecurity`; `pg_policies` for schema `public` returns **0 rows** |
| Partitions of `sample` | `sample_default`, `sample_2026_09`, `sample_2026_10`, `sample_2027_03`, `sample_2027_04` |
| Indexes in `public`, by access method | `btree` 299, `gin` 20, `gist` 1, `hnsw` 1 (`embedding_hnsw_idx`) |
| Generated columns | 16, all named `search_vector` |
| Enum types in `public` | 68 |
| Materialised views in `public` | none |
| Sequences in `public` | one — `domain_event_sequence_seq` |
| Triggers on `observation` | `observation_append_only`, `tgenabled = 'O'` |
| Row counts (local dev, not production) | `observation` 0 · `metric` 68 · `audit_log` 0 · `media_object` 0 · `sample` 0 · `observation_source` 81 |
| Host tooling | `psql`, `pg_dump` and `pg_restore` are **not on `PATH`** on this machine |

Two of those deserve a note now rather than a surprise later.

**There is no Postgres client on the host.** Every command in this runbook therefore goes
through `docker exec` or `docker run` against the pinned image, which has the additional
benefit of guaranteeing a 17.x client. Installing a system `psql` would reintroduce the
version-drift question `docker-compose.yml` pins the image to avoid.

**`sample_2027_03` and `sample_2027_04` exist**, which is six months ahead of what the
`maintain-partitions` job would create (current month and the next). They are almost
certainly residue from a test that called `ensure_sample_partition` with a future date.
Harmless — the function is idempotent and an empty partition costs a catalogue row — but
it means "the right partitions exist" is a weaker check on the dev database than it will
be on a restored production clone.

---

## 3. Scope — what a restore actually has to bring back [derived]

A Postgres dump is not the system. It is the largest and most structured *part* of the
system, and restoring it alone produces a record with holes that do not announce
themselves.

| Component | Where it lives | In a `pg_dump`? | Consequence of restoring without it |
|---|---|---|---|
| Relational record | Supabase Postgres | **Yes** | — |
| Migration ledger | `drizzle.__drizzle_migrations`, schema `drizzle` | Only if the dump is not restricted to `public` | `pnpm db:migrate` replays from `0000` against a populated database |
| Cluster roles (`anon`, `authenticated`, the app role) | Postgres cluster globals | **No** — `pg_dump` is per-database | Grants and revokes referencing them are skipped or error |
| Extensions | Provisioned by Supabase / `packages/db/docker/init` | The `CREATE EXTENSION` statements are, the binaries are not | The HNSW index cannot be created (§8) |
| Encrypted media objects | Supabase Storage, three buckets ([storage.md](../storage.md) §3) | **No** | Every `media_object` row points at bytes that do not exist |
| Wrapped per-object data keys | `media_object.wrapped_key` — a database column | **Yes** | — |
| The master key | Derived from the operator's passphrase via Argon2id, held in memory, never transmitted (§5.5) | **Never** | Ciphertext that nothing can open, forever |

The third and fifth rows are the ones that make a database-only restore a false pass.
[media.md](../media.md) §8 puts the tier and a content hash in the storage key
(`sensitive/2026/08/3b/1f/<content-hash>.jpg`), so a `media_object` row is a *pointer* into
object storage, not a container for the bytes. §9.8 requires that "every storage object has
a row and every row has an object"; a Postgres restore satisfies exactly one half of that
and the nightly `verify-media-integrity` step will report the other half as orphaned rows
the moment it runs.

The passphrase is worse than a gap — it is the one input to this system that cannot be
restored from anything. §5.5 accepts the consequence explicitly: "lose the passphrase and
the photos are unrecoverable", with a printed recovery code stored offline as the only
mitigation. **A drill that does not include locating and reading that recovery code has not
tested the media path at all.** Confirming it still exists and is legible is a step in this
drill (§6.5), and it takes thirty seconds.

Note also what [media.md](../media.md) §10 means for a restore: `StorageProvider.remove()`
is *not* part of ordinary deletion, so a soft-deleted photo's bytes are still in the bucket
and still expected by the integrity sweep. A storage restore must bring back objects for
tombstoned rows too, or the sweep flags every undone deletion in the record's history.

---

## 4. Against a clone. Never against production. [derived]

§5.15 tabulates three environments and permits real data in exactly one of them. The drill
runs against a fourth thing — a throwaway target that exists for an hour — and the reasons
to keep it away from production are not stylistic:

- **`pg_restore` into a live database is a write path around every invariant.** The schema
  refuses mutation to `observation` with a trigger (`observation_append_only`), refuses a
  second `profile` row, refuses an unregistered metric key. A restore does not go through
  the API layer where §5.4 says authorization lives, and a partial restore into a populated
  database would be indistinguishable from corruption afterwards.
- **The verification suite writes.** `packages/db/src/schema/rls.test.ts` creates a login
  role `rls_probe`, grants it `SELECT ON metric`, and drops it in a `finally`. It is the
  only honest way to prove RLS behaviourally rather than by configuration, and it is
  categorically not something to run against the real database.
- **Migration `0015_sample_partitioning` drops and recreates `sample`.** It refuses to do
  so when the table holds rows — that guard is the reason the drill is survivable — but the
  correct response to "a migration that recreates a table" is never to point it at
  production and find out.
- **§5.15's whole point about preview environments applies here.** "A PR preview that
  touches a real medical record is an incident." A drill target that can reach the
  production connection string is the same incident with a different name.

The only production contact permitted in this drill is **reading** — downloading a backup
artefact, and optionally reading row counts to compare against. Export the production
connection string into the shell for those two commands and unset it immediately
afterwards.

**Cadence: quarterly**, per §5.16's "quarterly scripted restore drill" and §13.2's
"quarterly tested restore". §12's V3 Q4 schedules the first *full* restore-and-export
drill; that is the deadline for this runbook to have been executed at least once, not
permission to wait until then.

---

## 5. Prerequisites [derived]

- Docker running, and the image already pulled — the drill is not the moment to discover a
  registry outage. `docker image inspect pgvector/pgvector:pg17` is the check.
- Roughly three times the dump's size free on disk: the archive, the restored data
  directory, and the export produced in §9.
- The repository checked out at the commit that is **currently deployed to production**,
  not `main`. If `main` is ahead, the migration ledger comparison in §7 will fail for a
  reason that has nothing to do with the restore.
- The offline recovery code for the media passphrase, physically located (§3).
- A working directory for the drill's artefacts. Everything below assumes it is `./drill`
  at the repository root, and that it is **not** committed.

Two environment facts that will otherwise cost an hour, both **[verified]**:

- **Nothing in this repository loads `.env`.** There is no `dotenv` dependency, `tsx` does
  not read it, and `packages/config/vitest/base.js` has no setup file. `pnpm db:migrate`
  and the test suites read `process.env['DATABASE_URL']` directly, so the variable must be
  `export`ed into the shell. Confirmed by running the workspace's own `tsx` with the
  variable unset: it prints `undefined` despite `.env` existing at the repository root. The
  error thrown by `packages/db/src/env.ts` says "Copy .env.example to .env and set it",
  which on its own will not work.
- **`pnpm db:reset` is `docker compose down -v && docker compose up -d postgres`.** It
  destroys the `naitikos-pgdata` volume — your development database. It has no role in this
  drill and appears here only so it is not reached for by reflex.

---

## 6. The procedure [derived]

Every step in this section is derived from the code and has never been executed.

### 6.1 Obtain the dump

**Prefer the provider's automated backup artefact over a fresh `pg_dump`.** This is the
whole point. §13.2's control is a *tested restore of the backup*; taking a new dump by hand
tests `pg_dump`, which nobody doubts, and leaves the automated backup — the thing that will
actually be reached for at 2 a.m. — still untested. Download it from the Supabase
dashboard.

Record, in the drill log (§10), the backup's timestamp. A restore that succeeds against a
backup taken four hours ago proves less than one that succeeds against the oldest backup
still in retention, and the second is the more interesting drill to run at least once a
year.

If a hand-taken dump is unavoidable, run the client from the pinned image so its major
version matches the server:

```sh
mkdir -p drill
docker run --rm -v "$PWD/drill:/drill" pgvector/pgvector:pg17 \
  pg_dump --format=custom --no-owner --no-privileges \
          --file=/drill/naitikos-$(date +%F).dump \
          "$PRODUCTION_DATABASE_URL"
```

`--format=custom` because it is what `pg_restore` consumes selectively and in parallel.
`--no-owner --no-privileges` because the ownership and grants in production reference roles
that do not exist in the target (§3), and leaving them in produces a wall of errors that
hides the one error that matters.

**Do not restrict the dump to the `public` schema.** The migration ledger lives in the
`drizzle` schema — verified: `drizzle.__drizzle_migrations` — and a `--schema=public` dump
silently omits it. §8 covers what happens next.

### 6.2 Stand up the target

A separate container, a separate port, and no named volume, so the target is anonymous and
disappears with `docker rm`:

```sh
docker run -d --rm \
  --name naitikos-restore-target \
  -e POSTGRES_USER=naitikos \
  -e POSTGRES_PASSWORD=naitikos \
  -e POSTGRES_DB=naitikos \
  -e POSTGRES_INITDB_ARGS='--encoding=UTF8 --locale=C' \
  -p 5434:5432 \
  -v "$PWD/packages/db/docker/init:/docker-entrypoint-initdb.d:ro" \
  -v "$PWD/drill:/drill" \
  pgvector/pgvector:pg17
```

Every value there is copied from `docker-compose.yml` except the name, the port, and the
absence of a persistent volume. Mounting `packages/db/docker/init` is what establishes the
four extensions, for the reason that file gives: `CREATE EXTENSION` needs privileges the
application role does not have, so it cannot live in a migration.

**Port 5434, not 5433.** The development container is on 5433 and answers to the same
credentials. Pointing a restore at it because the connection string was one character wrong
is a category of accident the compose file already worried about once, in the comment
explaining why it is not on 5432.

**The `--locale=C` line is the one value here that may be wrong.** The compose file pins C
collation deliberately:

> "Deterministic collation. Collation changes silently corrupt text index ordering across a
> version upgrade, which over a twenty-year record (C2) is a genuine and very hard-to-
> diagnose failure."

That is the right choice for development. For a *drill*, the target must match
**production's** collation, whatever it is, or every text index rebuilt during the restore
sorts differently from the one it is meant to reproduce, and the drill quietly validates a
database that is not the one being backed up. Read production's value before creating the
target and use it here:

```sh
psql "$PRODUCTION_DATABASE_URL" -Atc \
  "select datcollate, datctype, datlocprovider from pg_database where datname = current_database();"
```

The local development database returns `C|C|c` **[verified]**. If production returns
anything else, this runbook has found a real divergence between development and production
and that finding belongs in the drill log and probably in an ADR.

Wait for health before touching it:

```sh
docker exec naitikos-restore-target pg_isready -U naitikos -d naitikos
```

### 6.3 Restore

```sh
docker exec naitikos-restore-target \
  pg_restore --username=naitikos --dbname=naitikos \
             --no-owner --no-privileges \
             --single-transaction --exit-on-error \
             /drill/naitikos-YYYY-MM-DD.dump
```

`--single-transaction` with `--exit-on-error` so a failure leaves an empty database rather
than a half-populated one. A partially restored target is worse than a failed restore,
because it will pass some of §7's checks. The cost is that it forecloses parallel restore
(`--jobs`), which matters once the dump is large; when it does, drop `--single-transaction`,
keep `--exit-on-error`, and treat any error as a signal to destroy the container and start
again rather than to patch forward.

Expect noise about extensions and roles even so. §8 lists which lines are ignorable.

### 6.4 Bring the schema to head

A backup taken before the last deployment predates the current migration head. That is
normal and is precisely the scenario the drill exists to rehearse, because it is what a real
recovery looks like.

```sh
export DATABASE_URL='postgresql://naitikos:naitikos@localhost:5434/naitikos'
pnpm db:migrate
```

`packages/db/src/migrate.ts` prints the target it is about to touch before doing anything —
`Migrating <database> at <host>:<port>` — then `Migrations applied.` on success, and exits
non-zero on failure. **Read the first line.** It exists specifically so that a migration
aimed at the wrong database is visible before it lands, and in a drill it is the last
opportunity to notice `5433`.

Note what §5.15 requires and this preserves: migrations are "a discrete, gated step before
deployment — never automatically on boot". The restore does not migrate itself, and neither
does the application.

### 6.5 The media side

There is no scripted storage restore, and pretending otherwise would be the worst thing this
document could do.

What the drill can honestly cover today:

1. **Confirm the recovery code is locatable and legible.** Physical check. Without it the
   sensitive tier is unrecoverable regardless of what happened to the bytes, and this is
   the cheapest high-value step in the entire drill.
2. **Count what would need to come back.** Against the restored clone:
   ```sh
   docker exec naitikos-restore-target psql -U naitikos -d naitikos -Atc \
     "select tier, count(*), count(*) filter (where deleted_at is not null) as tombstoned,
             sum(byte_size) as bytes
        from media_object group by tier order by tier;"
   ```
   Tombstoned rows are included deliberately: [media.md](../media.md) §10 keeps their bytes,
   so they are part of what a storage restore owes.
3. **Spot-check that the objects exist in the source buckets** for a sample of rows,
   including at least one `sensitive` row and one tombstoned row, using the storage adapter
   or the Supabase dashboard. This tests the *pointer*, not the restore, and that limitation
   should be stated in the log rather than glossed.
4. **Round-trip one object.** Fetch one `sensitive` object's ciphertext, unwrap its
   `wrapped_key` with the passphrase, decrypt, and confirm the plaintext hash matches. The
   procedure for doing this without the application is written into every export as
   `decrypt.md`, generated by `packages/core/src/export/bundle.ts` — which makes §9's export
   the practical vehicle for this step.

What the drill cannot cover: an actual bucket-to-bucket restore into a scratch storage
target. §5.15's exit plan calls for "`pg_dump` + storage sync + `docker compose up`" and the
storage-sync half has no implementation and no runbook. **That is an open gap, and it should
be recorded as one in every drill log until it is closed** rather than quietly omitted from
the checklist.

---

## 7. Verification

"It restored without errors" is not verification. `pg_restore` exiting zero means the SQL
in the archive executed; it says nothing about whether the *posture* of the database
survived, and the two most dangerous losses — RLS and the migration ledger — produce no
error at all.

Each check below states its tag. The queries themselves are **[verified]** — they were run
against the local development database and the values in the "local value" column are what
came back on 7 September 2026. Applying them to a restored clone is **[derived]**, because
no clone has ever existed.

Point a shell at the target first:

```sh
alias tgt='docker exec naitikos-restore-target psql -U naitikos -d naitikos -Atc'
```

### 7.1 The migration ledger [verified query]

```sql
select count(*), max(created_at) from drizzle.__drizzle_migrations;
```

Local value: `18|1788668597473`. Compare against `packages/db/migrations/meta/_journal.json`,
whose last entry is `idx: 17`, `tag: "0017_ask_threads"`, `when: 1788668597473`. Eighteen
migrations, `0000` through `0017`, and the timestamps line up.

This is the first check because it is the one that decides whether every subsequent check is
meaningful. A ledger with fewer rows than the journal means the dump predates the current
head and §6.4 has not been run or did not finish. A ledger that is *absent* means the dump
lost the `drizzle` schema — see §8.

### 7.2 Extensions [verified query]

```sql
select extname, extversion from pg_extension order by extname;
```

Local value: `btree_gist 1.7`, `pg_trgm 1.6`, `pgcrypto 1.3`, `plpgsql 1.0`, `vector 0.8.6`.
All four non-default extensions are load-bearing, and `packages/db/docker/init` names what
each one is for: `vector` for the HNSW index (§9.6), `pg_trgm` for typo-tolerant lookup,
`pgcrypto` for content hashing in the audit trail, `btree_gist` for the medication-schedule
exclusion constraint that a btree index cannot express.

### 7.3 RLS — the check most likely to fail silently [verified query]

§5.4 makes RLS defence in depth, and `rls.test.ts` states the exact posture: enabled on
every table, `FORCE`d so the owner is not exempt, and **zero policies**, because RLS with no
policy denies everything and §5.4 forbids the client-direct path entirely.

A restore that loses any of the three is a security regression with no symptom. The anon key
ships in a browser bundle; the only thing standing between it and the record is this.

```sql
select c.relkind,
       count(*),
       count(*) filter (where c.relrowsecurity)      as enabled,
       count(*) filter (where c.relforcerowsecurity) as forced
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind in ('r','p')
 group by 1;

select count(*) from pg_policies where schemaname = 'public';
```

Local values: `r|107|107|107`, `p|1|1|1`, and `0` policies. The three counts on each row
must be equal, and the policy count must be zero.

`relkind in ('r','p')` is not incidental. `rls.test.ts`'s own header records that until the
predicate was widened, the partitioned `sample` parent was invisible to every assertion and
"the suite would have passed with RLS off on the largest table in the schema".

Then run the suite itself, which adds the behavioural proof a catalogue query cannot give —
a role holding an explicit `GRANT SELECT` still reads zero rows:

```sh
export DATABASE_URL='postgresql://naitikos:naitikos@localhost:5434/naitikos'
pnpm --filter @naitikos/db test
```

**Two traps here, both [verified] from the source.**

First, both `rls.test.ts` and `invariants.test.ts` open with
`describe.skipIf(client === undefined)`, where `client` is undefined when `DATABASE_URL` is
unset — and **nothing in this repository loads `.env`** (§5), so the variable is unset unless
you exported it in this shell. What happens then depends on how you invoke the suite, and the
difference is the whole trap:

| Invocation | Without `DATABASE_URL` | Exit code |
|---|---|---|
| `pnpm --filter @naitikos/db test` (whole suite) | 13 files fail, 11 skip, 118 tests skipped | **1** — fails loudly |
| `npx vitest run src/schema/rls.test.ts` (one file) | `1 skipped`, `5 skipped` | **0** — passes silently |

Both measured on 7 September 2026. The whole suite is safe: the thirteen repository suites
construct a client eagerly and blow up, so a forgotten `export` cannot be missed.

**The single-file form is not, and it is the dangerous one here**, because the natural thing
to do when verifying one property of a restore is to run the one file that tests it. That
command exits 0 having examined nothing. RLS is the property most likely to be lost in a
restore and least likely to be noticed — a drill that "confirmed" it this way confirmed
nothing.

So: run the whole suite, and **read the reported test count rather than the exit code**. Five
RLS assertions and sixteen invariant assertions should run. `0 passed` alongside a green tick
is the failure this paragraph exists to prevent.

Second, `turbo.json` declares `DATABASE_URL` in the `test` task's `env` list, so a changed
URL busts the cache — but `pnpm verify` and `pnpm test` go through Turbo and a cached result
from an earlier identical invocation is a possibility worth eliminating. The
`--filter @naitikos/db` form above invokes `vitest run` in that package; if you use the
Turbo path instead, force it.

### 7.4 Database invariants [verified query]

The same suite runs `packages/db/src/schema/invariants.test.ts`, which covers the rules
TypeScript cannot express: `observation` rejects `UPDATE` and `DELETE` but permits
supersession; an unregistered metric key is refused; a half-specified polymorphic subject is
refused; numerics survive the round trip as strings; overlapping medication schedules are
excluded; the crisis plan and journal entries cannot be placed in a broad AI consent scope;
a sensitive-tier `media_object` without a `wrapped_key` is refused; `profile` is a singleton.

Every one of those is a database-enforced rule that a restore could plausibly drop — a
trigger not recreated, a check constraint lost with a `--data-only` restore — and every one
of them, if dropped, corrupts the record silently rather than loudly. The suite wraps each
test in `BEGIN`/`ROLLBACK`, so it leaves the target as it found it.

Confirm the append-only trigger directly as well, because it is the single most important
one and it is cheap:

```sql
select tgname, tgenabled from pg_trigger
 where tgrelid = 'observation'::regclass and not tgisinternal;
```

Local value: `observation_append_only|O`. `O` means enabled in origin mode. A trigger
present but `D`isabled is the exact state `packages/db/src/testing/reset.ts` puts it in
temporarily, and a restore that captured a database mid-test-run — or a hand-run reset that
died between statements — would leave it that way.

### 7.5 Row counts, and the one table where the count is a proof [verified query]

```sql
select 'observation' t, count(*) from observation
union all select 'audit_log',      count(*) from audit_log
union all select 'domain_event',   count(*) from domain_event
union all select 'sample',         count(*) from sample
union all select 'media_object',   count(*) from media_object
union all select 'metric',         count(*) from metric
order by 1;
```

Local values today are `observation` 0, `audit_log` 0, `domain_event` 0, `sample` 0,
`media_object` 0, `metric` 68 — a development database with a seeded registry and no record
in it. On a production clone these must be compared against the same query run read-only
against production, allowing for rows written between the backup's timestamp and the
comparison.

**`observation` is special, and it is the closest thing this system has to a tamper-evident
seal.** §9.1 makes it append-only and migration `0001_observation_immutable` enforces it
with a trigger that raises on `DELETE` and on any `UPDATE` outside the three supersession
columns. Therefore **the count is monotonically non-decreasing, forever.** A restored count
lower than the count recorded in the previous quarter's drill log is not explained by
timing, by corrections, or by deletions — corrections are additive and deletions are
impossible. It is evidence of loss, and it is the reason §10 asks for the count to be
written down every quarter.

`audit_log` has the same property for a different reason. §9.4: "append-only and permanent
… Never pruned. It is … the recovery mechanism of last resort." Confirmed against
`packages/core/src/jobs/registry.ts`: the nightly step list contains `prune-idempotency`
and `prune-telemetry` and nothing that touches `audit_log`. So:

```sql
select min(occurred_at), max(occurred_at), count(*) from audit_log;
```

The `min` must not move forward between drills. If it does, something is pruning the audit
log, and finding out what is more urgent than finishing the drill.

### 7.6 Partitions [verified query]

§9.7 splits device samples out of the human record and requires `sample` to be
"monthly-partitioned". Migration `0015_sample_partitioning` implements that, and the
`maintain-partitions` step in `packages/core/src/jobs/registry.ts` keeps a month ahead
available — deliberately ordered before `downsample-samples`, because creating a partition
takes an `ACCESS EXCLUSIVE` lock on the parent and taking it behind a bulk delete is how a
nightly run stalls.

```sql
select c.relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and (c.relname = 'sample' or c.relname like 'sample\_%')
   and c.relkind in ('r','p')
 order by 1;

select to_regproc('ensure_sample_partition');
```

Locally the parent is `p`, `sample_default` exists, and partitions exist for `2026_09`,
`2026_10`, `2027_03` and `2027_04` — all with RLS enabled and forced. Three things must
hold on a clone:

- the parent is `relkind = 'p'`, not `'r'`. If it is `'r'`, migration 0015 did not apply,
  and if it did not apply against a populated `sample` it raised rather than dropping data —
  which is the migration working as designed (§8).
- `sample_default` exists. Without it, one wearable row with a 1970 epoch artefact fails an
  entire import batch.
- partitions exist for the current month and the next, and the `ensure_sample_partition`
  function is present. The function applies `ENABLE`/`FORCE ROW LEVEL SECURITY` to each
  partition as it creates it, which is why §7.3's check covers partitions at all.

### 7.7 Indexes, generated columns, and types [verified query]

```sql
select am.amname, count(*)
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  join pg_am am on am.oid = c.relam
 where n.nspname = 'public' and c.relkind = 'i'
 group by 1 order by 1;

select indexname from pg_indexes
 where schemaname = 'public' and indexdef ilike '%hnsw%';

select count(*) from information_schema.columns
 where table_schema = 'public' and is_generated = 'ALWAYS';

select count(distinct t.typname) from pg_type t
  join pg_namespace n on n.oid = t.typnamespace
 where n.nspname = 'public' and t.typtype = 'e';
```

Local values: `btree 299`, `gin 20`, `gist 1`, `hnsw 1`; the HNSW index is
`embedding_hnsw_idx`, created in `0000_init.sql` on `embedding` using
`vector_cosine_ops`; 16 generated columns, all `search_vector`; 68 enum types.

The counts are a coarse instrument and will move as the schema grows — record them each
quarter rather than treating today's numbers as constants. What is not coarse: **the HNSW
index either exists or it does not**, and if it does not, either pgvector is missing or the
index failed to build, and semantic search is silently degraded to nothing.

The 16 `search_vector` columns are generated, so `pg_dump` does not carry their data and
Postgres recomputes them on insert. That is fine, and it is also why full-text ordering is a
collation question: the GIN indexes are rebuilt in the target under the target's locale.

### 7.8 The sequence [verified query]

```sql
select sequencename, last_value from pg_sequences where schemaname = 'public';
```

There is exactly one — `domain_event_sequence_seq`, backing `domain_event.sequence`.
Locally `last_value` is null, because no event has ever been written here.

This matters in one specific failure: a `--data-only` restore does not reset sequences, and
a sequence left behind its table's maximum makes the next domain event collide. Assert it
explicitly:

```sql
select (select coalesce(max(sequence), 0) from domain_event) as max_seq,
       (select last_value from pg_sequences
         where schemaname = 'public' and sequencename = 'domain_event_sequence_seq') as seq;
```

`seq` must be greater than or equal to `max_seq`.

### 7.9 Optional: boot the application against the clone [derived]

`pnpm verify` runs `typecheck lint test build` and does not need a database for most of it.
Pointing the running application at the clone and opening the timeline is a better final
check than any query, because it exercises the repositories rather than the catalogue. It
requires the full server environment — `AUTH_ALLOWLIST`, `SUPABASE_SERVICE_ROLE_KEY` and the
three `NEXT_PUBLIC_*` values validated in `apps/web/lib/env.ts` — of which `.env.example`
currently documents only `DATABASE_URL`. Budget time for that or skip the step knowingly.

---

## 8. When it goes wrong [derived]

| Symptom | Cause | What to do |
|---|---|---|
| `type "vector" does not exist`, or the HNSW index fails to create | pgvector absent in the target | The target must be `pgvector/pgvector:pg17` with `packages/db/docker/init` mounted. `CREATE EXTENSION` needs superuser, which is why it is not a migration. |
| `pg_restore: unsupported version` / server version complaints | Client or server major mismatch | Use the pinned image for both. `docker-compose.yml` pins pg17 because Supabase's current major is 17. |
| Text sorts differently; a `like`/`order by` result differs from production | `datcollate` mismatch between production and the target | Recreate the target with production's locale (§6.2). Do not "fix" it by reindexing. |
| Ledger row count is below `_journal.json`'s last `idx + 1` | Dump predates the current head | Run `pnpm db:migrate` (§6.4). This is the expected case, not an error. |
| `drizzle.__drizzle_migrations` does not exist; `pnpm db:migrate` tries to apply `0000` | Dump was restricted to the `public` schema | Re-dump without the schema restriction. Do not let `0000` run. |
| `role "anon" does not exist`, `role "authenticated" does not exist` | Roles are cluster-level and not in a per-database `pg_dump` | Ignorable here. Migration 0015's revoke block is already guarded by `IF EXISTS (SELECT 1 FROM pg_roles …)`. |
| `sample holds N rows; partitioning requires recreating the table…` | Migration 0015 met a populated, unpartitioned `sample` | **Do not force it.** The exception is the guard working. Establish why the dump has unpartitioned device data and handle those rows deliberately. |
| RLS check lists table names | RLS lost, or a table created after the restore | Every listed name is exposed over the PostgREST path. Treat as a security finding, not a test failure. |
| `pg_policies` returns rows | A policy was introduced | `rls.test.ts`: "A policy appearing here is not a test failure to be patched; it is an architectural change requiring an ADR." |
| Test run is green but reports skipped suites | `DATABASE_URL` not exported | Nothing loads `.env`. Export it and re-run; a skipped suite proved nothing. |
| Migration output names the wrong host or port | `DATABASE_URL` still pointing at 5433 | `migrate.ts` prints the target first precisely so this is catchable. Stop. |
| Restore left a half-populated database | `--single-transaction` omitted and an error occurred | Destroy the container and start again. Do not patch forward. |

Three of these deserve more than a table row.

**The ledger is the sharpest edge in this procedure.** `drizzle.__drizzle_migrations` lives
in the `drizzle` schema, not `public` — verified. Anyone reasoning that "the application's
data is in `public`" will produce a dump that restores every table and loses the record of
which migrations built them. The next `pnpm db:migrate` then believes the database is empty
and starts at `0000_init.sql`, which will fail on objects that already exist — noisily, and
therefore recoverably. The dangerous variant is a *data-only* restore into a
freshly-migrated target, where the ledger is correct, the schema is correct, and constraint
definitions or triggers may not be. Prefer a full restore into an empty database.

**Major-version drift is a decision, not an accident.** The compose file:

> "pgvector publishes a pg18 image, but production is Supabase-hosted (§5.15) and Supabase's
> current major is 17. Running 18 locally against 17 in production would reintroduce
> precisely the drift the section above refuses to accept. When Supabase moves, this moves."

A drill run against pg18 because that is what was on the machine tests a restore into a
database that does not exist anywhere. When Supabase does move, the drill is the right place
to rehearse it — deliberately, once, with the version change recorded in the log — and
`docker-compose.yml` changes in the same commit.

**Collation is the failure that does not announce itself.** The compose comment calls it
"a genuine and very hard-to-diagnose failure" over a twenty-year record, and it is right.
Nothing errors. A btree index on text built under one locale and queried under the
expectation of another returns wrong rows for range predicates and wrong order for sorts,
and the symptom surfaces years later as a chart that skips an entry. The only defence is to
compare `datcollate`, `datctype` and `datlocprovider` between source and target before
trusting anything the target says — which is why it is a step in §6.2 rather than a footnote
here.

---

## 9. The other half of the drill: the export

A restore proves the system can come back. **The export proves the data survives the system
dying**, which is the stronger property and the one P2 actually obliges. §9.10 pairs them
explicitly: "A quarterly drill re-imports an export into a scratch database and asserts
row-count and checksum equality — the same discipline as the backup restore drill, for the
same reason." They are one quarterly exercise, not two.

The format, its contents, and why it is shaped the way it is are in
[export.md](../export.md) and are not restated here. What the drill does with it:

1. **Produce an export from the restored clone**, not from production. `GET /api/export`
   requires the `export:execute` permission, which is in `STEP_UP_PERMISSIONS`, so a session
   older than fifteen minutes is refused — re-authenticate rather than concluding the
   endpoint is broken.
2. **Verify the manifest without unzipping.** The bundle returns its manifest alongside the
   bytes and on the `X-Export-Manifest` response header, because — export.md's phrasing — "a
   checksum that only exists inside the thing it is checking is not a check". Compare
   `manifest.totalRows` and each table's `rows` against §7.5's counts taken from the same
   clone. They must match exactly; both readings come from the same database at the same
   time, so any divergence is a bug in the export, not a timing artefact.
3. **Check the per-table `crc32` values.** The bundle is a pure function of its input and
   therefore deterministic, so two exports of an unchanged clone are byte-identical. That is
   what makes a checksum comparison meaningful at all, and it is worth exercising once by
   exporting twice.
4. **Confirm the self-describing parts are present and non-empty**: `README.md`,
   `schema.json`, `metrics.json`, `decrypt.md`, `medical-timeline.md`. §9.10's first
   property is that "someone in 2046 with the archive and no application can understand it",
   and the only way to keep that true is to read the README as a stranger would, once a
   quarter, and notice the year it stops making sense.
5. **Exercise `decrypt.md` against one real object** — §6.5, step 4. §9.10 is unambiguous:
   "Encrypted media that can only be read by an application that no longer runs is not
   exported data." That claim is tested here or nowhere.

**Two honest limitations.** `/api/export` sends `media: []` — the format supports media
fully, but streaming gigabytes through a serverless response is the wrong shape, so the
monthly job with a filesystem is where media belongs and that job is not built. And §9.10's
"re-imports an export into a scratch database" cannot be performed: there is no importer.
Export is an exit, not a round trip, and `/settings/data` says so deliberately — "an
importer that rebuilt the database from one would be a second write path around every
constraint the schema exists to enforce". So the export half of this drill is currently
*verify the archive*, not *reload it*, and the log should say which was done.

---

## 10. Recording the drill

`/settings/data` refuses to display a last-drill date, and the reason is in the comment
beside it: a button or a badge there "would make it look like one had been done". That
restraint is correct and it leaves an obligation — the record has to live somewhere the
operator will find it in eighteen months.

**Proposal, not established practice:** a single append-only file,
`docs/runbooks/drill-log.md`, one row per drill. **This file does not exist yet.** The first
operator to run this drill should create it, and if a better home emerges, move it and amend
this section.

The proposed columns, chosen so that each one answers a question the *next* drill will ask:

| Column | Why it is there |
|---|---|
| Date of drill | Establishes the quarterly cadence, or its absence |
| Backup artefact timestamp, and how it was obtained | Distinguishes testing the backup from testing `pg_dump` (§6.1) |
| Postgres version and `datcollate` of source and target | The two silent-corruption vectors (§8) |
| Migration head: ledger count and last tag | Whether §6.4 was needed |
| `observation` count | Monotonic. A fall is proof of loss (§7.5) |
| `audit_log` count and `min(occurred_at)` | The `min` must never move forward |
| `media_object` count by tier, and total bytes | The size of the storage gap (§3) |
| RLS: tables / enabled / forced / policies | Four numbers that must read `n / n / n / 0` |
| Export: total rows, and whether the manifest matched | §9 |
| Recovery code located? | Yes or no. Nothing else. |
| Wall-clock time from start to verified | The exit-plan number §5.15 says "should be known, not guessed" |
| Defects found, and where they were filed | The actual output of the drill |

The last row of that table is the point. A drill that finds nothing has either found that
the system is sound or found that the drill is too shallow, and only the log accumulated
over several quarters can tell those apart.

---

## 11. What this runbook does not cover

Stated plainly, because a checklist that quietly omits its gaps is worse than a shorter one.

- **The restore has never been executed.** §2 says it; it bears repeating at the end.
- **There is no storage restore.** §5.15's exit plan is "`pg_dump` + storage sync +
  `docker compose up`", and the middle term has no implementation, no script, and no
  procedure. §6.5 tests the pointers and one object round-trip, which is not the same thing.
- **There is no importer**, so §9.10's re-import comparison cannot be performed (§9).
- **Point-in-time recovery is untested and unspecified.** This document covers restoring a
  backup artefact, not recovering to an arbitrary instant.
- **There is no CI.** `.github/workflows/` exists and is empty, so none of the verification
  suites this runbook leans on are currently run automatically on any commit. That does not
  make the checks in §7 less valid, but it does mean the drill is the *only* time some of
  them run, which raises the stakes on remembering to run it.
- **The other runbooks §6.2 promises — migration, incident, key rotation — do not exist.**
  Key rotation is the conspicuous absence, given that §3 identifies the passphrase as the
  one unrecoverable input in the system.
