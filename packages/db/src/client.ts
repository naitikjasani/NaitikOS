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
    },

    /**
     * Never coerce timestamps into `Date`.
     *
     * Same argument as `columns.ts` makes for `mode: 'string'`: a `Date` is a
     * UTC instant with a local-time API attached, and every read through it is
     * a chance to reinterpret an instant in the runtime's zone. `core/temporal`
     * owns interpretation (§11.3).
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
