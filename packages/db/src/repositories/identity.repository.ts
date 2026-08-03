/**
 * The `IdentityRepository` port, implemented against Drizzle.
 *
 * §6.2: "Repositories exist so `core` can define `interface
 * ObservationRepository` without knowing Drizzle exists — dependency inversion,
 * which is what actually makes the durable layer durable."
 *
 * So `core` states what it needs and this file is the only place that knows how
 * to get it. Swapping the ORM means rewriting this file; it does not mean
 * touching a single authorization rule.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Result } from '@naitikos/shared';
import { err, ok } from '@naitikos/shared';
import type { DomainError, IdentityRepository, Role } from '@naitikos/core';
import { conflictError, isRole, normaliseEmail } from '@naitikos/core';

import type { Database } from '../client';
import { authIdentity, profile } from '../schema/identity';

/**
 * A fixed UUIDv7 for the singleton profile.
 *
 * C1 says there is exactly one profile, forever, and the schema enforces that
 * with a check constraint plus a unique index. Given uniqueness is already
 * guaranteed, a constant id is strictly better than a generated one: the row is
 * addressable from a migration, a runbook, or a psql session without a lookup,
 * and a support script written in year six does not have to ask which id it is.
 *
 * The timestamp prefix is deliberately the project's own epoch rather than a
 * real capture time, so it never looks like a record of when anything happened.
 */
const SINGLETON_PROFILE_ID = '01900000-0000-7000-8000-000000000001';

export function createIdentityRepository(db: Database): IdentityRepository {
  return {
    async findRoleBySubject(subjectId: string): Promise<Result<Role | null, DomainError>> {
      const rows = await db
        .select({ role: authIdentity.role })
        .from(authIdentity)
        .where(
          and(
            eq(authIdentity.subjectId, subjectId),
            // A revoked identity must stop working immediately, not at session
            // expiry. Both filters are part of the security property, not
            // hygiene — see the `disabledAt` note on the table.
            isNull(authIdentity.disabledAt),
            isNull(authIdentity.deletedAt),
          ),
        )
        .limit(1);

      const found = rows[0];
      if (found === undefined) return ok(null);

      if (!isRole(found.role)) {
        // The database holds a role string this build does not understand —
        // a downgrade after a role was added. Failing closed is the only safe
        // direction: granting an unknown role would grant it whatever the
        // matrix happens to default to.
        return err(
          conflictError('auth_identity', 'invalid_state', {
            code: 'unknown_role',
            message: 'Stored role is not recognised by this build. Refusing to authorize.',
          }),
        );
      }

      return ok(found.role);
    },

    /**
     * Bind a provider subject to the singleton profile.
     *
     * Idempotent by construction rather than by check-then-insert. Two tabs
     * completing a first sign-in concurrently would both see "no identity" and
     * both insert; `ON CONFLICT DO UPDATE` on the unique subject index makes
     * the loser of that race read back the winner's row instead of failing.
     *
     * The profile insert has the same shape for the same reason.
     */
    async linkSubject(subjectId: string, email: string): Promise<Result<Role, DomainError>> {
      const normalised = normaliseEmail(email);

      return db.transaction(async (tx) => {
        // The profile may not exist yet on a fresh installation. `DO NOTHING`
        // rather than `DO UPDATE`: an existing profile's display name and
        // timezone are the operator's, and a sign-in must never overwrite them.
        await tx
          .insert(profile)
          .values({
            id: SINGLETON_PROFILE_ID,
            singleton: true,
            displayName: normalised,
          })
          .onConflictDoNothing();

        const [row] = await tx
          .insert(authIdentity)
          .values({
            id: crypto.randomUUID(),
            subjectId,
            email: normalised,
            profileId: SINGLETON_PROFILE_ID,
            role: 'owner',
          })
          .onConflictDoUpdate({
            target: authIdentity.subjectId,
            // Only the observable-freshness fields. Notably NOT `role`: a
            // sign-in must never be able to escalate an identity that was
            // deliberately downgraded to `delegate`.
            set: { email: normalised, updatedAt: sql`now()` },
          })
          .returning({ role: authIdentity.role, disabledAt: authIdentity.disabledAt });

        if (row === undefined) {
          return err(
            conflictError('auth_identity', 'invalid_state', {
              code: 'link_failed',
              message: 'Could not link the provider subject to a profile.',
            }),
          );
        }

        // The upsert resurrects nothing: if this subject was revoked, it stays
        // revoked and the caller is refused.
        if (row.disabledAt !== null) {
          return err(
            conflictError('auth_identity', 'invalid_state', {
              code: 'identity_disabled',
              message: 'This identity has been revoked.',
            }),
          );
        }

        if (!isRole(row.role)) {
          return err(
            conflictError('auth_identity', 'invalid_state', {
              code: 'unknown_role',
              message: 'Stored role is not recognised by this build.',
            }),
          );
        }

        return ok(row.role);
      });
    },
  };
}

/** Exported for migrations, runbooks, and tests that need to address the row. */
export { SINGLETON_PROFILE_ID };
