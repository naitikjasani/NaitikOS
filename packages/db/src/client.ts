/**
 * The database client.
 *
 * Exported as a factory rather than a ready-made singleton for two reasons.
 *
 * The **`casing` hazard**: both this and `drizzle.config.ts` must agree on
 * `snake_case`, or the query builder emits camelCase identifiers that do not
 * exist in the physical schema. A raw `drizzle()` call elsewhere in the
 * codebase would compile, typecheck, and fail at runtime. Funnelling every
 * client through here removes that failure mode.
 *
 * The **connection-count hazard**: §5.15 hosts on Vercel, where each serverless
 * invocation can open its own pool. `max: 1` plus a module-scoped cache is what
 * keeps that from exhausting Postgres' connection limit — which at n=1 would be
 * an entirely self-inflicted outage.
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { databaseUrl } from './env';
import * as schema from './schema';

export type Database = ReturnType<typeof createDatabase>;

/**
 * A transaction handle, as `db.transaction(async (tx) => …)` supplies it.
 *
 * Structurally *not* a {@link Database}: it has no `$client`, because a
 * transaction does not own the connection it borrows. That distinction is
 * correct and worth keeping, which is why {@link Executor} exists rather than
 * `Database` being widened.
 */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Anything that can run a query — a pooled client or a transaction.
 *
 * **A repository that only runs queries takes this, not `Database`.** One typed
 * to `Database` cannot be handed a `tx`, which means multi-table writes either
 * duplicate their SQL inline or silently escape the transaction. The Daily
 * Close writes observations, a supersession, a medication event and a note as
 * one unit (§5.7 depends on it), so this is load-bearing rather than tidy.
 *
 * **A repository that *opens* a transaction still takes `Database`.** Both
 * members expose `.transaction()` — Drizzle maps the inner one to a SAVEPOINT —
 * but postgres.js does not nest, so calling it on a `tx` fails at runtime.
 * `createDailyCloseRepository` therefore asks for a `Database` and says so in
 * its signature, which is the only place that distinction can be enforced.
 */
export type Executor = Database | Transaction;

type ClientOptions = {
  /**
   * Connections in the pool. Defaults to 1.
   *
   * One is correct for serverless (see above) and for the CLI paths — migrate,
   * seed — which are strictly sequential. Raise it only for a long-lived
   * process that genuinely runs concurrent queries.
   */
  readonly maxConnections?: number;
  /** Log every statement. Development only; statements can contain journal text. */
  readonly debug?: boolean;
};

/**
 * Build a Drizzle client over a postgres.js connection.
 *
 * @param url - connection string; defaults to `DATABASE_URL`.
 */
export function createDatabase(url: string = databaseUrl(), options: ClientOptions = {}) {
  const sql = postgres(url, {
    max: options.maxConnections ?? 1,

    /**
     * Return `numeric` as a string, not a JavaScript number.
     *
     * postgres.js parses `numeric` to `number` by default, which would silently
     * undo §5.3's central guarantee — "No floats for weight, dosage, or lab
     * values. A rounding artifact in a medication dosage is unacceptable." The
     * `numeric` column type is pointless if the driver converts it to a double
     * on the way out.
     */
    types: {
      numeric: {
        to: 1700,
        from: [1700],
        serialize: (x: string) => x,
        parse: (x: string) => x,
      },

      /*
       * Timestamps are deliberately **not** overridden here.
       *
       * Postgres returns `timestamptz` as `2026-08-03 08:00:00+00`, which is not
       * ISO 8601, and normalising it looks like a job for a driver-level parser.
       * It is not, and the reason is worth recording so nobody spends an hour on
       * it twice: `drizzle-orm/postgres-js` overwrites
       * `client.options.parsers` for OIDs 1184, 1082, 1083, 1114, 1182, 1185,
       * 1115, and 1231 with a transparent parser *after* the client is built —
       * intentionally, so that Drizzle's column mode owns the conversion. Any
       * `types` entry for those OIDs is silently discarded.
       *
       * The normalisation therefore lives on the column, in `columns.ts`'s
       * `instant()`, where Drizzle's own `fromDriver` hook runs.
       */
    },

    /**
     * `undefined` in a query parameter becomes SQL NULL.
     *
     * Without it postgres.js throws on an undefined parameter, which turns an
     * optional column left unset into a runtime error rather than a null.
     */
    transform: { undefined: null },

    prepare: false,

    /* Silence NOTICE chatter unless debugging. Spread rather than passing
     * `undefined`, because `exactOptionalPropertyTypes` (tsconfig base) treats
     * an explicit `undefined` as a distinct value from an absent key — and
     * postgres.js reads an absent `onnotice` as "use the default". */
    ...(options.debug === true ? {} : { onnotice: () => undefined }),
  });

  return drizzle(sql, {
    schema,
    casing: 'snake_case',
    logger: options.debug ?? false,
  });
}

/**
 * A process-wide client, created on first use.
 *
 * Safe on Vercel because module scope is per-invocation-container: a warm
 * container reuses the pool, a cold one builds a new single connection.
 */
let cached: Database | undefined;

export function getDatabase(): Database {
  cached ??= createDatabase();
  return cached;
}

export { schema };
