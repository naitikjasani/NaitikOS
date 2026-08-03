/**
 * Repositories — the implementations of ports `core` declares (§6.2).
 *
 * Every one is a factory taking a {@link Database}, never a module-level
 * singleton reading an ambient connection. That is what lets a test pass a
 * transaction that rolls back, and what stops a serverless invocation
 * inheriting another request's client.
 */

export { createIdentityRepository, SINGLETON_PROFILE_ID } from './identity.repository';
export { createAuthAuditRecorder, AUTH_ENTITY_TYPE } from './audit.repository';
export type { AuditRecorderOptions } from './audit.repository';
export { createProfileRepository, PREFERENCES_KEY } from './profile.repository';
export type { ProfileRepository } from './profile.repository';
