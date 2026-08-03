/**
 * Auth flow — the whole chain, end to end, with no network.
 *
 * Every other test file covers one layer. This one wires them together in the
 * order a real request does:
 *
 *     credentials → AuthProvider → resolveActor → authorize → HTTP
 *
 * It exists because each layer passing in isolation does not prove the seams
 * hold. The bugs this catches are the ones where a refusal is produced and then
 * dropped, or an allowlist rejection is reported as a 401 and loops the user
 * back to a sign-in page that will keep working.
 *
 * The fakes implement the same ports the Supabase adapter does — which is the
 * point of §6.2's dependency inversion, demonstrated rather than asserted.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import type { Result } from '@naitikos/shared';
import { err, isErr, isOk, ok } from '@naitikos/shared';
import type {
  AuthAuditEvent,
  AuthAuditRecorder,
  AuthProvider,
  DomainError,
  IdentityRepository,
  PasswordCredentials,
  ProviderIdentity,
  Role,
} from '@naitikos/core';
import {
  authorize,
  createAllowlist,
  fixedClock,
  manualClock,
  resolveActor,
  unauthenticatedError,
  STEP_UP_WINDOW_MS,
} from '@naitikos/core';
import { requirePermission, toHttpError } from '@naitikos/api';

const ALLOWED = 'operator@example.com';
const SUBJECT = 'subject-1';
const NOW = new Date('2026-08-03T12:00:00Z');

/* -------------------------------------------------------------------------
 * Fakes
 * ---------------------------------------------------------------------- */

class FakeAudit implements AuthAuditRecorder {
  readonly events: AuthAuditEvent[] = [];
  record(event: AuthAuditEvent): Promise<void> {
    this.events.push(event);
    return Promise.resolve();
  }
  kinds(): string[] {
    return this.events.map((e) => e.kind);
  }
}

class FakeIdentities implements IdentityRepository {
  private readonly roles = new Map<string, Role>();

  seed(subjectId: string, role: Role): void {
    this.roles.set(subjectId, role);
  }
  findRoleBySubject(subjectId: string): Promise<Result<Role | null, DomainError>> {
    return Promise.resolve(ok(this.roles.get(subjectId) ?? null));
  }
  linkSubject(subjectId: string): Promise<Result<Role, DomainError>> {
    const existing = this.roles.get(subjectId);
    if (existing !== undefined) return Promise.resolve(ok(existing));
    this.roles.set(subjectId, 'owner');
    return Promise.resolve(ok('owner'));
  }
}

/**
 * A provider that behaves like the Supabase adapter, including the property
 * that matters most: it never distinguishes "no such user" from "wrong
 * password".
 */
function fakeProvider(options: {
  password: string;
  email?: string;
  emailVerified?: boolean;
  authenticatedAt?: Date;
}): AuthProvider {
  const identity: ProviderIdentity = {
    subjectId: SUBJECT,
    email: options.email ?? ALLOWED,
    emailVerified: options.emailVerified ?? true,
    authenticatedAt: options.authenticatedAt ?? NOW,
    strategy: 'password',
  };

  return {
    signInWithPassword: (credentials: PasswordCredentials) =>
      Promise.resolve(
        credentials.password === options.password
          ? ok(identity)
          : err(unauthenticatedError('invalid_token', 'Those credentials are not valid.')),
      ),
    getIdentity: () => Promise.resolve(ok(identity)),
    refresh: () => Promise.resolve(ok(identity)),
    signOut: () => Promise.resolve(ok(undefined)),
  };
}

/** The sign-in path, assembled exactly as the route handler assembles it. */
async function signInFlow(
  provider: AuthProvider,
  deps: { identities: IdentityRepository; audit: AuthAuditRecorder; now: Date; allowlist: string[] },
  credentials: PasswordCredentials,
) {
  const identity = await provider.signInWithPassword(credentials);
  if (isErr(identity)) return identity;

  return resolveActor(identity.value, {
    allowlist: createAllowlist(deps.allowlist),
    identities: deps.identities,
    audit: deps.audit,
    now: deps.now,
  });
}

/* -------------------------------------------------------------------------
 * Tests
 * ---------------------------------------------------------------------- */

describe('sign-in flow', () => {
  let audit: FakeAudit;
  let identities: FakeIdentities;

  beforeEach(() => {
    audit = new FakeAudit();
    identities = new FakeIdentities();
  });

  const deps = () => ({ identities, audit, now: NOW, allowlist: [ALLOWED] });

  it('signs in an allowlisted operator and grants the owner role', async () => {
    const result = await signInFlow(fakeProvider({ password: 'correct-horse-battery' }), deps(), {
      email: ALLOWED,
      password: 'correct-horse-battery',
    });

    expect(isOk(result)).toBe(true);
    if (isOk(result) && result.value.status === 'authenticated') {
      expect(result.value.actor.role).toBe('owner');
      expect(result.value.actor.email).toBe(ALLOWED);
    }
  });

  it('refuses a wrong password as 401, never 403', async () => {
    // 401 means "sign in"; 403 would mean "signing in again will not help",
    // which is the opposite of true here.
    const result = await signInFlow(fakeProvider({ password: 'correct' }), deps(), {
      email: ALLOWED,
      password: 'wrong',
    });

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(toHttpError(result.error, 't').status).toBe(401);
    }
  });

  it('refuses a valid credential for an unlisted address as 403, not 401', async () => {
    // The critical distinction. A 401 here would bounce a user with working
    // credentials back to sign-in forever.
    const provider = fakeProvider({ password: 'correct', email: 'intruder@example.com' });
    const result = await signInFlow(provider, deps(), {
      email: 'intruder@example.com',
      password: 'correct',
    });

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(toHttpError(result.error, 't').status).toBe(403);
    }
    expect(audit.kinds()).toContain('allowlist_rejected');
  });

  it('gives an unlisted address and an unverified one identical responses', async () => {
    // Distinguishing them confirms to an attacker that they guessed the
    // address, which with a one-entry allowlist is the whole secret.
    const unlisted = await signInFlow(
      fakeProvider({ password: 'p', email: 'other@example.com' }),
      deps(),
      { email: 'other@example.com', password: 'p' },
    );
    const unverified = await signInFlow(
      fakeProvider({ password: 'p', emailVerified: false }),
      deps(),
      { email: ALLOWED, password: 'p' },
    );

    if (isErr(unlisted) && isErr(unverified)) {
      const a = toHttpError(unlisted.error, 't');
      const b = toHttpError(unverified.error, 't');
      expect(a.status).toBe(b.status);
      expect(a.body.error.code).toBe(b.body.error.code);
      expect(a.body.error.message).toBe(b.body.error.message);
    }
  });

  it('never puts a token or a password in any response', async () => {
    const result = await signInFlow(fakeProvider({ password: 'secret-value-here' }), deps(), {
      email: ALLOWED,
      password: 'secret-value-here',
    });

    // The session that would be serialised carries no credential material.
    if (isOk(result) && result.value.status === 'authenticated') {
      const serialised = JSON.stringify(result.value.actor);
      expect(serialised).not.toContain('secret-value-here');
      expect(serialised).not.toMatch(/accessToken|refreshToken/);
    }
  });

  it('audits the successful sign-in without recording the password', async () => {
    await signInFlow(fakeProvider({ password: 'p' }), deps(), { email: ALLOWED, password: 'p' });

    const serialised = JSON.stringify(audit.events);
    expect(serialised).not.toContain('"p"');
  });
});

describe('authorization after sign-in', () => {
  let audit: FakeAudit;
  let identities: FakeIdentities;

  beforeEach(() => {
    audit = new FakeAudit();
    identities = new FakeIdentities();
  });

  async function signedInAs(role: Role, authenticatedAt = NOW) {
    identities.seed(SUBJECT, role);
    const provider = fakeProvider({ password: 'p', authenticatedAt });
    const result = await signInFlow(provider, { identities, audit, now: NOW, allowlist: [ALLOWED] }, {
      email: ALLOWED,
      password: 'p',
    });
    if (!isOk(result)) throw new Error('expected sign-in to succeed');
    return result.value;
  }

  it('permits an owner to read observations', async () => {
    const state = await signedInAs('owner');
    const decision = await requirePermission({ state, audit, now: NOW }, 'observation:read');

    expect(isOk(decision)).toBe(true);
  });

  it('refuses a clinician the journal, and audits it', async () => {
    const state = await signedInAs('clinician');
    const decision = await requirePermission({ state, audit, now: NOW }, 'journal:read');

    expect(isErr(decision)).toBe(true);
    if (isErr(decision)) expect(toHttpError(decision.error, 't').status).toBe(403);
    expect(audit.kinds()).toContain('authorization_denied');
  });

  it('records the refused permission server-side but never returns it', async () => {
    const state = await signedInAs('clinician');
    const decision = await requirePermission({ state, audit, now: NOW }, 'journal:read');

    // ADR 0004: logged, not returned.
    const denial = audit.events.find((e) => e.kind === 'authorization_denied');
    expect(denial?.permission).toBe('journal:read');

    if (isErr(decision)) {
      expect(JSON.stringify(toHttpError(decision.error, 't').body)).not.toContain('journal:read');
    }
  });

  it('demands step-up for export once the window has passed', async () => {
    const clock = manualClock(NOW);
    const state = await signedInAs('owner', clock.now());

    // Fresh: permitted.
    expect(isOk(authorize(state, 'export:execute', { now: clock.now() }))).toBe(true);

    clock.advance(STEP_UP_WINDOW_MS + 1000);

    const stale = await requirePermission({ state, audit, now: clock.now() }, 'export:execute');
    expect(isErr(stale)).toBe(true);
    if (isErr(stale)) {
      const mapped = toHttpError(stale.error, 't');
      expect(mapped.status).toBe(403);
      // The client needs this to know a prompt will help.
      expect(mapped.body.error.stepUpRequired).toBe(true);
    }
    expect(audit.kinds()).toContain('step_up_required');
  });

  it('does not demand step-up for ordinary reads on an old session', async () => {
    // §5.4's thirty-day sliding session exists so daily use is uninterrupted.
    const old = new Date(NOW.getTime() - 29 * 24 * 60 * 60 * 1000);
    const state = await signedInAs('owner', old);

    const decision = await requirePermission({ state, audit, now: NOW }, 'observation:write');
    expect(isOk(decision)).toBe(true);
  });

  it('reopens the window after re-authentication', async () => {
    const clock = manualClock(NOW);
    let state = await signedInAs('owner', clock.now());

    clock.advance(STEP_UP_WINDOW_MS + 1000);
    expect(isErr(authorize(state, 'export:execute', { now: clock.now() }))).toBe(true);

    // Step-up: the provider reports a fresh authentication time.
    state = await signedInAs('owner', clock.now());
    expect(isOk(authorize(state, 'export:execute', { now: clock.now() }))).toBe(true);
  });
});

describe('anonymous access', () => {
  it('produces a 401 with a challenge header for a protected permission', async () => {
    const audit = new FakeAudit();
    const decision = await requirePermission(
      { state: { status: 'anonymous' }, audit, now: fixedClock(NOW).now() },
      'observation:read',
    );

    expect(isErr(decision)).toBe(true);
    if (isErr(decision)) {
      const mapped = toHttpError(decision.error, 't');
      expect(mapped.status).toBe(401);
      expect(mapped.headers['WWW-Authenticate']).toContain('Bearer');
    }
  });
});
