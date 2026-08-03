/**
 * @naitikos/db — persistence.
 *
 * Blueprint §5.0 places this layer as "semi-durable": the ORM is replaceable,
 * the schema is not, and PostgreSQL underneath is the actual asset.
 *
 *   ┌──────────────────────────────────────────────────────────┐
 *   │  packages/db        Drizzle schema · migrations · repos   │  semi-durable
 *   ├──────────────────────────────────────────────────────────┤
 *   │  packages/core      Domain model · invariants · stats     │  ★ DURABLE
 *   ├──────────────────────────────────────────────────────────┤
 *   │  PostgreSQL         The actual asset                      │  ★★ PERMANENT
 *   └──────────────────────────────────────────────────────────┘
 *
 * §6.2 explains why repositories will live here rather than in `core`:
 * "Repositories exist so `core` can define `interface ObservationRepository`
 * without knowing Drizzle exists — dependency inversion, which is what actually
 * makes the durable layer durable."
 *
 * The boundary lint rules (§5.0) permit `db → core, shared` and nothing else.
 */

export * as schema from './schema';

export { createDatabase, getDatabase } from './client';
export type { Database } from './client';

export { databaseUrl, isLocalDatabase } from './env';
