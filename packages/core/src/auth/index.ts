/**
 * Identity, authentication, and authorization — the durable half.
 *
 * Nothing here knows about Supabase, cookies, HTTP, or React. §5.4 puts the
 * authorization decision in the API layer "where it is testable, readable, and
 * version-controlled"; this package is what that layer calls, and keeping it
 * framework-free is what makes the eventual provider swap (§5.4) a swap.
 *
 * The one-line map:
 *
 *   ProviderIdentity ──resolveActor──▶ AuthState ──authorize──▶ Actor
 *                      (allowlist,                 (permission,
 *                       role, audit)                step-up)
 */

export type { Role, Permission } from './roles';
export {
  ROLES,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  STEP_UP_PERMISSIONS,
  roleHasPermission,
  requiresStepUp,
  isRole,
  isPermission,
} from './roles';

export type { Actor, AuthState, AuthorizeOptions } from './actor';
export { ANONYMOUS, STEP_UP_WINDOW_MS, authenticated, isAuthenticated, authorize, can } from './actor';

export type { Allowlist } from './allowlist';
export { createAllowlist, checkAllowlist, normaliseEmail } from './allowlist';

export type { AuthStrategy, StrategyDescriptor } from './strategies';
export {
  AUTH_STRATEGIES,
  STRATEGY_REGISTRY,
  OAUTH_STRATEGIES,
  enabledStrategies,
  isStrategyEnabled,
  isAuthStrategy,
  isOAuthStrategy,
} from './strategies';

export type {
  AuthProvider,
  ProviderIdentity,
  PasswordCredentials,
  IdentityRepository,
  AuthAuditRecorder,
  AuthAuditEvent,
} from './ports';

export type { ResolveDependencies } from './resolve';
export { resolveActor } from './resolve';

export type {
  Theme,
  Density,
  MotionPreference,
  UnitSystem,
  NotificationCategory,
  NotificationPreferences,
  Preferences,
  ProfileIdentity,
} from './preferences';
export {
  THEMES,
  DENSITIES,
  MOTION_PREFERENCES,
  UNIT_SYSTEMS,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_DAILY_CAP,
  DEFAULT_THEME,
  DEFAULT_DENSITY,
  DEFAULT_MOTION,
  DEFAULT_UNIT_SYSTEM,
  DEFAULT_NOTIFICATION_PREFERENCES,
  DEFAULT_PREFERENCES,
  DEFAULT_PROFILE_IDENTITY,
  UNIT_SYSTEM_IS_DISPLAY_ONLY,
  parsePreferences,
  validatePreferences,
  isValidTimezone,
  isValidLocale,
} from './preferences';
