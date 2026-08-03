/**
 * Database connection configuration.
 *
 * Blueprint §5.14: "Secrets: never in the repo. Environment variables in
 * development, provider secret store in production."
 *
 * This module is deliberately the only place in the package that reads
 * `process.env`. Everything else receives a URL. That keeps the schema and the
 * repositories testable without an ambient environment, and it means a missing
 * variable fails once, loudly, at the edge — rather than as a confusing
 * connection error three layers down.
 */

/**
 * Read the Postgres connection URL.
 *
 * @throws {Error} when `DATABASE_URL` is absent or empty. This is deliberate.
 *   A silent fallback to `localhost` is how a migration intended for a scratch
 *   database ends up running somewhere else — and §5.15 is explicit that a
 *   preview environment reaching production data is an incident.
 */
export function databaseUrl(): string {
  // Bracket access: `noPropertyAccessFromIndexSignature` is on (tsconfig base).
  const url = process.env['DATABASE_URL'];

  if (url === undefined || url.trim() === '') {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env and set it, or run `pnpm db:up` ' +
        'to start the local Postgres container. There is no default — see blueprint §5.15.',
    );
  }

  return url;
}

/**
 * Whether this process is talking to the local development container.
 *
 * Used to gate destructive helpers (seed, reset) so they cannot be pointed at a
 * remote database by accident. §5.15: local and preview run on synthetic data
 * only, and the enforcement should be structural rather than a convention.
 */
export function isLocalDatabase(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return false;
  }
}
