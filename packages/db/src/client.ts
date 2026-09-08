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
  /**
   * Seconds an unused connection is kept. `0` keeps it for ever.
   *
   * The default closes it before PgBouncer does — see the note in
   * `createDatabase`. The test harness's lock connection passes `0`, because
   * a session-level advisory lock is released the moment its connection dies.
   */
  readonly idleTimeoutSeconds?: number;
  /** Client-side cap on a single statement. `0` disables it. */
  readonly statementTimeoutMs?: number;
};

/**
 * Build a Drizzle client over a postgres.js connection.
 *
 * @param url - connection string; defaults to `DATABASE_URL`.
 */
/**
 * Whether this connection must be encrypted, and why the default is "yes".
 *
 * postgres.js defaults to **no TLS**, and this file passed no `ssl` option at
 * all — which was invisible for a month because the only database anyone
 * connected to was the local container, where there is no TLS to negotiate.
 * The first hosted deployment failed on it: Supabase's pooler requires TLS, so
 * every query from the deployed runtime threw, `/today` streamed its Suspense
 * fallback for ever, and a DB-backed route returned an empty 500.
 *
 * The predicate is deliberately the same shape as the CSRF cookie's `Secure`
 * decision in `apps/web/lib/auth/cookies.ts`: **only an explicitly local host
 * may go unencrypted, and everything else — including anything unparseable —
 * is encrypted.** The asymmetry is the point. A misconfiguration that turns
 * TLS off silently would carry §4.7's medication history and lab results
 * across a network in cleartext, and nothing would look wrong; a
 * misconfiguration that turns it on where it is not supported fails loudly on
 * the first query.
 *
 * An explicit `sslmode` in the connection string wins. postgres.js parses that
 * parameter itself, so returning `undefined` here leaves the operator's stated
 * intent in charge rather than overriding it from two places.
 */
function sslFor(url: string): 'require' | false | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'require';
  }

  if (parsed.searchParams.has('sslmode')) return undefined;

  const host = parsed.hostname.toLowerCase();
  const isLoopback =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '[::1]' ||
    host === '::1' ||
    /^127(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(host) ||
    host === 'host.docker.internal';

  return isLoopback ? false : 'require';
}

export function createDatabase(url: string = databaseUrl(), options: ClientOptions = {}) {
  const ssl = sslFor(url);

  const sql = postgres(url, {
    max: options.maxConnections ?? 1,

    /*
     * The three settings that make a module-scoped client survive a serverless
     * lifecycle, added after production hung on all of them being absent.
     *
     * The symptom was ugly and hard to read backwards: `/today` returned 200,
     * streamed its Suspense fallback, and then logged `responseStatusCode: 0`
     * with `canceling statement due to statement timeout` (57014) and
     * `Node.js process exited with exit status: 128`. The page was blank
     * because the *process died mid-render*, not because the page was wrong.
     *
     * The cause is the interaction this file's header already worries about
     * from the other direction. `max: 1` plus a module-scoped cache keeps the
     * connection count down, and Vercel then **freezes the instance between
     * invocations**. PgBouncer drops the idle server-side connection; the
     * frozen client thaws holding a socket that is no longer attached to
     * anything, issues a query into it, and waits — for the full
     * `statement_timeout`, which on this Supabase project is **two minutes**.
     *
     * - `idle_timeout` closes the connection before the pooler does, so a
     *   thawed instance opens a fresh one instead of inheriting a dead socket.
     * - `connect_timeout` fails fast when the pooler is unreachable, rather
     *   than holding a request open.
     * - `connection.statement_timeout` bounds the wait at the client. Thirty
     *   seconds is far above any query this application issues — the slowest
     *   measured against production is 85 ms — and far below the two minutes
     *   that turned one stale socket into a dead render.
     *
     * Verified against production, not assumed: `show statement_timeout`
     * returns `2min`, and every table read completes in 75–85 ms.
     */
    idle_timeout: options.idleTimeoutSeconds ?? 20,
    connect_timeout: 10,
    connection: { statement_timeout: options.statementTimeoutMs ?? 30_000 },

    /* TLS unless the host is explicitly local. See {@link sslFor}. Spread
     * rather than passing `undefined`, because an explicit `sslmode` in the URL
     * must stay in charge and `exactOptionalPropertyTypes` distinguishes an
     * absent key from an undefined one. */
    ...(ssl === undefined ? {} : { ssl }),

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
