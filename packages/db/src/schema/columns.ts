/**
 * Column primitives shared by every table.
 *
 * Blueprint §5.3 fixes four physical conventions, and they are implemented here
 * exactly once so no table can quietly deviate:
 *
 *   | Concern  | Rule                                                        |
 *   |----------|-------------------------------------------------------------|
 *   | Time     | `timestamptz` exclusively, stored UTC, IANA zone alongside  |
 *   | Numerics | `numeric` for anything measured — never a float             |
 *   | IDs      | UUIDv7, client-generatable                                  |
 *   | Money    | Integer minor units plus an ISO-4217 code — never a float   |
 *
 * ## A note on column naming
 *
 * These helpers declare no explicit SQL column names. Both drizzle.config.ts
 * and {@link createDatabase} set `casing: 'snake_case'`, which maps camelCase
 * properties to snake_case columns at generate time and at query time. The
 * physical names are then frozen into the committed migration SQL (§9.4), so
 * the convention is a build-time convenience rather than a runtime dependency.
 *
 * The one hazard worth knowing: a `drizzle()` call that omits `casing` will
 * build queries against camelCase columns that do not exist. That is why the
 * package exports a client factory rather than the raw constructor.
 */

import { sql } from 'drizzle-orm';
import { bigint, customType, integer, numeric, text, uuid } from 'drizzle-orm/pg-core';
import { parseSqlTimestamp } from '@naitikos/core';

/* -------------------------------------------------------------------------
 * Identity
 * ---------------------------------------------------------------------- */

/**
 * Primary key. UUIDv7, supplied by the application — **never defaulted in SQL.**
 *
 * Blueprint §5.7 makes this structural rather than stylistic:
 *
 *   "Client-generated UUIDv7 IDs. A record created offline has its permanent
 *    identity from the moment it exists. No temporary IDs, no re-keying, no
 *    reconciliation of references."
 *
 * A database-side default would defeat that: a row created in a gym basement
 * has to carry its final ID from the moment it is written to the outbox, hours
 * before Postgres ever sees it. Generate with `uuidV7()` from `@naitikos/shared`.
 *
 * Postgres 18 ships a native `uuidv7()`, which would be a tempting default once
 * production moves. Resist it — the offline path still needs the client value,
 * and two sources of identity is worse than one.
 */
export const primaryKey = () => uuid().primaryKey();

/** Foreign-key column pointing at another table's {@link primaryKey}. */
export const reference = () => uuid();

/* -------------------------------------------------------------------------
 * Time
 * ---------------------------------------------------------------------- */

/**
 * A point in time. Always `timestamptz`, always read back as an ISO 8601 string.
 *
 * A string rather than a `Date`, deliberately. A JavaScript `Date` is a UTC
 * instant with a local-time API bolted on; every read through it is an
 * opportunity to silently reinterpret an instant in the runtime's zone. Over a
 * twenty-year record (C2) that is a slow corruption with no error message.
 * Strings cross the boundary losslessly, and `core/temporal` owns all
 * interpretation — which is what §11.3 asks for.
 *
 * ## Why this is a customType rather than `timestamp({ mode: 'string' })`
 *
 * Because `mode: 'string'` returns **Postgres's text format, not ISO 8601** —
 * `2026-08-03 08:00:00+00`, with a space instead of `T`, microseconds, and a
 * two-digit offset that `Date` refuses to parse. The sentence above was simply
 * false until this was written, and the milestone-4 integration tests are what
 * caught it.
 *
 * It matters because timestamps get compared as strings: an ISO string the
 * application just built sorts *after* a read-back Postgres one for the same
 * instant, since `'T'` (0x54) > `' '` (0x20). Mixed comparisons therefore order
 * wrongly, and nothing errors.
 *
 * The obvious fix — a postgres.js `types` override — does not work, and the
 * reason is worth recording so nobody tries it twice: `drizzle-orm/postgres-js`
 * overwrites `client.options.parsers` for every date and timestamp OID with a
 * transparent parser *after* the client is constructed, precisely so that column
 * mode controls conversion. A driver-level override is silently discarded.
 *
 * So the normalisation lives here, on the column, where Drizzle's own
 * `fromDriver` hook runs.
 *
 * Note the consequence for call sites: a `customType` has no `.defaultNow()`
 * helper. Write `.default(sql`now()`)`, which emits identical SQL.
 */
export const instant = customType<{ data: string; driverData: string }>({
  dataType: () => 'timestamp with time zone',
  fromDriver: (value: string) => parseSqlTimestamp(value) ?? value,
  // Identity: Postgres accepts ISO 8601 directly, and reformatting on the way in
  // would be an opportunity to lose the offset.
  toDriver: (value: string) => value,
});

/**
 * The IANA zone an instant was captured in — `Asia/Kolkata`, `Europe/London`.
 *
 * §5.3 is emphatic that this is not redundant with the UTC timestamp:
 *
 *   "A workout at '7am' during travel is a materially different fact from one
 *    at 7am at home, and discarding the zone destroys information you cannot
 *    recover."
 *
 * The offset alone is insufficient — `+05:30` does not tell you the rule that
 * produced it, and rules change. Store the zone name.
 */
export const ianaZone = () => text();

/**
 * `created_at` / `updated_at`, defaulted server-side.
 *
 * These describe the *row*, not the fact. When a fact happened is `observedAt`
 * or a validity interval; when the database learned about it is here. §9.5
 * turns on that distinction, and conflating the two produces a record that
 * quietly lies about what was known when.
 */
export const rowTimestamps = {
  createdAt: instant().notNull().default(sql`now()`),
  updatedAt: instant().notNull().default(sql`now()`),
};

/* -------------------------------------------------------------------------
 * Soft deletion and versioning (§9.4)
 * ---------------------------------------------------------------------- */

/**
 * Tombstone columns. Nothing in this system is hard-deleted.
 *
 * §9.4 gives three reasons, and the third is the one that is easy to miss:
 * undo becomes trivial; deletes replicate through the offline outbox as
 * ordinary state transitions rather than as absences; and referential integrity
 * across twenty years survives something being removed from view.
 *
 * Every hot-path query must filter `deletedAt IS NULL`, and §9.6 specifies
 * partial indexes so tombstones are excluded from the index rather than merely
 * from the result.
 */
export const softDelete = {
  deletedAt: instant(),
  /** Why it was deleted. A tombstone without a reason is a mystery in year six. */
  deleteReason: text(),
};

/**
 * Optimistic-concurrency version, incremented on every write.
 *
 * §9.4 chooses row-level versioning over shadow history tables: the prior state
 * is already in `audit_log`, and "one mechanism is better than two". This column
 * exists so a stale write — the classic case being a phone that was offline for
 * a week — is detected rather than silently applied.
 */
export const version = () => integer().notNull().default(1);

/**
 * The full column set for a **mutable entity** (§9.1, right-hand column).
 *
 * Entities are the vocabulary the record is written in: an exercise, a
 * medication, a product. They change, they version, and they can be retired.
 * Observations get {@link observationIdentity} instead — they are immutable and
 * must never acquire a `deletedAt`.
 */
export const entityColumns = {
  id: primaryKey(),
  ...rowTimestamps,
  version: version(),
  ...softDelete,
};

/* -------------------------------------------------------------------------
 * Measurement
 * ---------------------------------------------------------------------- */

/**
 * A measured quantity. `numeric`, read and written as a string.
 *
 * §5.3: "No floats for weight, dosage, or lab values. A rounding artifact in a
 * medication dosage is unacceptable."
 *
 * Drizzle's default string mode is what preserves that guarantee end to end —
 * parsing to a JS `number` at the driver boundary would reintroduce binary
 * floating point and make the `numeric` column decorative. Arithmetic belongs
 * in `core`, on a decimal representation.
 *
 * Precision 20 / scale 6 spans everything the system measures, from a 0.5 µg
 * vitamin D dose to a 500 kg deadlift, with room left over.
 */
export const quantity = () => numeric({ precision: 20, scale: 6 });

/**
 * Money. Integer minor units plus an ISO-4217 code (§5.3).
 *
 * 1250 + 'INR' is ₹12.50. Never a float, and never an amount without its
 * currency — a bare number is not a monetary value, and a twenty-year record
 * will outlive at least one relocation.
 */
export const money = () => ({
  amountMinor: bigint({ mode: 'bigint' }),
  currency: text(),
});

/**
 * A 0–1 confidence score, used wherever the system records how much it trusts a
 * value: derived observations, model extractions, insight findings.
 *
 * §9.3 requires that a derived value stay distinguishable from a measured one
 * forever. Confidence is half of that; `observation_source` is the other half.
 */
export const confidence = () => numeric({ precision: 5, scale: 4 });

/* -------------------------------------------------------------------------
 * Search
 * ---------------------------------------------------------------------- */

/**
 * The `tsvector` type. Drizzle has no built-in for it, so it is declared once
 * here rather than reached for with raw SQL at each call site.
 */
export const tsvector = customType<{ data: string; driverData: string }>({
  dataType: () => 'tsvector',
});

/**
 * A generated `tsvector` over one or more text columns, for §9.6's GIN index —
 * "full-text over journal and documents".
 *
 * Generated rather than trigger-maintained: the column cannot drift out of sync
 * with its source, because Postgres recomputes it on write. One fewer invariant
 * to hold by hand over twenty years (C3).
 *
 * `'english'` is pinned as the text-search configuration rather than left to
 * `default_text_search_config`, which is a server setting. A search index whose
 * stemming silently changes when the database is restored onto a differently
 * configured host is a genuinely confusing failure.
 *
 * @param columns - source columns in their physical snake_case form, since this
 *   expression is emitted into SQL where the TypeScript names do not exist.
 */
export const searchVector = (...columns: readonly string[]) =>
  tsvector().generatedAlwaysAs(
    sql.raw(
      `to_tsvector('english', ${columns.map((c) => `coalesce(${c}, '')`).join(" || ' ' || ")})`,
    ),
  );
