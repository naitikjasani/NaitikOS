/**
 * The authorization model, tested exhaustively.
 *
 * §11.4 holds `core` to the highest coverage bar in the repo because "its bugs
 * are the expensive kind". An authorization bug is the expensive kind twice
 * over: it fails open, silently, and the failure is invisible until it matters.
 *
 * These tests are deliberately written against the *matrix* rather than against
 * individual cases, so a role added later is covered the moment it is declared
 * rather than the moment someone remembers to write a test for it.
 */

import { describe, expect, it } from 'vitest';
import { isErr, isOk } from '@naitikos/shared';

import type { Actor } from './actor';
import { ANONYMOUS, STEP_UP_WINDOW_MS, authenticated, authorize, can, isAuthenticated } from './actor';
import { createAllowlist, checkAllowlist, normaliseEmail } from './allowlist';
import {
  PERMISSIONS,
  ROLES,
  ROLE_PERMISSIONS,
  STEP_UP_PERMISSIONS,
  isPermission,
  isRole,
  requiresStepUp,
  roleHasPermission,
} from './roles';
import { AUTH_STRATEGIES, STRATEGY_REGISTRY, enabledStrategies, isOAuthStrategy } from './strategies';

const NOW = new Date('2026-08-03T12:00:00Z');

function actor(overrides: Partial<Actor> = {}): Actor {
  return {
    subjectId: 'sub-1',
    email: 'operator@example.com',
    role: 'owner',
    authenticatedAt: NOW,
    strategy: 'password',
    ...overrides,
  };
}

describe('roles and permissions', () => {
  it('gives every declared role an entry in the matrix', () => {
    // The property that makes "adding a role changes nothing else" true: if a
    // role exists without permissions, every guard silently denies it and the
    // failure looks like a bug elsewhere.
    for (const role of ROLES) {
      expect(ROLE_PERMISSIONS[role], `role ${role} has no matrix entry`).toBeDefined();
    }
  });

  it('grants only declared permissions', () => {
    for (const role of ROLES) {
      for (const permission of ROLE_PERMISSIONS[role]) {
        expect(isPermission(permission), `${role} grants unknown "${permission}"`).toBe(true);
      }
    }
  });

  it('gives the owner everything', () => {
    // C1: one human, nobody to withhold from.
    for (const permission of PERMISSIONS) {
      expect(roleHasPermission('owner', permission)).toBe(true);
    }
  });

  it('withholds the journal from clinicians', () => {
    // §4.7: journal content is the most sensitive data in the system. A shared
    // clinical export carries a medication history, not a diary.
    expect(roleHasPermission('clinician', 'journal:read')).toBe(false);
    expect(roleHasPermission('clinician', 'medical:read')).toBe(true);
  });

  it('gives no role except owner any write access to the journal', () => {
    for (const role of ROLES) {
      if (role === 'owner') continue;
      expect(roleHasPermission(role, 'journal:write'), `${role} may write the journal`).toBe(false);
    }
  });

  it('denies the nightly job the journal and the export', () => {
    // A process that runs unattended at 03:00 and can both read the diary and
    // produce an archive is an exfiltration path with nobody watching (C3).
    expect(roleHasPermission('service', 'journal:read')).toBe(false);
    expect(roleHasPermission('service', 'export:execute')).toBe(false);
    expect(roleHasPermission('service', 'security:manage')).toBe(false);
    // It still needs to write the derivations it exists to produce.
    expect(roleHasPermission('service', 'observation:write')).toBe(true);
  });

  it('restricts every non-owner role to a strict subset of the owner', () => {
    // A role that can do something the owner cannot is a modelling error.
    for (const role of ROLES) {
      for (const permission of ROLE_PERMISSIONS[role]) {
        expect(roleHasPermission('owner', permission)).toBe(true);
      }
    }
  });

  it('marks export and key access as step-up, and nothing else', () => {
    // §5.4 names exactly these.
    expect(requiresStepUp('export:execute')).toBe(true);
    expect(requiresStepUp('security:manage')).toBe(true);
    expect(requiresStepUp('observation:read')).toBe(false);

    for (const permission of STEP_UP_PERMISSIONS) {
      expect(isPermission(permission)).toBe(true);
    }
  });

  it('narrows untrusted strings', () => {
    expect(isRole('owner')).toBe(true);
    expect(isRole('admin')).toBe(false);
    expect(isRole(null)).toBe(false);
    expect(isPermission('observation:read')).toBe(true);
    expect(isPermission('observation:delete')).toBe(false);
  });
});

describe('authorize', () => {
  it('refuses an anonymous caller with 401-shaped error', () => {
    const result = authorize(ANONYMOUS, 'observation:read', { now: NOW });

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      // "Sign in" is actionable; "forbidden" would not be.
      expect(result.error.kind).toBe('unauthenticated');
    }
  });

  it('permits a held permission', () => {
    const result = authorize(authenticated(actor()), 'observation:read', { now: NOW });

    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value.role).toBe('owner');
  });

  it('refuses a permission the role does not hold', () => {
    const result = authorize(
      authenticated(actor({ role: 'clinician' })),
      'journal:read',
      { now: NOW },
    );

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.kind).toBe('forbidden');
      if (result.error.kind === 'forbidden') {
        expect(result.error.reason).toBe('insufficient_permission');
        // Re-authenticating cannot help, so the client must not prompt.
        expect(result.error.stepUpRequired).toBe(false);
      }
    }
  });

  it('checks the permission before the step-up freshness', () => {
    // A caller who will never hold export:execute should be refused outright,
    // not sent to re-authenticate and then refused anyway.
    const stale = new Date(NOW.getTime() - STEP_UP_WINDOW_MS - 1000);
    const result = authorize(
      authenticated(actor({ role: 'clinician', authenticatedAt: stale })),
      'export:execute',
      { now: NOW },
    );

    expect(isErr(result)).toBe(true);
    if (isErr(result) && result.error.kind === 'forbidden') {
      expect(result.error.reason).toBe('insufficient_permission');
    }
  });

  it('permits a step-up permission inside the window', () => {
    const recent = new Date(NOW.getTime() - 60_000);
    const result = authorize(
      authenticated(actor({ authenticatedAt: recent })),
      'export:execute',
      { now: NOW },
    );

    expect(isOk(result)).toBe(true);
  });

  it('demands step-up outside the window', () => {
    const stale = new Date(NOW.getTime() - STEP_UP_WINDOW_MS - 1);
    const result = authorize(
      authenticated(actor({ authenticatedAt: stale })),
      'export:execute',
      { now: NOW },
    );

    expect(isErr(result)).toBe(true);
    if (isErr(result) && result.error.kind === 'forbidden') {
      expect(result.error.reason).toBe('step_up_required');
      expect(result.error.stepUpRequired).toBe(true);
    }
  });

  it('treats a future authentication time as stale, not fresh', () => {
    // Clock skew (§5.8). Failing closed is the correct direction for an export.
    const future = new Date(NOW.getTime() + 60_000);
    const result = authorize(
      authenticated(actor({ authenticatedAt: future })),
      'export:execute',
      { now: NOW },
    );

    expect(isErr(result)).toBe(true);
    if (isErr(result) && result.error.kind === 'forbidden') {
      expect(result.error.reason).toBe('step_up_required');
    }
  });

  it('leaves non-step-up permissions unaffected by session age', () => {
    // §5.4's thirty-day sliding session exists so daily use is not interrupted
    // (P1). Only the sensitive operations re-prompt.
    const ancient = new Date(NOW.getTime() - 29 * 24 * 60 * 60 * 1000);
    const result = authorize(
      authenticated(actor({ authenticatedAt: ancient })),
      'observation:write',
      { now: NOW },
    );

    expect(isOk(result)).toBe(true);
  });
});

describe('can', () => {
  it('ignores step-up so the UI does not hide controls', () => {
    // Hiding the export button because the session is twenty minutes old would
    // be baffling. The control renders; the guard prompts.
    const stale = new Date(NOW.getTime() - STEP_UP_WINDOW_MS - 1);
    expect(can(authenticated(actor({ authenticatedAt: stale })), 'export:execute')).toBe(true);
  });

  it('is false for anonymous', () => {
    expect(can(ANONYMOUS, 'observation:read')).toBe(false);
  });

  it('narrows AuthState', () => {
    const state = authenticated(actor());
    expect(isAuthenticated(state)).toBe(true);
    expect(isAuthenticated(ANONYMOUS)).toBe(false);
  });
});

describe('allowlist', () => {
  it('refuses to be constructed empty', () => {
    // The single most important line in allowlist.ts: a misconfiguration must
    // be impossible to deploy, not merely unlikely.
    expect(() => createAllowlist([])).toThrow(/allowlist is empty/i);
    expect(() => createAllowlist(['', '  '])).toThrow(/allowlist is empty/i);
  });

  it('normalises case and surrounding whitespace', () => {
    expect(normaliseEmail('  Operator@Example.COM ')).toBe('operator@example.com');

    const list = createAllowlist(['  Operator@Example.COM ']);
    expect(list.permits('operator@example.com')).toBe(true);
    expect(list.permits('OPERATOR@EXAMPLE.COM')).toBe(true);
  });

  it('does not apply Gmail delivery conventions', () => {
    // Dots and plus-tags are delivery rules, not identity rules. Treating them
    // as equivalent would accept addresses the list was never given.
    const list = createAllowlist(['a.b@gmail.com']);
    expect(list.permits('ab@gmail.com')).toBe(false);
    expect(list.permits('a.b+tag@gmail.com')).toBe(false);
    expect(list.permits('a.b@gmail.com')).toBe(true);
  });

  it('rejects an unknown address as forbidden, never as unauthenticated', () => {
    // The caller proved who they are. Sending them back to sign in would loop
    // them forever against a credential that works.
    const list = createAllowlist(['operator@example.com']);
    const result = checkAllowlist(list, 'someone.else@example.com');

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.kind).toBe('forbidden');
      if (result.error.kind === 'forbidden') {
        expect(result.error.reason).toBe('not_allowlisted');
      }
    }
  });

  it('does not name the address or the list in the refusal', () => {
    const list = createAllowlist(['operator@example.com']);
    const result = checkAllowlist(list, 'intruder@example.com');

    if (isErr(result)) {
      const serialised = JSON.stringify(result.error);
      expect(serialised).not.toContain('operator@example.com');
      expect(serialised).not.toContain('intruder@example.com');
    }
  });
});

describe('strategy registry', () => {
  it('describes every declared strategy', () => {
    for (const id of AUTH_STRATEGIES) {
      const descriptor = STRATEGY_REGISTRY[id];
      expect(descriptor.id).toBe(id);
      expect(descriptor.note.length, `${id} has no explanatory note`).toBeGreaterThan(0);
    }
  });

  it('has password enabled and the blueprint-preferred factors not yet', () => {
    // Documents the §5.4 divergence as an assertion rather than a comment, so
    // enabling passkey later updates a test rather than silently drifting.
    expect(STRATEGY_REGISTRY.password.enabled).toBe(true);
    expect(STRATEGY_REGISTRY.password.preferred).toBe(false);
    expect(STRATEGY_REGISTRY.passkey.preferred).toBe(true);
    expect(STRATEGY_REGISTRY.magic_link.preferred).toBe(true);
  });

  it('keeps OAuth off', () => {
    expect(STRATEGY_REGISTRY.oauth_google.enabled).toBe(false);
    expect(isOAuthStrategy('oauth_google')).toBe(true);
    expect(isOAuthStrategy('password')).toBe(false);
  });

  it('orders preferred strategies first', () => {
    const enabled = enabledStrategies();
    expect(enabled.every((s) => s.enabled)).toBe(true);

    const preferredFlags = enabled.map((s) => Number(s.preferred));
    const sorted = [...preferredFlags].sort((a, b) => b - a);
    expect(preferredFlags).toEqual(sorted);
  });
});
