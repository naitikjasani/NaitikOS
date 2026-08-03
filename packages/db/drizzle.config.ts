/**
 * drizzle-kit configuration — migration generation only.
 *
 * Two choices here are load-bearing and should not be changed casually.
 *
 * **`out: './migrations'`** — blueprint §6.2 and §9.4: this directory is the
 * schema's permanent changelog and the physical embodiment of P2. Generated SQL
 * is committed, append-only, and never edited once applied. In year eight it is
 * how anyone reconstructs why the schema looks the way it does.
 *
 * **`casing: 'snake_case'`** — TypeScript reads in camelCase, Postgres reads in
 * snake_case, and neither has to compromise. The mapping is applied at generate
 * time, so the physical names are frozen into the committed migration SQL and
 * do not depend on this setting surviving a future drizzle-kit upgrade.
 */

import { defineConfig } from 'drizzle-kit';

import { databaseUrl } from './src/env';

export default defineConfig({
  schema: './src/schema/index.ts',
  out: './migrations',
  dialect: 'postgresql',
  casing: 'snake_case',
  dbCredentials: { url: databaseUrl() },

  // Prompt before generating anything destructive. At n=1 the database holds
  // the only copy of a twenty-year record; an unattended `DROP COLUMN` is not
  // a risk worth the convenience.
  strict: true,
  verbose: true,
});
