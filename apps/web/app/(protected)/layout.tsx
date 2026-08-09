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
import { QueryProvider } from '@/lib/query/QueryProvider';
import { getAuthState } from '@/lib/auth/session';
import { RouteTelemetry } from '@/lib/telemetry/RouteTelemetry';
import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';
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
      {/*
        The query client wraps only the protected tree. A signed-out visitor has
        nothing to cache, and a persisted cache mounted on the sign-in page
        would write an empty payload over a good one on every visit.
      */}
      <QueryProvider>
        {/*
          §5.11's telemetry, mounted inside the guard rather than at the root: a
          signed-out visitor's navigation is not the operator's, and every §1.4
          metric is about the operator's use.
        */}
        <RouteTelemetry />
        <AppShell account={{ email: actor.email, role: actor.role }} zone={DEFAULT_PROFILE_ZONE}>
          {children}
        </AppShell>
      </QueryProvider>
    </SessionProvider>
  );
}
