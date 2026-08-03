'use client';

/**
 * Supplies the session to client components.
 *
 * Mounted by the protected layout with a session already resolved on the
 * server, so there is no loading state and no signed-out flash.
 */

import { useRouter } from 'next/navigation';
import { useCallback, type ReactNode } from 'react';

import { signOut as signOutRequest } from '../services/authClient';
import { SessionContext, useSessionValue, type ClientSession } from '../hooks/useSession';

export type SessionProviderProps = {
  readonly session: ClientSession | null;
  readonly children: ReactNode;
};

export function SessionProvider({ session, children }: SessionProviderProps): ReactNode {
  const router = useRouter();

  const handleSignOut = useCallback(async () => {
    await signOutRequest();

    /**
     * `refresh()` before `replace()`, and both are needed.
     *
     * `refresh()` discards the Router Cache, which still holds server-rendered
     * output produced while signed in. Without it, navigating back would render
     * that cached HTML — a medical record briefly visible after sign-out on a
     * device that was just handed to someone.
     *
     * `replace()` rather than `push()` so the protected page does not remain in
     * history for the back button to reach.
     */
    router.refresh();
    router.replace('/auth/sign-in');
  }, [router]);

  const value = useSessionValue(session, handleSignOut);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
