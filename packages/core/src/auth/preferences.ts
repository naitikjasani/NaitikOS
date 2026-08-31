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
 * AI (§10.10, §7) — /settings/ai
 * ====================================================================== */

/**
 * §10.10's four consent scopes, **independently revocable**.
 *
 * These are the authoritative record of what the operator has granted. The
 * `consent_scope` enum column is a *ladder* — `none | aggregates_only |
 * non_clinical | clinical | journal` — which cannot express "metrics on,
 * clinical off", and §10.10 requires exactly that expressiveness.
 *
 * So the four booleans are stored here, in the `setting` blob, and the ladder
 * column becomes a **derived projection** written alongside each
 * `ai_interaction` row. That inverts the earlier arrangement, where the ladder
 * was authoritative and `fromStoredScope` narrowed it conservatively — a
 * workaround that was correct while nothing could write the four, and is no
 * longer needed now that something can.
 *
 * Storing them in `jsonb` rather than adding four columns is the same trade
 * §9.2 already makes for preferences, and it means this shipped without a
 * migration (§13.2).
 */
export const AI_CONSENT_SCOPES = ['metrics', 'clinical', 'journal', 'media'] as const;
export type AiConsentScope = (typeof AI_CONSENT_SCOPES)[number];

export type AiConsent = Readonly<Record<AiConsentScope, boolean>>;

/**
 * All four off. §10.10's table says "Off" in every row, without exception.
 *
 * A default of on for anything would mean the first call after a fresh install
 * sent data the operator never agreed to send — and P7 makes that the one
 * category of mistake this system cannot take back, because egress is not
 * reversible.
 */
export const DEFAULT_AI_CONSENT: AiConsent = Object.freeze({
  metrics: false,
  clinical: false,
  journal: false,
  media: false,
});

/**
 * What each scope covers, in the operator's words rather than the schema's.
 *
 * On the page these are the whole decision. A toggle labelled "clinical" with
 * no explanation is a toggle nobody can consent to meaningfully, and P7 asks
 * for a decision rather than a default being accepted.
 */
export const AI_CONSENT_DESCRIPTIONS: Readonly<Record<AiConsentScope, string>> = Object.freeze({
  metrics: 'Numbers you log and the summaries computed from them — weight, mood, training volume, macros.',
  clinical: 'Conditions, medications, lab results, symptoms, appointments, and documents.',
  journal: 'Journal entries and therapy notes. The most sensitive text in the system.',
  media: 'Images. Skin and physique photography. Confirmed again each time, never on a standing grant.',
});

export type AiPreferences = {
  /**
   * §7's kill switch: "a single flag in `/settings/ai`, and the acceptance test
   * for the flag is that **the whole product still works with it off**."
   *
   * Off by default, so a fresh install has no model in it until someone decides
   * otherwise. Every figure in the application is computed without one.
   */
  readonly enabled: boolean;
  readonly consent: AiConsent;
  /**
   * §10.11's hard monthly cap, in minor units.
   *
   * Adjustable, because the failure mode being managed is not cost — it is
   * abandonment (§13.1). A cap the operator cannot raise is a cap that
   * eventually stops the one feature they wanted, and a person who cannot
   * change it turns the system off instead.
   */
  readonly monthlyCapMinor: number;
};

/** §10.11's default, restated here so the settings page has a number to show. */
export const DEFAULT_MONTHLY_CAP_MINOR = 2_000;

/** The cap's bounds. Zero is legitimate — it is the kill switch by another route. */
export const MIN_MONTHLY_CAP_MINOR = 0;
export const MAX_MONTHLY_CAP_MINOR = 50_000;

export const DEFAULT_AI_PREFERENCES: AiPreferences = Object.freeze({
  enabled: false,
  consent: DEFAULT_AI_CONSENT,
  monthlyCapMinor: DEFAULT_MONTHLY_CAP_MINOR,
});

/**
 * Project the four scopes onto the stored ladder, for `ai_interaction`.
 *
 * Lossy in one direction and honest about it: "metrics on, clinical off"
 * projects to `aggregates_only`, and the fact that clinical was *explicitly*
 * off rather than merely below the rung is not recoverable from the column.
 * What the column is for — "what the user had granted at the moment of the
 * call, so a later consent change cannot retroactively justify an earlier one"
 * — survives that loss, because the projection is monotone: a narrower grant
 * never projects to a wider rung.
 */
export function toStoredScope(consent: AiConsent): 'none' | 'aggregates_only' | 'clinical' | 'journal' {
  if (consent.journal) return 'journal';
  if (consent.clinical) return 'clinical';
  if (consent.metrics) return 'aggregates_only';
  return 'none';
}

/**
 * Whether the AI layer may run at all.
 *
 * Both conditions, because they mean different things. `enabled` is §7's kill
 * switch — a deliberate "not now" that leaves the grants intact. An empty grant
 * is "there is nothing I am willing to send", which is a different statement and
 * should not be silently satisfied by flipping one switch back on.
 */
export function aiIsUsable(preferences: AiPreferences): boolean {
  return preferences.enabled && Object.values(preferences.consent).some(Boolean);
}

/* =========================================================================
 * The aggregate
 * ====================================================================== */

export type Preferences = {
  readonly theme: Theme;
  readonly density: Density;
  readonly motion: MotionPreference;
  readonly notifications: NotificationPreferences;
  readonly ai: AiPreferences;
};

export const DEFAULT_PREFERENCES: Preferences = Object.freeze({
  theme: DEFAULT_THEME,
  density: DEFAULT_DENSITY,
  motion: DEFAULT_MOTION,
  notifications: DEFAULT_NOTIFICATION_PREFERENCES,
  ai: DEFAULT_AI_PREFERENCES,
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
    ai: parseAiPreferences(record['ai']),
  });
}

/**
 * Read the AI block, defaulting **closed** on anything unexpected.
 *
 * The rest of this file's parsers fall back to a default that is merely
 * conventional — a bad theme becomes dark, and nothing is harmed. This one
 * falls back to *no consent and disabled*, because the failure it is guarding
 * against is a malformed row causing data to be sent that the operator never
 * agreed to send. P7's egress is not reversible, so the tolerant read has to
 * lean the other way here than it does everywhere else.
 */
export function parseAiPreferences(raw: unknown): AiPreferences {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_AI_PREFERENCES;

  const record = raw as Record<string, unknown>;
  const consentRaw = record['consent'];
  const consentRecord =
    typeof consentRaw === 'object' && consentRaw !== null ? (consentRaw as Record<string, unknown>) : {};

  const cap = record['monthlyCapMinor'];

  return Object.freeze({
    enabled: record['enabled'] === true,
    consent: Object.freeze(
      Object.fromEntries(
        AI_CONSENT_SCOPES.map((scope) => [scope, consentRecord[scope] === true]),
      ) as unknown as AiConsent,
    ),
    monthlyCapMinor:
      typeof cap === 'number' && Number.isInteger(cap) && cap >= MIN_MONTHLY_CAP_MINOR && cap <= MAX_MONTHLY_CAP_MINOR
        ? cap
        : DEFAULT_MONTHLY_CAP_MINOR,
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

  const ai = record['ai'];
  if (ai !== undefined) {
    if (typeof ai !== 'object' || ai === null) {
      issues.push({ path: ['ai'], message: 'Must be an object.' });
    } else {
      const aiRecord = ai as Record<string, unknown>;

      if (aiRecord['enabled'] !== undefined && typeof aiRecord['enabled'] !== 'boolean') {
        issues.push({ path: ['ai', 'enabled'], message: 'Must be a boolean.' });
      }

      const cap = aiRecord['monthlyCapMinor'];
      if (cap !== undefined) {
        if (typeof cap !== 'number' || !Number.isInteger(cap)) {
          issues.push({ path: ['ai', 'monthlyCapMinor'], message: 'Must be a whole number of minor units.' });
        } else if (cap < MIN_MONTHLY_CAP_MINOR || cap > MAX_MONTHLY_CAP_MINOR) {
          issues.push({
            path: ['ai', 'monthlyCapMinor'],
            message: `Must be between ${String(MIN_MONTHLY_CAP_MINOR)} and ${String(MAX_MONTHLY_CAP_MINOR)}.`,
          });
        }
      }

      const consent = aiRecord['consent'];
      if (consent !== undefined) {
        if (typeof consent !== 'object' || consent === null) {
          issues.push({ path: ['ai', 'consent'], message: 'Must be an object.' });
        } else {
          for (const [key, value] of Object.entries(consent)) {
            /*
             * An unknown scope is rejected rather than ignored. Everywhere else
             * in this validator an unknown key is a typo; here it is a client
             * that believes it is granting something, and silently dropping the
             * grant would leave the operator thinking they had consented to a
             * class that was never enabled — or, worse on a later refactor,
             * enabling one they had not.
             */
            if (!(AI_CONSENT_SCOPES as readonly string[]).includes(key)) {
              issues.push({ path: ['ai', 'consent', key], message: 'Unknown consent scope.' });
            } else if (typeof value !== 'boolean') {
              issues.push({ path: ['ai', 'consent', key], message: 'Must be a boolean.' });
            }
          }
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
