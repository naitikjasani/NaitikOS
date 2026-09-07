/**
 * The three reads `/settings/developer` needs and nobody else does.
 *
 * §3.2 gives that page one line — "Feature flags, diagnostics, schema version" —
 * and each third of it turned out to need a table that no code in this
 * repository had ever read. That is the interesting fact about this file, and it
 * is why the three reads sit together rather than being scattered into the
 * repositories that own the neighbouring tables:
 *
 * - **`feature_flag`** is seeded by `src/seed` and read by nothing. §5.15 wants
 *   "feature flags for anything touching the substrate"; until something
 *   consults these rows, the only rollback lever is a deploy. The dashboard's
 *   job is to say that plainly, which it cannot do without the rows.
 * - **`schema_migration`** is declared, indexed, exported (§9.10) — and empty.
 *   drizzle-kit records applied migrations in its own `drizzle.__drizzle_migrations`,
 *   and nothing bridges the two. A count of zero is the honest thing to show and
 *   is only obtainable by asking.
 * - **Server version and database name** are the one pair of genuinely useful
 *   diagnostics that cost a single round trip and cannot be wrong: if this read
 *   returns at all, the connection works.
 *
 * ## Read-only, and structurally so
 *
 * There is no write path here and there should not be one. A flag editor is a
 * real feature with real requirements — an audit row per flip (§9.4), a change
 * reason, and above all something that *reads* the flag — and a toggle that
 * writes a boolean nothing consults would teach the operator that this page
 * lies. The column `change_reason` exists precisely because a flip is supposed
 * to be explicable in month nine; a write path that could not fill it honestly
 * is worse than no write path.
 */

import { asc, desc, sql } from 'drizzle-orm';
import type { Result } from '@naitikos/shared';
import { ok } from '@naitikos/shared';
import type { DomainError } from '@naitikos/core';

import type { Database } from '../client';
import { featureFlag } from '../schema/identity';
import { schemaMigration } from '../schema/operations';

/** A row of `feature_flag`, exactly as stored. */
export type FeatureFlagRow = {
  readonly key: string;
  readonly enabled: boolean;
  readonly description: string;
  /** Why it was last flipped. Null for every seeded row — none has been flipped. */
  readonly changeReason: string | null;
  readonly updatedAt: string;
};

/** A row of `public.schema_migration` — the ledger the *application* owns. */
export type SchemaMigrationRow = {
  readonly id: string;
  readonly appliedAt: string;
  readonly appliedBy: string | null;
  readonly isDataMigration: boolean;
};

export type DatabaseIdentity = {
  /** `current_setting('server_version')` — `17.6`, not the full banner. */
  readonly serverVersion: string;
  readonly databaseName: string;
};

export type DiagnosticsReader = {
  featureFlags(): Promise<Result<readonly FeatureFlagRow[], DomainError>>;
  schemaLedger(): Promise<Result<readonly SchemaMigrationRow[], DomainError>>;
  database(): Promise<Result<DatabaseIdentity, DomainError>>;
};

export function createDiagnosticsReader(db: Database): DiagnosticsReader {
  return {
    async featureFlags() {
      /*
       * Ordered by key rather than by `updated_at`. There are four rows and
       * there will never be forty; alphabetical means the same flag is in the
       * same place every time the page is opened, which is what makes a
       * changed value noticeable at a glance.
       */
      const rows = await db
        .select({
          key: featureFlag.key,
          enabled: featureFlag.enabled,
          description: featureFlag.description,
          changeReason: featureFlag.changeReason,
          updatedAt: featureFlag.updatedAt,
        })
        .from(featureFlag)
        .orderBy(asc(featureFlag.key));

      return ok(rows);
    },

    async schemaLedger() {
      const rows = await db
        .select({
          id: schemaMigration.id,
          appliedAt: schemaMigration.appliedAt,
          appliedBy: schemaMigration.appliedBy,
          isDataMigration: schemaMigration.isDataMigration,
        })
        .from(schemaMigration)
        .orderBy(desc(schemaMigration.appliedAt));

      /*
       * `checksum` is read and discarded — deliberately. The column exists so an
       * edited-after-apply migration is *detectable*, and detecting it means
       * recomputing the hash of the file on disk and comparing. Rendering the
       * stored hash next to nothing to compare it against would look like a
       * check and be a decoration, so this read does not carry it.
       */
      return ok(rows);
    },

    async database() {
      /*
       * `current_setting('server_version')` rather than `version()`: the latter
       * returns the full build banner — compiler, architecture, Debian package
       * revision — which is three lines of noise around the one number anybody
       * reads. Neither can carry user content, so §5.11 is untroubled either way.
       */
      const rows = await db.execute(
        sql`select current_setting('server_version') as server_version, current_database() as database_name`,
      );

      const typed = rows as unknown as readonly {
        server_version: string | null;
        database_name: string | null;
      }[];
      const first = typed[0];

      return ok({
        /*
         * `unknown` rather than an empty string when Postgres somehow answers
         * with nothing. §8.9: missing data is shown as missing, and a blank
         * version field reads as a rendering bug rather than as an absence.
         */
        serverVersion: first?.server_version ?? 'unknown',
        databaseName: first?.database_name ?? 'unknown',
      });
    },
  };
}
