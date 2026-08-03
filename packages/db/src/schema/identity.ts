/**
 * Identity and configuration — §9.2, "Identity & configuration".
 *
 * Four tables, all of them small, one of them load-bearing in a way its size
 * does not suggest. `crisis_plan` is separated from `setting` deliberately, and
 * §9.2 says why: "so it is never mixed with settings and never accidentally
 * cleared." A settings reset that wipes a safety plan is not a configuration
 * bug, it is a clinical one.
 */

import { sql } from 'drizzle-orm';
import { boolean, check, index, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';

import { appRole, authStrategy, consentScope } from './enums';
import { entityColumns, instant, reference, rowTimestamps } from './columns';

/**
 * The operator. Exactly one row, forever (C1).
 *
 * The singleton is enforced in the database rather than trusted to the
 * application. C1 — "single user, forever" — is the constraint that eliminates
 * multi-tenancy, permission models, and conflict resolution from the entire
 * architecture; if a second profile row can appear, every query that assumes
 * one becomes subtly wrong and nothing fails loudly.
 *
 * Clinical context lives here rather than in `condition` because it is
 * demographic background the system reads constantly — age for reference
 * ranges, sex for lab interpretation, timezone for every observation. Active
 * diagnoses are `condition` rows (§9.2); this is the standing context.
 */
export const profile = pgTable(
  'profile',
  {
    ...entityColumns,

    /** Always `true`. The check constraint plus the unique index is the singleton. */
    singleton: boolean().notNull().default(true),

    displayName: text().notNull(),
    dateOfBirth: text(),
    /** Free text, not an enum — this is context for lab reference ranges, not a category. */
    sexAtBirth: text(),

    /**
     * Default IANA zone. Every observation stores its own capture zone (§5.3);
     * this is the fallback when a client cannot supply one, and the zone the
     * Daily Close reminder is scheduled against.
     */
    timezone: text().notNull().default('Asia/Kolkata'),
    locale: text().notNull().default('en-GB'),
    /** `metric` or `imperial`. Display only — storage is always canonical units. */
    unitSystem: text().notNull().default('metric'),

    /** Standing clinical background, free text. Read by the AI layer under consent. */
    clinicalContext: text(),
  },
  (t) => [
    check('profile_singleton_true', sql`${t.singleton} IS TRUE`),
    uniqueIndex('profile_singleton_unique').on(t.singleton),
  ],
);

/**
 * A credential-holder, bound to the profile.
 *
 * ## Why this is not two columns on `profile`
 *
 * Putting `authSubjectId` and `role` on the singleton profile would work today
 * and would be the wrong shape tomorrow. C1 says there is one *operator*; it
 * does not say there is one *identity*. §2.2 contemplates a clinician holding a
 * shared export and §4.7 contemplates a delegate with emergency access to the
 * crisis plan — both are additional identities reading the same record, which
 * §2.5 is careful to distinguish from multi-tenancy: "a second user gets a
 * second instance", but a narrower view of one record is not a second user.
 *
 * With this table, granting that access is an INSERT. With two columns on
 * `profile`, it is a migration. The milestone asked for future roles to require
 * zero architectural change, and this is where that is paid for — one extra
 * table, one extra join on a path that runs once per request and is indexed.
 *
 * ## What lives here and what does not
 *
 * The `subjectId` is the auth provider's opaque identifier — Supabase's
 * `auth.users.id`. Deliberately `text`, not a foreign key into `auth.users`:
 * §5.4 uses Supabase as "hosted Postgres with auth and storage" precisely so
 * migrating away is "a connection-string change plus an auth swap, rather than
 * a rewrite". A foreign key into the provider's own schema would weld the two
 * together and make that swap a data migration.
 *
 * No credentials. No password hashes, no tokens, no recovery codes. Those stay
 * entirely with the provider, which is the one part of this system that is
 * genuinely better outsourced.
 */
export const authIdentity = pgTable(
  'auth_identity',
  {
    ...entityColumns,

    /** The provider's subject. Opaque, unique, never reused. */
    subjectId: text().notNull(),

    /**
     * Normalised lowercase, matching `normaliseEmail` in core.
     *
     * Stored despite the provider also holding it, because the allowlist check
     * and the audit trail both need it and neither should require a provider
     * round-trip to answer "who was this?" in year eight.
     */
    email: text().notNull(),

    profileId: reference()
      .notNull()
      .references(() => profile.id),

    role: appRole().notNull().default('owner'),

    /** Most recent successful authentication, and how. */
    lastSignInAt: instant(),
    lastStrategy: authStrategy(),

    /**
     * Revocation without deletion.
     *
     * Separate from `deletedAt`: a revoked identity is history worth keeping
     * legible — §9.4 keeps tombstones for exactly this reason — and a delegate
     * whose access ended is a different record from one that was created in
     * error. Both are refused; only one is a mistake.
     */
    disabledAt: instant(),
    disabledReason: text(),
  },
  (t) => [
    /* One row per provider subject. The uniqueness that makes linkSubject
     * idempotent under a race between two tabs. */
    uniqueIndex('auth_identity_subject_unique').on(t.subjectId),
    /* The per-request lookup: subject → role. Tombstones and revoked
     * identities excluded from the index, not merely from the result (§9.6). */
    index('auth_identity_active_idx')
      .on(t.subjectId)
      .where(sql`${t.disabledAt} IS NULL AND ${t.deletedAt} IS NULL`),
    index('auth_identity_email_idx').on(t.email),
  ],
);

/**
 * Typed key/value configuration (§9.2).
 *
 * The value is `jsonb` with its schema owned by the application — theme,
 * density, capture-rail configuration, notification preferences. A column per
 * setting would mean a migration every time a preference is added, which at C3
 * is friction with no corresponding safety benefit for data nobody will analyse
 * in year ten.
 *
 * AI consent scopes are the exception and get their own column: §10.10 requires
 * them to be queryable and auditable, and burying a privacy control inside an
 * untyped blob is how it ends up unreadable at exactly the wrong moment.
 */
export const setting = pgTable(
  'setting',
  {
    key: text().primaryKey(),
    value: jsonb().notNull(),
    /** What this setting controls, for a reader in year twelve. */
    description: text(),
    ...rowTimestamps,
  },
  (t) => [index('setting_key_idx').on(t.key)],
);

/**
 * Runtime toggles, including the AI kill switch (§9.2, §5.10).
 *
 * §5.10: the AI layer is "a sidecar, not a dependency — every feature in the
 * application must function correctly with the AI layer entirely disabled",
 * and the acceptance test for this flag is that the whole product still works
 * with it off.
 */
export const featureFlag = pgTable('feature_flag', {
  key: text().primaryKey(),
  enabled: boolean().notNull().default(false),
  description: text().notNull(),
  /** Why it was last flipped. Diagnostics in month nine depend on this. */
  changeReason: text(),
  ...rowTimestamps,
});

/**
 * The Mind module's pre-written safety plan (§4.7, §9.2).
 *
 * §4.7 defines exactly how this is used, and the constraint is unusually
 * strict:
 *
 *   "Crisis-state awareness. Sustained severe readings surface one thing only:
 *    the user's own pre-configured crisis plan and contacts, entered by them
 *    when well. Not an insight. Not a suggestion. Not a model-generated
 *    message. A stored plan, shown back."
 *
 * Two consequences are encoded here. Content is user-authored only — no column
 * on this table may ever be written by the AI layer, and `consentScope` is
 * pinned to `none` so nothing here crosses an inference boundary. And it is
 * versioned like any entity but never soft-deleted in practice: a superseded
 * plan is replaced by a newer active one, so there is always something to show.
 */
export const crisisPlan = pgTable(
  'crisis_plan',
  {
    ...entityColumns,

    /** Only one plan is active at a time; older ones are retained for history. */
    isActive: boolean().notNull().default(true),

    /** Warning signs, in the user's own words. */
    warningSigns: text(),
    /** What has helped before. */
    copingStrategies: text(),
    /** Reasons to stay safe, written when well. */
    reasonsToLive: text(),

    /**
     * `[{ name, relationship, phone, notes }]`. Structured so the UI can offer a
     * one-tap call without parsing free text at the worst possible moment.
     */
    contacts: jsonb().notNull().default(sql`'[]'::jsonb`),
    /** Professional and emergency services. Same shape as `contacts`. */
    professionalContacts: jsonb().notNull().default(sql`'[]'::jsonb`),

    /**
     * Hard-pinned to `none`. This table never crosses an inference boundary,
     * and the constraint below makes that structural rather than a promise.
     */
    aiConsent: consentScope().notNull().default('none'),

    lastReviewedAt: instant(),
  },
  (t) => [
    check('crisis_plan_never_shared_with_ai', sql`${t.aiConsent} = 'none'`),
    // Partial unique: exactly one active plan, tombstones excluded (§9.6).
    uniqueIndex('crisis_plan_one_active')
      .on(t.isActive)
      .where(sql`${t.isActive} IS TRUE AND ${t.deletedAt} IS NULL`),
  ],
);
