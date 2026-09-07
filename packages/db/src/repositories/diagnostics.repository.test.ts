/**
 * The three developer-dashboard reads — integration.
 *
 * Two of these assertions are unusual in that they assert a table is *empty*,
 * and that is the point rather than an accident of a clean test database.
 * `schema_migration` has no writer anywhere in this repository; if one is ever
 * added, this test fails and whoever added it has to come here and say so —
 * which is exactly the moment the dashboard's copy about the ledger needs
 * revisiting.
 *
 * Nothing here writes. The suite runs against the development database and the
 * seeded flags are real rows a maintainer may have flipped by hand, so it
 * asserts on shape and invariants rather than on particular values.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { isOk } from '@naitikos/shared';

import { createDatabase } from '../client';
import { createDiagnosticsReader } from './diagnostics.repository';

const DATABASE_URL = process.env['DATABASE_URL'];
const db = DATABASE_URL === undefined ? undefined : createDatabase(DATABASE_URL);
const suite = db === undefined ? describe.skip : describe;

afterAll(async () => {
  await db?.$client.end({ timeout: 5 });
});

suite('diagnostics reader', () => {
  it('returns the seeded feature flags in key order, with the AI kill switch among them', async () => {
    if (db === undefined) return;

    const result = await createDiagnosticsReader(db).featureFlags();
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    const keys = result.value.map((flag) => flag.key);
    expect(keys).toEqual([...keys].sort());
    /* §5.10's kill switch. Its presence is what the dashboard's "these are
     * inert" sentence is about, so a seed that stopped producing it should
     * fail here rather than quietly emptying the page. */
    expect(keys).toContain('ai.enabled');

    for (const flag of result.value) {
      expect(typeof flag.enabled).toBe('boolean');
      /* NOT NULL in the schema: a flag whose meaning is not written down is
       * unreadable in month nine, which is when it matters. */
      expect(flag.description.length).toBeGreaterThan(0);
    }
  });

  it('reports the application-owned schema ledger as empty, because nothing writes to it', async () => {
    if (db === undefined) return;

    const result = await createDiagnosticsReader(db).schemaLedger();
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    /*
     * Zero, as of 7 September 2026, against a database carrying eighteen
     * applied migrations in `drizzle.__drizzle_migrations`. The gap is the
     * finding the dashboard states in words; this is the assertion that keeps
     * the words true.
     */
    expect(result.value).toEqual([]);
  });

  it('answers with the server version and database name, which also proves connectivity', async () => {
    if (db === undefined) return;

    const result = await createDiagnosticsReader(db).database();
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    /* §5.0 pins PostgreSQL 17. A major-version drift under the application is
     * worth failing a test over. */
    expect(result.value.serverVersion.startsWith('17')).toBe(true);
    expect(result.value.databaseName).not.toBe('unknown');
  });
});
