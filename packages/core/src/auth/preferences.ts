/**
 * User preferences — timezone, locale, theme, units, notifications.
 *
 * ## Why these are domain types rather than a settings blob
 *
 * `setting` in the database is deliberately `jsonb` (§9.2), because a column
 * per preference means a migration every time one is added. That flexibility is
 * correct at the storage layer and dangerous at the boundary: an untyped blob
 * read straight into the UI is how `theme: "drak"` ships.
 *
 * So the schema is loose and this file is strict. Every preference has a
 * declared shape, a default, and a parser that returns the default rather than
 * failing when storage disagrees with code. That last property matters more
 * than it looks: a preference that throws on read can lock the user out of the
 * application that would let them fix it.
 *
 * ## The two that are not preferences
 *
 * `timezone` and `unitSystem` are columns on `profile`, not rows in `setting`,
 * and this file reflects that split rather than papering over it. §5.3 makes
 * the zone load-bearing — "discarding the zone destroys information you cannot
 * recover" — and §6.2 makes units a correctness concern rather than a taste
 * one. Both are read on every write path, and neither should be one JSON parse
 * away from being absent.
 */

import type { Result } from '@naitikos/shared';
import { err, ok } from '@naitikos/shared';

import type { DomainError } from '../errors/domain-error';
import { validationError } from '../errors/domain-error';

/* =========================================================================
 * Theme (§8, §3.2 /settings/appearance)
 * ====================================================================== */

export const THEMES = ['light', 'dark', 'system'] as const;
export type Theme = (typeof THEMES)[number];

/**
 * `dark`, not `system`.
 *
 * §8.7 is explicit and overrides the instinct to follow the OS:
 *
 *   "Dark is the **default**, with light available. This is a real decision,
 *    not a preference: the application is opened last thing at night for the
 *    Daily Close and in a dimly lit gym. Defaulting to light and requiring a
 *    setting change is optimising for the wrong context."
 *
 * An earlier revision of this file defaulted to `system` on the reasoning that
 * following the OS is the quieter choice under P6. That was wrong: §8.7 is not
 * expressing a taste, it is naming the two contexts the application is actually
 * opened in, and a phone set to light mode in a dark gym is the case the
 * blueprint is guarding against. `system` remains available to choose.
 */
export const DEFAULT_THEME: Theme = 'dark';

/** Interface density. Not in the MVP scope, defined so the shape is settled. */
export const DENSITIES = ['comfortable', 'compact'] as const;
export type Density = (typeof DENSITIES)[number];
export const DEFAULT_DENSITY: Density = 'comfortable';

/**
 * Motion preference.
 *
 * `system` respects `prefers-reduced-motion`. Worth an explicit setting rather
 * than only reading the media query: vestibular sensitivity and anxiety are not
 * the same thing, and §4.7's duty of care means a user should be able to turn
 * animation off here without changing it for their whole device.
 */
export const MOTION_PREFERENCES = ['system', 'full', 'reduced'] as const;
export type MotionPreference = (typeof MOTION_PREFERENCES)[number];
export const DEFAULT_MOTION: MotionPreference = 'system';

/* =========================================================================
 * Units (§6.2)
 * ====================================================================== */

export const UNIT_SYSTEMS = ['metric', 'imperial'] as const;
export type UnitSystem = (typeof UNIT_SYSTEMS)[number];
export const DEFAULT_UNIT_SYSTEM: UnitSystem = 'metric';

/**
 * A display preference only. Storage is always canonical.
 *
 * §6.2: "Every measured quantity is a `Quantity { value: Decimal, unit: Unit }`,
 * never a bare number, and conversion is total and tested. There is no path by
 * which milligrams become micrograms."
 *
 * Which means this setting must never reach a write path. A bodyweight is
 * stored in kilograms whatever this says; the imperial user sees pounds because
 * the *renderer* converted, not because the database did. Storing in display
 * units would make a preference change silently rewrite history.
 */
export const UNIT_SYSTEM_IS_DISPLAY_ONLY = true;

/* =========================================================================
 * Notifications (§5.9)
 * ====================================================================== */

/**
 * §5.9: "Opt-in per category, off by default, no exceptions."
 *
 * The prohibitions are as load-bearing as the categories: "no streak
 * notifications. No 'we miss you.' No notification whose content is a metric
 * intended to induce guilt." There is deliberately no category that could carry
 * one, which is P6 enforced by the absence of an affordance rather than by
 * restraint.
 */
export const NOTIFICATION_CATEGORIES = [
  'daily_close_reminder',
  'medication_reminder',
  'appointment_reminder',
  'insight_ready',
  'sync_failure',
] as const;

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export type NotificationPreferences = Readonly<Record<NotificationCategory, boolean>>;

/**
 * Everything off, except sync failure.
 *
 * §5.9 makes that one exception explicitly: sync failure is "default on — this
 * one is a correctness signal, not engagement". A write that never synced is
 * data the user believes they have and does not, which §5.7 says would "end the
 * user's trust in the system".
 */
export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = Object.freeze({
  daily_close_reminder: false,
  medication_reminder: false,
  appointment_reminder: false,
  insight_ready: false,
  sync_failure: true,
});

/** §5.9: "No more than three notifications in any 24-hour period." */
export const NOTIFICATION_DAILY_CAP = 3;

/* =========================================================================
 * The aggregate
 * ====================================================================== */

export type Preferences = {
  readonly theme: Theme;
  readonly density: Density;
  readonly motion: MotionPreference;
  readonly notifications: NotificationPreferences;
};

export const DEFAULT_PREFERENCES: Preferences = Object.freeze({
  theme: DEFAULT_THEME,
  density: DEFAULT_DENSITY,
  motion: DEFAULT_MOTION,
  notifications: DEFAULT_NOTIFICATION_PREFERENCES,
});

/**
 * Identity fields that live on `profile` rather than in `setting`.
 *
 * Mirrors the columns exactly — see `packages/db/src/schema/identity.ts`. Kept
 * in sync by `profile.contract.test.ts`, which fails if the two drift.
 */
export type ProfileIdentity = {
  readonly displayName: string;
  /** IANA zone. Never an offset — §5.3. */
  readonly timezone: string;
  /** BCP 47. */
  readonly locale: string;
  readonly unitSystem: UnitSystem;
};

export const DEFAULT_PROFILE_IDENTITY: ProfileIdentity = Object.freeze({
  displayName: '',
  timezone: 'Asia/Kolkata',
  locale: 'en-GB',
  unitSystem: DEFAULT_UNIT_SYSTEM,
});

/* =========================================================================
 * Parsing — tolerant on read, strict on write
 * ====================================================================== */

function oneOf<T extends string>(allowed: readonly T[], value: unknown, fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/**
 * Read preferences from whatever storage returned.
 *
 * **Total, and never throws.** Every unrecognised value falls back to its
 * default. A user whose stored theme is a string from a version of the app that
 * no longer exists gets the default theme, not a crash — and, critically, can
 * still reach the settings screen to change it.
 *
 * The strict direction is {@link validatePreferences}, used on write.
 */
export function parsePreferences(raw: unknown): Preferences {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_PREFERENCES;

  const record = raw as Record<string, unknown>;
  const notifications = record['notifications'];
  const notificationRecord =
    typeof notifications === 'object' && notifications !== null
      ? (notifications as Record<string, unknown>)
      : {};

  return Object.freeze({
    theme: oneOf(THEMES, record['theme'], DEFAULT_THEME),
    density: oneOf(DENSITIES, record['density'], DEFAULT_DENSITY),
    motion: oneOf(MOTION_PREFERENCES, record['motion'], DEFAULT_MOTION),
    notifications: Object.freeze(
      Object.fromEntries(
        NOTIFICATION_CATEGORIES.map((category) => [
          category,
          typeof notificationRecord[category] === 'boolean'
            ? notificationRecord[category]
            : DEFAULT_NOTIFICATION_PREFERENCES[category],
        ]),
      ) as unknown as NotificationPreferences,
    ),
  });
}

/**
 * Validate a proposed preference change.
 *
 * Strict, because this is a write. The tolerance in {@link parsePreferences}
 * exists to survive old data; accepting a bad value *into* storage would just
 * create more of it.
 */
export function validatePreferences(raw: unknown): Result<Preferences, DomainError> {
  if (typeof raw !== 'object' || raw === null) {
    return err(validationError('preferences_invalid', 'Preferences must be an object.'));
  }

  const record = raw as Record<string, unknown>;
  const issues: { path: readonly (string | number)[]; message: string }[] = [];

  if (record['theme'] !== undefined && !(THEMES as readonly unknown[]).includes(record['theme'])) {
    issues.push({ path: ['theme'], message: `Must be one of: ${THEMES.join(', ')}.` });
  }
  if (record['density'] !== undefined && !(DENSITIES as readonly unknown[]).includes(record['density'])) {
    issues.push({ path: ['density'], message: `Must be one of: ${DENSITIES.join(', ')}.` });
  }
  if (
    record['motion'] !== undefined &&
    !(MOTION_PREFERENCES as readonly unknown[]).includes(record['motion'])
  ) {
    issues.push({ path: ['motion'], message: `Must be one of: ${MOTION_PREFERENCES.join(', ')}.` });
  }

  const notifications = record['notifications'];
  if (notifications !== undefined) {
    if (typeof notifications !== 'object' || notifications === null) {
      issues.push({ path: ['notifications'], message: 'Must be an object.' });
    } else {
      for (const [key, value] of Object.entries(notifications)) {
        if (!(NOTIFICATION_CATEGORIES as readonly string[]).includes(key)) {
          issues.push({ path: ['notifications', key], message: 'Unknown notification category.' });
        } else if (typeof value !== 'boolean') {
          issues.push({ path: ['notifications', key], message: 'Must be a boolean.' });
        }
      }
    }
  }

  if (issues.length > 0) {
    return err(validationError('preferences_invalid', 'Invalid preferences.', issues));
  }

  return ok(parsePreferences(raw));
}

/**
 * Is this a plausible IANA zone name?
 *
 * Validated against the runtime's own database via `Intl`, rather than against
 * a bundled list. A hardcoded list goes stale — zones are added and renamed —
 * and a stale list would reject a zone the user genuinely lives in.
 */
export function isValidTimezone(zone: string): boolean {
  if (zone.trim() === '') return false;
  try {
    // Throws RangeError for an unknown zone.
    new Intl.DateTimeFormat('en-GB', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Is this a well-formed BCP 47 tag the runtime recognises? */
export function isValidLocale(locale: string): boolean {
  if (locale.trim() === '') return false;
  try {
    return Intl.getCanonicalLocales(locale).length > 0;
  } catch {
    return false;
  }
}
