'use client';

/**
 * Proves the session round-tripped, and provides sign-out.
 *
 * §6.2 puts app-level composition here rather than in a feature: this is not
 * part of the auth surface, it is the shell reading from it. It imports the
 * auth feature only through its public API (§7.4 R1).
 */

import type { ReactNode } from 'react';

import { useSession } from '@/features/auth';

export function SignedInPanel(): ReactNode {
  const { session, can, signOut, isSigningOut } = useSession();

  if (session === null) return null;

  return (
    <div>
      <dl style={{ margin: '0 0 calc(var(--space) * 3)', fontSize: '0.9rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space)' }}>
          <dt className="muted">Account</dt>
          <dd style={{ margin: 0 }}>{session.email}</dd>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space)' }}>
          <dt className="muted">Role</dt>
          <dd style={{ margin: 0 }}>{session.role}</dd>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space)' }}>
          <dt className="muted">Signed in with</dt>
          <dd style={{ margin: 0 }}>{session.strategy}</dd>
        </div>
      </dl>

      {/*
        `can()` is advisory — it decides what to render, never what is allowed.
        Shown here because it is the one place the permission plumbing is
        currently observable end to end.
      */}
      <p className="muted" style={{ marginBottom: 'calc(var(--space) * 3)' }}>
        {can('export:execute')
          ? 'Export is permitted for this role, and will require re-authentication.'
          : 'Export is not permitted for this role.'}
      </p>

      <button
        className="button"
        type="button"
        onClick={() => void signOut()}
        disabled={isSigningOut}
      >
        {isSigningOut ? 'Signing out…' : 'Sign out'}
      </button>
    </div>
  );
}
