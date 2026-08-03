/**
 * Protected layout — the server-side auth guard, and the shell.
 *
 * The guard rationale is unchanged from the identity milestone: the proxy can
 * only ask "is there a session?" because the edge has no database, so this is
 * where the allowlist and the role are actually resolved (§5.4).
 *
 * The shell mounts here rather than in the root layout because a signed-out
 * visitor must not see navigation — a sidebar listing Body and Mind on a
 * sign-in page tells an attacker what the account contains.
 */

import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { visiblePermissions } from '@naitikos/api';

import { SessionProvider } from '@/features/auth';
import { AppShell } from '@/components/shell';
import { getAuthState } from '@/lib/auth/session';
import { SIGN_IN_PATH } from '@/lib/auth/routes';

export const dynamic = 'force-dynamic';

export default async function ProtectedLayout({
  children,
}: {
  children: ReactNode;
}): Promise<ReactNode> {
  const state = await getAuthState();

  if (state.status !== 'authenticated') {
    redirect(SIGN_IN_PATH);
  }

  const { actor } = state;

  return (
    <SessionProvider
      session={{
        email: actor.email,
        role: actor.role,
        strategy: actor.strategy,
        authenticatedAt: actor.authenticatedAt.toISOString(),
        permissions: visiblePermissions(state),
      }}
    >
      <AppShell account={{ email: actor.email, role: actor.role }}>{children}</AppShell>
    </SessionProvider>
  );
}
