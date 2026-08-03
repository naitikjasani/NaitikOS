/**
 * `resolveActor` is the only path from a valid credential to an authorized
 * actor, which makes it the single place the allowlist can be bypassed. These
 * tests exist to make that bypass impossible to introduce quietly.
 *
 * They also demonstrate the point of the port design (§6.2 dependency
 * inversion): every case below runs with no network, no database, and no
 * Supabase project — the fakes implement the same interfaces the real adapters
 * do.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { isErr, isOk, ok } from '@naitikos/shared';
import type { Result } from '@naitikos/shared';

import type { DomainError } from '../errors/domain-error';
import { isAuthenticated } from './actor';
import { createAllowlist } from './allowlist';
import type { AuthAuditEvent, AuthAuditRecorder, IdentityRepository, ProviderIdentity } from './ports';
import { resolveActor } from './resolve';
import type { Role } from './roles';

const NOW = new Date('2026-08-03T12:00:00Z');
const ALLOWED = 'operator@example.com';

function identity(overrides: Partial<ProviderIdentity> = {}): ProviderIdentity {
  return {
    subjectId: 'sub-1',
    email: ALLOWED,
    emailVerified: true,
    authenticatedAt: NOW,
    strategy: 'password',
    ...overrides,
  };
}

/** Records what was audited, so the tests can assert refusals are logged. */
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

/** In-memory identity store. `linkCalls` proves idempotency is exercised. */
class FakeIdentities implements IdentityRepository {
  linkCalls = 0;
  // A field rather than a constructor parameter property: `erasableSyntaxOnly`
  // (tsconfig base) requires every .ts file to be valid JS with types stripped,
  // and parameter properties emit runtime assignments.
  private readonly roles = new Map<string, Role>();

  findRoleBySubject(subjectId: string): Promise<Result<Role | null, DomainError>> {
    return Promise.resolve(ok(this.roles.get(subjectId) ?? null));
  }

  linkSubject(subjectId: string): Promise<Result<Role, DomainError>> {
    this.linkCalls += 1;
    // Idempotent: linking twice yields the same role, never a second profile.
    const existing = this.roles.get(subjectId);
    if (existing !== undefined) return Promise.resolve(ok(existing));
    this.roles.set(subjectId, 'owner');
    return Promise.resolve(ok('owner'));
  }
}

describe('resolveActor', () => {
  let audit: FakeAudit;
  let identities: FakeIdentities;

  const deps = () => ({
    allowlist: createAllowlist([ALLOWED]),
    identities,
    audit,
    now: NOW,
    traceId: 'trace-1',
  });

  beforeEach(() => {
    audit = new FakeAudit();
    identities = new FakeIdentities();
  });

  it('returns anonymous for no session, without auditing', () => {
    // A signed-out visitor loading a public page is an ordinary state, not a
    // security event. Auditing it would bury the real ones in noise.
    return resolveActor(null, deps()).then((result) => {
      expect(isOk(result)).toBe(true);
      if (isOk(result)) expect(result.value.status).toBe('anonymous');
      expect(audit.events).toHaveLength(0);
    });
  });

  it('resolves an allowlisted, verified identity to an owner', async () => {
    const result = await resolveActor(identity(), deps());

    expect(isOk(result)).toBe(true);
    if (isOk(result) && isAuthenticated(result.value)) {
      expect(result.value.actor.role).toBe('owner');
      expect(result.value.actor.email).toBe(ALLOWED);
      expect(result.value.actor.strategy).toBe('password');
    }
  });

  it('refuses an unverified address', async () => {
    // An unverified address has not been proven to belong to the person holding
    // the account, so allowlisting it would allowlist whoever registered it.
    const result = await resolveActor(identity({ emailVerified: false }), deps());

    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.kind).toBe('forbidden');
    expect(audit.kinds()).toContain('allowlist_rejected');
  });

  it('reports unverified and unlisted identically', async () => {
    // Distinguishing them tells an attacker whether they guessed the address.
    const unverified = await resolveActor(identity({ emailVerified: false }), deps());
    const unlisted = await resolveActor(identity({ email: 'other@example.com' }), deps());

    if (isErr(unverified) && isErr(unlisted)) {
      expect(unverified.error.code).toBe(unlisted.error.code);
      expect(unverified.error.message).toBe(unlisted.error.message);
    }
  });

  it('refuses an address that is not allowlisted, and audits it', async () => {
    const result = await resolveActor(identity({ email: 'intruder@example.com' }), deps());

    expect(isErr(result)).toBe(true);
    if (isErr(result) && result.error.kind === 'forbidden') {
      expect(result.error.reason).toBe('not_allowlisted');
    }
    expect(audit.kinds()).toContain('allowlist_rejected');
  });

  it('never touches the identity store for a rejected address', async () => {
    // A rejected identity should not cause a profile lookup, let alone create
    // one. This is the test that would fail if the allowlist check were moved
    // after the role lookup.
    await resolveActor(identity({ email: 'intruder@example.com' }), deps());
    expect(identities.linkCalls).toBe(0);
  });

  it('links the subject on first sign-in', async () => {
    // A fresh installation: the credential is valid and allowlisted, but no
    // profile row exists yet. That is a real state, not an error.
    const result = await resolveActor(identity(), deps());

    expect(isOk(result)).toBe(true);
    expect(identities.linkCalls).toBe(1);
  });

  it('does not re-link on subsequent sign-ins', async () => {
    await resolveActor(identity(), deps());
    await resolveActor(identity(), deps());

    expect(identities.linkCalls).toBe(1);
  });

  it('is idempotent under a race between two tabs', async () => {
    // C1: exactly one profile, forever. Two concurrent first sign-ins must not
    // produce two.
    const [a, b] = await Promise.all([
      resolveActor(identity(), deps()),
      resolveActor(identity(), deps()),
    ]);

    expect(isOk(a)).toBe(true);
    expect(isOk(b)).toBe(true);
    if (isOk(a) && isOk(b) && isAuthenticated(a.value) && isAuthenticated(b.value)) {
      expect(a.value.actor.role).toBe(b.value.actor.role);
    }
  });

  it('carries the trace id into the audit record', async () => {
    await resolveActor(identity({ email: 'intruder@example.com' }), deps());
    expect(audit.events[0]?.traceId).toBe('trace-1');
  });

  it('records only the declared audit fields', async () => {
    await resolveActor(identity({ email: 'intruder@example.com' }), deps());

    // §5.13: an audit record carries the identity being asserted and nothing
    // else about the request. Asserted as a key allowlist rather than by
    // pattern-matching the serialised form — `strategy: "password"` is the
    // *name* of the strategy and is legitimately recorded, so a naive
    // /password/ regex would flag correct behaviour.
    const permitted = new Set([
      'kind',
      'email',
      'subjectId',
      'strategy',
      'permission',
      'occurredAt',
      'traceId',
      'clientHint',
    ]);

    for (const event of audit.events) {
      for (const key of Object.keys(event)) {
        expect(permitted.has(key), `audit event leaked field "${key}"`).toBe(true);
      }
    }
  });

  it('normalises the email before it reaches the actor', async () => {
    const result = await resolveActor(identity({ email: '  OPERATOR@Example.com ' }), deps());

    expect(isOk(result)).toBe(true);
    if (isOk(result) && isAuthenticated(result.value)) {
      expect(result.value.actor.email).toBe(ALLOWED);
    }
  });
});
