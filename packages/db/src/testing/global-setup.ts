/**
 * One integration suite at a time, per database.
 *
 * ## The failure this exists to remove
 *
 * `reset.ts` clears every domain table between tests. Its `RESET_ORDER` is
 * correct for a *serial* run and has no defence whatsoever against a second
 * process writing between two of its statements. Two `packages/db` runs against
 * the same Postgres therefore destroy each other, and the damage is not subtle:
 * measured on 8 September 2026, two concurrent runs produced **100 and 107
 * failures out of 389**, a different set each time —
 *
 *   - foreign-key violations raised *inside* `resetDomainTables` itself, because
 *     the other process inserted a child row after the child table was cleared
 *     and before the parent was (`auth_identity_profile_id_profile_id_fk`);
 *   - unique violations on `place_name_unique` and `program_one_active`, because
 *     a fixture's "the table is empty" precondition was false;
 *   - empty result sets in tests that had just inserted rows, because the other
 *     process truncated `observation` mid-test.
 *
 * A suite that fails differently every time is a suite that gets ignored, which
 * costs more than the failures do. With the database quiet, the same suite is
 * green 16 runs in a row — so the tests are right and the harness was wrong.
 *
 * ## Why a session-level advisory lock
 *
 * The problem is strictly **cross-process**. `vitest.config.ts` already sets
 * `fileParallelism: false`, so the files inside one run are serial and one run
 * never races itself. Nothing needs to change about how a single run behaves;
 * what is missing is a gate between runs. That is one mutex, in one place.
 *
 * Postgres advisory locks are the right mutex because they live in the same
 * place as the resource they protect. A lockfile on disk would not: CI and a
 * developer machine can reach the same database over the network while sharing
 * no filesystem, and a container that dies leaves the file behind. A
 * **session-level** advisory lock is released by the server when the connection
 * ends — including when the process is killed with SIGKILL, when the container
 * is torn down, and when the network drops — so there is no stale-lock recovery
 * path to get wrong, and none to document.
 *
 * The cost is honest and small: two concurrent runs take twice as long instead
 * of both failing. A single run pays one extra connection and one `SELECT`.
 *
 * ## Why this cannot deadlock against `rollup.repository.ts`
 *
 * That repository takes `pg_advisory_xact_lock(hashtext('metric_rollup'))`
 * inside its transaction, and its test exercises that path. Two reasons the two
 * locks cannot form a cycle:
 *
 *  1. **Different lock spaces.** Postgres tags the one-argument `bigint` form
 *     and the two-argument `(int4, int4)` form distinctly — `pg_locks.objsubid`
 *     is 1 and 2 respectively. This lock uses the two-argument form, so it can
 *     never alias the repository's key no matter what `hashtext` returns.
 *  2. **A strict ordering.** This lock is acquired before any test file loads
 *     and released after the last one finishes. No process can hold the rollup
 *     lock without already holding this one, so the wait-for graph is a chain
 *     rather than a cycle.
 *
 * ## Failing loudly
 *
 * Three ways this can go wrong, and none of them degrades quietly:
 *
 *  - **The database is unreachable.** `setup` throws and the run does not
 *    start. It would have failed anyway; this only moves the message earlier.
 *  - **The wait exceeds {@link WAIT_LIMIT_MS}.** Something is wedged rather
 *    than merely busy. Throwing beats blocking until CI's `timeout-minutes`
 *    kills the job with no explanation.
 *  - **The lock was lost mid-run.** `teardown` releases through
 *    `pg_advisory_unlock`, which returns `false` if this session was not
 *    holding it — the signature of a dropped-and-silently-reconnected
 *    connection, which would mean the isolation was not actually in force.
 *    That turns a green run whose guarantee had evaporated into a red one.
 *
 * `DATABASE_URL` unset is the one case that is not an error: the suites open
 * with `describe.skipIf(client === undefined)` and touch no database, so there
 * is nothing to serialise. CI has a separate step that makes those skips fatal.
 */

import { setTimeout as delay } from 'node:timers/promises';
import postgres from 'postgres';

/**
 * The mutex identity, hashed to the `(int4, int4)` advisory key pair.
 *
 * Written out rather than reduced to a magic number so that the name shows up
 * in `hashtext` calls and in this file's own grep results. Keyed on the
 * *suite*, not on a table: `resetDomainTables` clears well over a hundred
 * tables and a finer-grained lock would be a false economy.
 *
 * `hashtext` is not stable across Postgres major versions, which does not
 * matter here — every participant contending for this lock is talking to the
 * same server, and the key is never persisted.
 */
const LOCK_NAME = 'naitikos:db:integration-suite';

/** Second half of the key pair. Reserved for a future partition of the suite. */
const LOCK_KEY_SUBSPACE = 0;

/** Marks the lock-holding connection in `pg_stat_activity`, for the wait message. */
const APPLICATION_NAME = 'naitikos-db-integration-lock';

const POLL_INTERVAL_MS = 200;

/**
 * How long to wait for the other run before giving up.
 *
 * Comfortably above a full suite (~28s locally) plus migrations, and below
 * CI's 20-minute job timeout so this failure is reported by this file, with its
 * own message, rather than by a killed job with none.
 */
const WAIT_LIMIT_MS = 300_000;

/**
 * The connection holding the lock, kept alive for the life of the process.
 *
 * Module scope is safe: Vitest runs `globalSetup` and its teardown in the same
 * module instance in the main process.
 */
let holder: postgres.Sql | undefined;

type Acquired = { readonly acquired: boolean };
type Released = { readonly released: boolean };
type Blocker = { readonly pid: number };

/**
 * Open the lock connection.
 *
 * `idle_timeout: 0` and `max_lifetime: null` are load-bearing, not tidying.
 * postgres.js recycles a connection after 30–60 minutes by default, and a
 * recycled connection is a *new session* — which would drop this lock silently,
 * partway through a long run, leaving the suite exposed with no signal.
 */
function openHolder(url: string): postgres.Sql {
  return postgres(url, {
    max: 1,
    idle_timeout: 0,
    max_lifetime: null,
    connection: { application_name: APPLICATION_NAME },
    onnotice: () => undefined,
  });
}

/** True if this session now holds the lock; false if someone else does. */
async function tryAcquire(sql: postgres.Sql): Promise<boolean> {
  const rows = await sql<Acquired[]>`
    SELECT pg_try_advisory_lock(hashtext(${LOCK_NAME}), ${LOCK_KEY_SUBSPACE}) AS acquired`;
  return rows[0]?.acquired === true;
}

/**
 * Backend pids of the other test runs waiting on or holding this lock.
 *
 * Best-effort: purely for the "who is in front of me" message, so any failure
 * here is swallowed rather than allowed to mask the real wait.
 */
async function blockingPids(sql: postgres.Sql): Promise<readonly number[]> {
  try {
    const rows = await sql<Blocker[]>`
      SELECT pid FROM pg_stat_activity
       WHERE application_name = ${APPLICATION_NAME} AND pid <> pg_backend_pid()
       ORDER BY pid`;
    return rows.map((row) => row.pid);
  } catch {
    return [];
  }
}

/**
 * Take the suite-wide lock, waiting for any run already in progress.
 *
 * Writes to stderr rather than stdout so the wait notice cannot be mistaken for
 * reporter output, and directly rather than through `console` — §5.13 bans
 * `console` in package source, and this is a harness rather than a place that
 * should own a structured logger.
 */
export async function setup(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url === '') return;

  const sql = openHolder(url);

  let announced = false;
  const startedAt = performance.now();

  try {
    for (;;) {
      if (await tryAcquire(sql)) {
        if (announced) {
          const waited = Math.round((performance.now() - startedAt) / 1000);
          process.stderr.write(`[db] lock acquired after ${String(waited)}s.\n`);
        }
        holder = sql;
        return;
      }

      if (!announced) {
        announced = true;
        const pids = await blockingPids(sql);
        const who = pids.length === 0 ? 'another process' : `backend pid ${pids.join(', ')}`;
        process.stderr.write(
          `[db] Another integration run holds this database (${who}). Waiting — ` +
            `the suite truncates shared tables, so the two cannot interleave.\n`,
        );
      }

      if (performance.now() - startedAt > WAIT_LIMIT_MS) {
        const waited = Math.round(WAIT_LIMIT_MS / 1000);
        throw new Error(
          `Waited ${String(waited)}s for the @naitikos/db integration lock and never got it. ` +
            `Another run is wedged rather than merely busy. Find it with:\n` +
            `  select pid, state, query_start from pg_stat_activity ` +
            `where application_name = '${APPLICATION_NAME}';\n` +
            `The lock is session-scoped, so terminating that backend releases it.`,
        );
      }

      await delay(POLL_INTERVAL_MS);
    }
  } catch (cause) {
    await sql.end({ timeout: 5 }).catch(() => undefined);
    holder = undefined;
    throw cause;
  }
}

/**
 * Release the lock, and prove it was still held.
 *
 * Ending the connection alone would release it. The explicit unlock exists for
 * its *return value*: `false` means this session was not holding the lock, so
 * the run was not actually isolated and its green result should not be trusted.
 */
export async function teardown(): Promise<void> {
  const sql = holder;
  if (sql === undefined) return;
  holder = undefined;

  try {
    const rows = await sql<Released[]>`
      SELECT pg_advisory_unlock(hashtext(${LOCK_NAME}), ${LOCK_KEY_SUBSPACE}) AS released`;
    if (rows[0]?.released !== true) {
      throw new Error(
        'The @naitikos/db integration lock was not held at teardown. The lock connection was ' +
          'dropped and silently re-established, so this run was not isolated from other runs ' +
          'and any pass or failure in it is unreliable. Re-run it.',
      );
    }
  } finally {
    await sql.end({ timeout: 5 }).catch(() => undefined);
  }
}
