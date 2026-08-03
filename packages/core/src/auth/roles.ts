/**
 * Roles and permissions.
 *
 * ## Why this exists at all, given C1
 *
 * There is exactly one human writing to this database, and §5.4 warns against
 * over-engineering here: "Single user (C1), which makes this simpler than
 * instinct suggests — and the instinct to over-engineer it should be resisted."
 *
 * So this file is deliberately *data*, not machinery. There is no role
 * hierarchy, no inheritance graph, no dynamic permission assignment, no
 * database-driven policy engine. There is a frozen matrix of role → permissions
 * and a function that reads it.
 *
 * What that buys is the property the milestone asks for: adding a role later is
 * one entry in {@link ROLE_PERMISSIONS} and one value in the `app_role` enum.
 * No call site changes, because no call site ever asks "is this the owner?" —
 * they ask "may this actor do X?", which is the question that stays stable when
 * the answer changes.
 *
 * ## The rule that keeps it honest
 *
 * Never branch on a role. Branch on a permission. `if (actor.role === 'owner')`
 * is the line that has to be revisited when a second role appears;
 * `if (can(actor, 'observation:write'))` is not. The lint-visible difference is
 * small and the twenty-year difference is not.
 */

/**
 * Every role the system can express.
 *
 * `owner` is the operator — the single human of C1. The others are not
 * speculative features; they are the three expansions §2.4 and §4.7 actually
 * contemplate, written down so their permission sets are considered now rather
 * than improvised later:
 *
 *   - `clinician` — §2.2's Consultation Pack and §4.7's "therapist-shared export
 *     with granular consent". Read-only, and blind to the journal.
 *   - `delegate` — a trusted person with emergency access to the crisis plan
 *     (§4.7) and nothing else.
 *   - `service` — the nightly job (§5.2) and the migration runner. Not a human.
 *     It writes derivations and reads widely, but may never read the journal or
 *     export, because a compromised job should not be able to exfiltrate.
 *
 * §2.5 forbids multi-tenancy outright — "a second user gets a second instance".
 * None of these roles is a second *user*; they are narrower views of the one
 * record, which is a different thing.
 */
export const ROLES = ['owner', 'clinician', 'delegate', 'service'] as const;

export type Role = (typeof ROLES)[number];

/**
 * Every permission the system can check.
 *
 * Named `resource:action`. Kept coarse on purpose — a permission per table
 * would be five hundred strings nobody can reason about, and §5.4's objection
 * to encoding domain rules in RLS ("hard to test, hard to diff meaningfully,
 * hard to reason about two years later") applies just as well to an
 * over-decomposed permission set.
 *
 * The separations that exist are the ones where the blueprint draws a line:
 * journal from other clinical data (§4.7), export from read (§5.4 requires
 * step-up for it), and the AI layer from everything (§5.10's kill switch).
 */
export const PERMISSIONS = [
  /* The substrate. */
  'observation:read',
  'observation:write',

  /* Clinical records — conditions, medications, labs, appointments. */
  'medical:read',
  'medical:write',

  /**
   * Journal, therapy notes, and the crisis plan.
   *
   * Separate from `medical:*` because §4.7 classifies journal content as "the
   * most sensitive data in the system". A clinician export should be able to
   * carry a medication history without carrying a diary.
   */
  'journal:read',
  'journal:write',

  /** Sensitive-tier media — skin and physique photography (§5.5). */
  'media:read',
  'media:write',

  /** Configuration, feature flags, capture rail. */
  'settings:read',
  'settings:write',

  /**
   * The complete archive (§9.10). Step-up authentication is required
   * regardless of session age (§5.4) — a permission alone is not sufficient.
   */
  'export:execute',

  /** Encryption key access and hard purge. Step-up, always. */
  'security:manage',

  /** Invoking the AI layer (§10). */
  'ai:invoke',

  /** Reading the permanent audit trail (§9.4). */
  'audit:read',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * The matrix. This is the entire authorization model.
 *
 * Adding a role means adding a row. Nothing else in the codebase changes.
 */
export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = Object.freeze({
  /** The operator. Everything — C1 means there is nobody to withhold from. */
  owner: PERMISSIONS,

  /**
   * A clinician holding a shared export. Read-only, and explicitly *not*
   * `journal:read`: §4.7's "therapist-shared export with granular consent" is
   * about therapy notes the user chose to share, not standing access to a diary.
   */
  clinician: ['observation:read', 'medical:read', 'audit:read'],

  /**
   * Emergency access. §4.7 specifies that a crisis surfaces "the user's own
   * pre-configured crisis plan and contacts, entered by them when well" — a
   * delegate needs exactly that and nothing more.
   */
  delegate: ['journal:read'],

  /**
   * The nightly job (§5.2). Writes derived observations, reads what it needs to
   * derive them.
   *
   * Deliberately excluded: `journal:*`, `export:execute`, `security:manage`. An
   * automated process that can read the diary and produce an archive is an
   * exfiltration path that runs unattended at 03:00, which is precisely when
   * nobody is watching (C3).
   */
  service: ['observation:read', 'observation:write', 'medical:read', 'settings:read', 'ai:invoke'],
});

/**
 * Permissions that require step-up re-authentication regardless of session age.
 *
 * §5.4: "Sensitive operations — export, encryption-key access, deletion —
 * require step-up re-authentication regardless of session age." Holding the
 * permission is necessary and not sufficient; {@link requiresStepUp} is the
 * other half, and the guard layer checks both.
 */
export const STEP_UP_PERMISSIONS: readonly Permission[] = Object.freeze([
  'export:execute',
  'security:manage',
]);

/** Does this role hold this permission? */
export function roleHasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/** Does this permission demand a fresh authentication, whoever holds it? */
export function requiresStepUp(permission: Permission): boolean {
  return STEP_UP_PERMISSIONS.includes(permission);
}

/** Narrow an untrusted string — a database column, a token claim — to a Role. */
export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/** Narrow an untrusted string to a Permission. */
export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && (PERMISSIONS as readonly string[]).includes(value);
}
