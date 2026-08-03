/**
 * Profile and preferences.
 *
 * The split this file has to respect: §5.3 identity fields (`timezone`,
 * `locale`, `unitSystem`, `displayName`) are columns on `profile`; everything
 * else is a `setting` row holding `jsonb`. `packages/core/auth/preferences.ts`
 * explains why — the zone and the unit system are read on every write path and
 * must not be one JSON parse away from being absent.
 */

import { eq, sql } from 'drizzle-orm';
import type { Result } from '@naitikos/shared';
import { err, ok } from '@naitikos/shared';
import type { DomainError, Preferences, ProfileIdentity, UnitSystem } from '@naitikos/core';
import {
  DEFAULT_PREFERENCES,
  DEFAULT_PROFILE_IDENTITY,
  UNIT_SYSTEMS,
  isValidLocale,
  isValidTimezone,
  notFoundError,
  parsePreferences,
  validationError,
} from '@naitikos/core';

import type { Database } from '../client';
import { profile, setting } from '../schema/identity';
import { SINGLETON_PROFILE_ID } from './identity.repository';

/** The `setting` key preferences live under. One row, one blob. */
const PREFERENCES_KEY = 'preferences';

export type ProfileRepository = {
  getIdentity(): Promise<Result<ProfileIdentity, DomainError>>;
  updateIdentity(patch: Partial<ProfileIdentity>): Promise<Result<ProfileIdentity, DomainError>>;
  getPreferences(): Promise<Result<Preferences, DomainError>>;
  updatePreferences(next: Preferences): Promise<Result<Preferences, DomainError>>;
};

function toUnitSystem(value: string): UnitSystem {
  return (UNIT_SYSTEMS as readonly string[]).includes(value)
    ? (value as UnitSystem)
    : DEFAULT_PROFILE_IDENTITY.unitSystem;
}

export function createProfileRepository(db: Database): ProfileRepository {
  return {
    async getIdentity(): Promise<Result<ProfileIdentity, DomainError>> {
      const rows = await db
        .select({
          displayName: profile.displayName,
          timezone: profile.timezone,
          locale: profile.locale,
          unitSystem: profile.unitSystem,
        })
        .from(profile)
        .where(eq(profile.id, SINGLETON_PROFILE_ID))
        .limit(1);

      const row = rows[0];
      if (row === undefined) {
        // Distinct from "defaults". A missing profile means the installation
        // has never been signed into, and a caller that silently rendered
        // defaults would hide that.
        return err(notFoundError('profile', SINGLETON_PROFILE_ID));
      }

      return ok({
        displayName: row.displayName,
        timezone: row.timezone,
        locale: row.locale,
        unitSystem: toUnitSystem(row.unitSystem),
      });
    },

    async updateIdentity(
      patch: Partial<ProfileIdentity>,
    ): Promise<Result<ProfileIdentity, DomainError>> {
      const issues: { path: readonly (string | number)[]; message: string }[] = [];

      // Validated here rather than only at the API boundary. §5.3 makes the
      // zone load-bearing — "discarding the zone destroys information you
      // cannot recover" — and a bad zone written now corrupts every
      // observation captured afterwards.
      if (patch.timezone !== undefined && !isValidTimezone(patch.timezone)) {
        issues.push({ path: ['timezone'], message: 'Not a recognised IANA time zone.' });
      }
      if (patch.locale !== undefined && !isValidLocale(patch.locale)) {
        issues.push({ path: ['locale'], message: 'Not a well-formed BCP 47 locale.' });
      }
      if (
        patch.unitSystem !== undefined &&
        !(UNIT_SYSTEMS as readonly string[]).includes(patch.unitSystem)
      ) {
        issues.push({ path: ['unitSystem'], message: `Must be one of: ${UNIT_SYSTEMS.join(', ')}.` });
      }
      if (patch.displayName !== undefined && patch.displayName.trim() === '') {
        issues.push({ path: ['displayName'], message: 'Must not be empty.' });
      }

      if (issues.length > 0) {
        return err(validationError('profile_invalid', 'Invalid profile fields.', issues));
      }

      const [updated] = await db
        .update(profile)
        .set({
          ...(patch.displayName === undefined ? {} : { displayName: patch.displayName.trim() }),
          ...(patch.timezone === undefined ? {} : { timezone: patch.timezone }),
          ...(patch.locale === undefined ? {} : { locale: patch.locale }),
          ...(patch.unitSystem === undefined ? {} : { unitSystem: patch.unitSystem }),
          updatedAt: sql`now()`,
          // §9.4 row versioning. Incremented on every write so a stale client
          // is detected rather than silently overwriting.
          version: sql`${profile.version} + 1`,
        })
        .where(eq(profile.id, SINGLETON_PROFILE_ID))
        .returning({
          displayName: profile.displayName,
          timezone: profile.timezone,
          locale: profile.locale,
          unitSystem: profile.unitSystem,
        });

      if (updated === undefined) {
        return err(notFoundError('profile', SINGLETON_PROFILE_ID));
      }

      return ok({
        displayName: updated.displayName,
        timezone: updated.timezone,
        locale: updated.locale,
        unitSystem: toUnitSystem(updated.unitSystem),
      });
    },

    async getPreferences(): Promise<Result<Preferences, DomainError>> {
      const rows = await db
        .select({ value: setting.value })
        .from(setting)
        .where(eq(setting.key, PREFERENCES_KEY))
        .limit(1);

      // Absent preferences are not an error — a profile that has never opened
      // the settings screen has none, and `parsePreferences` is total.
      return ok(rows[0] === undefined ? DEFAULT_PREFERENCES : parsePreferences(rows[0].value));
    },

    async updatePreferences(next: Preferences): Promise<Result<Preferences, DomainError>> {
      await db
        .insert(setting)
        .values({
          key: PREFERENCES_KEY,
          value: next,
          description:
            'Theme, density, motion, and notification preferences. Shape defined by @naitikos/core/auth/preferences.',
        })
        .onConflictDoUpdate({
          target: setting.key,
          set: { value: next, updatedAt: sql`now()` },
        });

      return ok(next);
    },
  };
}

export { PREFERENCES_KEY };
