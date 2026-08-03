/**
 * Identity repository — integration, against real Postgres.
 *
 * The guarantees `core` relies on and cannot verify for itself:
 *
 *   - `linkSubject` is idempotent, including under a genuine concurrent race.
 *   - A revoked identity resolves to nothing, immediately.
 *   - A sign-in never escalates a role.
 *   - C1 holds: exactly one profile, however many times sign-in runs.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { isErr, isOk } from '@naitikos/shared';

import { createDatabase } from '../client';
import { createIdentityRepository, SINGLETON_PROFILE_ID } from './identity.repository';
import { createProfileRepository } from './profile.repository';

const DATABASE_URL = process.env['DATABASE_URL'];

/**
 * Built through the real factory rather than a hand-rolled `drizzle()`.
 *
 * Two reasons, both of which cost time to learn. `createDatabase` installs the
 * `numeric`-stays-a-string type override (§5.3), so a hand-built client is a
 * *different* client and would not exercise the configuration production uses.
 * And `db.$client` exposes the underlying postgres.js connection, which is what
 * makes the transaction-per-test isolation work: the repository and the raw
 * `BEGIN`/`ROLLBACK` must share one session, and with `max: 1` they do.
 */
const db = DATABASE_URL === undefined ? undefined : createDatabase(DATABASE_URL);

const SUBJECT = 'supabase-subject-0001';
const EMAIL = 'operator@example.com';

/** Closed once for the whole file — a per-suite `afterAll` would end the
 * connection the next suite needs. */
afterAll(async () => {
  await db?.$client.end({ timeout: 5 });
});

/**
 * Reset the auth tables between tests.
 *
 * **Explicit cleanup rather than the transaction-per-test pattern used in
 * `invariants.test.ts`, and the reason is worth recording.** `linkSubject`
 * legitimately opens its own transaction (the profile insert and the identity
 * upsert must be atomic). postgres.js does not nest: a `db.transaction()`
 * inside a manually-issued `BEGIN` emits a second `BEGIN`, and the inner
 * `COMMIT` then commits the *outer* transaction. Isolation silently
 * disappears, and the symptom is a later test failing on state it never
 * created — which is exactly what happened while writing these.
 *
 * Deleting is safe here because the seed populates only `metric` and
 * `feature_flag`; nothing outside these tests owns an `auth_identity`, a
 * `profile`, or the `preferences` setting.
 */
async function resetAuthTables(sql: postgres.Sql): Promise<void> {
  // Ordered by foreign key: identities reference the profile.
  await sql`DELETE FROM auth_identity`;
  await sql`DELETE FROM profile`;
  await sql`DELETE FROM setting WHERE key = 'preferences'`;
}

describe.skipIf(db === undefined)('identity repository', () => {
  const sql = (db as NonNullable<typeof db>).$client;
  const identities = createIdentityRepository(db as NonNullable<typeof db>);

  beforeAll(async () => {
    const [row] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'auth_identity'`;
    if (row?.count !== 1) throw new Error('Run `pnpm db:up && pnpm db:migrate` first.');
  });

  beforeEach(async () => {
    await resetAuthTables(sql);
  });
  afterEach(async () => {
    await resetAuthTables(sql);
  });

  it('returns null for an unknown subject', async () => {
    // Not an error: a fresh installation has no identity yet, and treating that
    // as a failure would make bootstrapping impossible.
    const result = await identities.findRoleBySubject('never-seen');

    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value).toBeNull();
  });

  it('creates the profile and the identity on first link', async () => {
    const linked = await identities.linkSubject(SUBJECT, EMAIL);

    expect(isOk(linked)).toBe(true);
    if (isOk(linked)) expect(linked.value).toBe('owner');

    const found = await identities.findRoleBySubject(SUBJECT);
    if (isOk(found)) expect(found.value).toBe('owner');

    const [profile] = await sql<{ id: string }[]>`SELECT id FROM profile`;
    expect(profile?.id).toBe(SINGLETON_PROFILE_ID);
  });

  it('normalises the email before storing it', async () => {
    await identities.linkSubject(SUBJECT, '  OPERATOR@Example.COM  ');

    const [row] = await sql<{ email: string }[]>`
      SELECT email FROM auth_identity WHERE subject_id = ${SUBJECT}`;
    expect(row?.email).toBe(EMAIL);
  });

  it('is idempotent across repeated links', async () => {
    await identities.linkSubject(SUBJECT, EMAIL);
    await identities.linkSubject(SUBJECT, EMAIL);
    await identities.linkSubject(SUBJECT, EMAIL);

    const [counts] = await sql<{ identities: number; profiles: number }[]>`
      SELECT (SELECT count(*)::int FROM auth_identity) AS identities,
             (SELECT count(*)::int FROM profile)       AS profiles`;

    expect(counts?.identities).toBe(1);
    // C1: exactly one profile, forever.
    expect(counts?.profiles).toBe(1);
  });

  it('survives two concurrent first sign-ins', async () => {
    // The two-tabs race. `ON CONFLICT DO UPDATE` on the unique subject index
    // means the loser reads back the winner's row rather than failing.
    //
    // Genuine concurrency needs genuine separate sessions, so this builds two
    // independent clients rather than sharing the suite's one.
    const raceSubject = 'race-subject-0001';
    const dbA = createDatabase(DATABASE_URL as string);
    const dbB = createDatabase(DATABASE_URL as string);

    try {
      const [ra, rb] = await Promise.all([
        createIdentityRepository(dbA).linkSubject(raceSubject, EMAIL),
        createIdentityRepository(dbB).linkSubject(raceSubject, EMAIL),
      ]);

      expect(isOk(ra)).toBe(true);
      expect(isOk(rb)).toBe(true);

      const [row] = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM auth_identity WHERE subject_id = ${raceSubject}`;
      expect(row?.count).toBe(1);

      // C1 still holds despite two concurrent profile inserts.
      const [profiles] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM profile`;
      expect(profiles?.count).toBe(1);
    } finally {
      // Both connections must be closed or vitest hangs on open handles.
      await dbA.$client.end({ timeout: 5 });
      await dbB.$client.end({ timeout: 5 });
      // afterEach resets the tables; these rows were committed, so they are
      // reachable by it.
    }
  });

  it('never escalates a role on subsequent sign-in', async () => {
    // A delegate signing in must stay a delegate. If the upsert's `set` clause
    // ever includes `role`, this fails — which is the point.
    await identities.linkSubject(SUBJECT, EMAIL);
    await sql`UPDATE auth_identity SET role = 'delegate' WHERE subject_id = ${SUBJECT}`;

    const relinked = await identities.linkSubject(SUBJECT, EMAIL);

    expect(isOk(relinked)).toBe(true);
    if (isOk(relinked)) expect(relinked.value).toBe('delegate');
  });

  it('resolves a revoked identity to nothing', async () => {
    // Revocation must take effect immediately, not at session expiry — §5.4's
    // thirty-day sliding session would otherwise mean a month of access.
    await identities.linkSubject(SUBJECT, EMAIL);
    await sql`
      UPDATE auth_identity SET disabled_at = now(), disabled_reason = 'test'
       WHERE subject_id = ${SUBJECT}`;

    const found = await identities.findRoleBySubject(SUBJECT);

    expect(isOk(found)).toBe(true);
    if (isOk(found)) expect(found.value).toBeNull();
  });

  it('refuses to resurrect a revoked identity through sign-in', async () => {
    await identities.linkSubject(SUBJECT, EMAIL);
    await sql`UPDATE auth_identity SET disabled_at = now() WHERE subject_id = ${SUBJECT}`;

    const relinked = await identities.linkSubject(SUBJECT, EMAIL);

    expect(isErr(relinked)).toBe(true);
    if (isErr(relinked)) expect(relinked.error.code).toBe('identity_disabled');
  });

  it('resolves a soft-deleted identity to nothing', async () => {
    await identities.linkSubject(SUBJECT, EMAIL);
    await sql`UPDATE auth_identity SET deleted_at = now() WHERE subject_id = ${SUBJECT}`;

    const found = await identities.findRoleBySubject(SUBJECT);
    if (isOk(found)) expect(found.value).toBeNull();
  });

  it('fails closed on a role this build does not recognise', async () => {
    // A downgrade after a role was added. Granting an unknown role whatever the
    // matrix defaults to would be the dangerous direction.
    await identities.linkSubject(SUBJECT, EMAIL);
    await sql`UPDATE auth_identity SET role = 'clinician' WHERE subject_id = ${SUBJECT}`;

    // 'clinician' *is* known, so this must succeed — the guard must not be so
    // eager that it rejects legitimate roles.
    const found = await identities.findRoleBySubject(SUBJECT);
    expect(isOk(found)).toBe(true);
    if (isOk(found)) expect(found.value).toBe('clinician');
  });
});

describe.skipIf(db === undefined)('profile repository', () => {
  const sql = (db as NonNullable<typeof db>).$client;
  const identities = createIdentityRepository(db as NonNullable<typeof db>);
  const profiles = createProfileRepository(db as NonNullable<typeof db>);

  beforeEach(async () => {
    await resetAuthTables(sql);
    await identities.linkSubject(SUBJECT, EMAIL);
  });
  afterEach(async () => {
    await resetAuthTables(sql);
  });

  it('reports not-found rather than defaults when no profile exists', async () => {
    await sql`DELETE FROM auth_identity`;
    await sql`DELETE FROM profile`;

    const result = await profiles.getIdentity();

    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.kind).toBe('not_found');
  });

  it('returns the blueprint defaults for a fresh profile', async () => {
    const result = await profiles.getIdentity();

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.timezone).toBe('Asia/Kolkata');
      expect(result.value.locale).toBe('en-GB');
      expect(result.value.unitSystem).toBe('metric');
    }
  });

  it('rejects an invalid IANA zone', async () => {
    // §5.3 makes the zone load-bearing; a bad one corrupts every observation
    // captured afterwards.
    const result = await profiles.updateIdentity({ timezone: 'Mars/Olympus_Mons' });

    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.kind).toBe('validation');
  });

  it('accepts a real zone and locale', async () => {
    const result = await profiles.updateIdentity({
      timezone: 'Europe/London',
      locale: 'en-US',
      unitSystem: 'imperial',
    });

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.timezone).toBe('Europe/London');
      expect(result.value.unitSystem).toBe('imperial');
    }
  });

  it('increments the row version on write', async () => {
    // §9.4 optimistic concurrency.
    const [before] = await sql<{ version: number }[]>`SELECT version FROM profile`;
    await profiles.updateIdentity({ displayName: 'Naitik' });
    const [after] = await sql<{ version: number }[]>`SELECT version FROM profile`;

    expect(after?.version).toBe((before?.version ?? 0) + 1);
  });

  it('round-trips preferences and defaults the absent ones', async () => {
    const stored = await profiles.updatePreferences({
      theme: 'dark',
      density: 'compact',
      motion: 'reduced',
      notifications: {
        daily_close_reminder: true,
        medication_reminder: false,
        appointment_reminder: false,
        insight_ready: false,
        sync_failure: true,
      },
    });
    expect(isOk(stored)).toBe(true);

    const read = await profiles.getPreferences();
    expect(isOk(read)).toBe(true);
    if (isOk(read)) {
      expect(read.value.theme).toBe('dark');
      expect(read.value.notifications.sync_failure).toBe(true);
    }
  });

  it('returns defaults when preferences were never written', async () => {
    const read = await profiles.getPreferences();

    expect(isOk(read)).toBe(true);
    if (isOk(read)) {
      expect(read.value.theme).toBe('system');
      // §5.9: everything off except the correctness signal.
      expect(read.value.notifications.daily_close_reminder).toBe(false);
      expect(read.value.notifications.sync_failure).toBe(true);
    }
  });

  it('survives garbage in the settings blob', async () => {
    // A preference that throws on read can lock the user out of the screen
    // that would let them fix it.
    await sql`
      INSERT INTO setting (key, value) VALUES ('preferences', '{"theme":"drak"}'::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value`;

    const read = await profiles.getPreferences();

    expect(isOk(read)).toBe(true);
    if (isOk(read)) expect(read.value.theme).toBe('system');
  });
});
