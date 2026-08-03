/**
 * Protected layout — the server-side auth guard for every private route.
 *
 * ## Why this exists when middleware already redirects
 *
 * Middleware is a coarse gate: it can only ask "is there a Supabase session?"
 * because the edge runtime has no database and therefore cannot check the
 * allowlist or resolve a role. A caller with a valid session for a
 * non-allowlisted account passes middleware.
 *
 * This layout is the real gate. It calls `getAuthState()`, which runs the
 * allowlist, the role lookup, and the audit write — and it runs on the server
 * for every protected render, which is what §5.4 means by "checked server-side
 * on every request".
 *
 * Defence in depth, and the two layers fail differently: middleware saves a
 * render, this one decides.
 */

import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { visiblePermissions } from '@naitikos/api';

import { SessionProvider } from '@/features/auth';
import { getAuthState } from '@/lib/auth/session';
import { SIGN_IN_PATH } from '@/lib/auth/routes';

/**
 * §5.6: "Next.js route caching is disabled for all personal data. Every data
 * route is dynamic."
 *
 * Load-bearing here beyond caching: a statically rendered protected layout
 * would evaluate its auth check at build time, once, for everyone.
 */
export const dynamic = 'force-dynamic';

export default async function ProtectedLayout({
  children,
}: {
  children: ReactNode;
}): Promise<ReactNode> {
  const state = await getAuthState();

  if (state.status !== 'authenticated') {
    // No `?next=` here. Middleware already captured the intended destination
    // on the way in; reaching this branch means the session failed a check
    // middleware could not perform, and sending the user back to a deep link
    // they cannot reach would loop them.
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
        // Sent so the UI can render without a second round trip. Advisory —
        // re-checked server-side on every request that uses one.
        permissions: visiblePermissions(state),
      }}
    >
      {children}
    </SessionProvider>
  );
}
