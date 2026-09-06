/**
 * Row Level Security coverage — §5.4's defence in depth.
 *
 * The migration (`0004_enable_rls`) enables RLS on every table that existed
 * when it ran. It cannot enable it on tables added afterwards, and nothing in
 * Postgres will complain about a table without RLS. **This file is the actual
 * guarantee**; the migration is just today's application of it.
 *
 * The posture being asserted:
 *
 *   - RLS enabled on every table in `public`.
 *   - `FORCE` set, so the table owner is not silently exempt.
 *   - **Zero permissive policies.** RLS with no policy denies everything, which
 *     is the intent: §5.4 forbids client-direct-to-database access, so the
 *     PostgREST path (`anon`, `authenticated`) must reach a database that
 *     returns nothing even if the anon key leaks — and it will, since it ships
 *     in a browser bundle.
 *
 * A policy appearing here is not a test failure to be patched; it is an
 * architectural change requiring an ADR.
 *
 * ## `relkind IN ('r', 'p')`, not just `'r'`
 *
 * Ordinary tables are `r`; a **partitioned parent** is `p`. Migration 0015 made
 * `sample` partitioned, and until this predicate was widened the parent was
 * simply invisible to every assertion below — the suite would have passed with
 * RLS off on the largest table in the schema. Partitions themselves are `r` and
 * were always covered, but the parent is where a policy would be declared and
 * where `FORCE` has to be set.
 *
 * This is the failure mode the file's own header warns about, one level up: the
 * migration cannot cover a table added later, and the test cannot cover a
 * *kind* of table nobody thought of.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

const DATABASE_URL = process.env['DATABASE_URL'];

const client =
  DATABASE_URL === undefined
    ? undefined
    : postgres(DATABASE_URL, { max: 1, onnotice: () => undefined });

/** drizzle-kit's own bookkeeping, not application data. */
const EXCLUDED = '__drizzle_migrations';

describe.skipIf(client === undefined)('row level security (§5.4)', () => {
  const sql = client as postgres.Sql;

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  beforeAll(async () => {
    const [row] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'auth_identity'`;
    if (row?.count !== 1) {
      throw new Error('Schema not migrated. Run `pnpm db:up && pnpm db:migrate` first.');
    }
  });

  it('enables RLS on every table', async () => {
    const rows = await sql<{ relname: string }[]>`
      SELECT c.relname
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relkind IN ('r', 'p')
         AND c.relname <> ${EXCLUDED}
         AND NOT c.relrowsecurity
       ORDER BY c.relname`;

    // Names are listed rather than counted so a failure says which table was
    // added without RLS, not merely that one was.
    expect(rows.map((r) => r.relname)).toEqual([]);
  });

  it('forces RLS so the table owner is not exempt', async () => {
    const rows = await sql<{ relname: string }[]>`
      SELECT c.relname
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relkind IN ('r', 'p')
         AND c.relname <> ${EXCLUDED}
         AND NOT c.relforcerowsecurity
       ORDER BY c.relname`;

    expect(rows.map((r) => r.relname)).toEqual([]);
  });

  it('defines no permissive policies', async () => {
    // Zero is the design. See the file header before "fixing" this.
    const rows = await sql<{ tablename: string; policyname: string }[]>`
      SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'public'`;

    expect(rows).toEqual([]);
  });

  it('covers every table the schema declares', async () => {
    // Guards the opposite direction: RLS could be enabled on everything and
    // still miss a table if the migration ran before that table existed.
    const [counts] = await sql<{ total: number; secured: number }[]>`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE c.relrowsecurity)::int AS secured
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname <> ${EXCLUDED}`;

    expect(counts?.total).toBeGreaterThan(0);
    expect(counts?.secured).toBe(counts?.total);
  });

  it('denies a role that has been explicitly granted SELECT', async () => {
    /**
     * The behavioural proof, not just the configuration.
     *
     * A role with `GRANT SELECT ON metric` and no BYPASSRLS must still read
     * zero rows. This is the scenario that matters: someone grants access
     * later — to a reporting tool, to a debugging session — and RLS holds the
     * line anyway.
     *
     * Committed rather than run inside a rolled-back transaction, because the
     * probe connects on a second connection and would not otherwise see the
     * role. Cleaned up in `finally`.
     */
    const probeUrl = new URL(DATABASE_URL as string);
    probeUrl.username = 'rls_probe';
    probeUrl.password = 'probe';

    await sql.unsafe(`
      DROP ROLE IF EXISTS rls_probe;
      CREATE ROLE rls_probe LOGIN PASSWORD 'probe';
      GRANT USAGE ON SCHEMA public TO rls_probe;
      GRANT SELECT ON metric TO rls_probe;
    `);

    const probe = postgres(probeUrl.toString(), { max: 1, onnotice: () => undefined });

    try {
      // The seed puts 18 metrics here; a bypassing role sees them.
      const [asOwner] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM metric`;
      expect(asOwner?.count).toBeGreaterThan(0);

      // The granted, non-bypassing role sees none of them.
      const [asProbe] = await probe<{ count: number }[]>`SELECT count(*)::int AS count FROM metric`;
      expect(asProbe?.count).toBe(0);
    } finally {
      await probe.end({ timeout: 5 });
      await sql.unsafe(`
        REVOKE ALL ON metric FROM rls_probe;
        REVOKE ALL ON SCHEMA public FROM rls_probe;
        DROP ROLE IF EXISTS rls_probe;
      `);
    }
  });
});
