/**
 * Migration runner — `pnpm db:migrate`.
 *
 * §5.15 requires this to be a discrete, gated step: "Migrations run as a
 * discrete, gated step before deployment — never automatically on boot. An
 * application that migrates its own database on startup will eventually migrate
 * it during a rollback."
 *
 * That sentence is the entire reason this is a standalone script with its own
 * connection and its own exit code, rather than something the app calls.
 */

import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { databaseUrl } from './env';

async function main(): Promise<void> {
  const url = databaseUrl();

  // A dedicated single connection. Migrations take locks; sharing the
  // application pool invites a self-deadlock that only shows up under load.
  const sql = postgres(url, { max: 1, onnotice: () => undefined });

  try {
    const { hostname, port, pathname } = new URL(url);
    console.log(`Migrating ${pathname.replace('/', '')} at ${hostname}:${port}`);

    await migrate(drizzle(sql), { migrationsFolder: new URL('../migrations', import.meta.url).pathname });

    console.log('Migrations applied.');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error('Migration failed:', error);
  // Non-zero so a deployment pipeline halts here rather than shipping an
  // application against a schema it does not match (§5.15).
  process.exit(1);
});
