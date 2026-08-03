'use client';

/**
 * Session access for client components.
 *
 * §7.3: hooks are "the bridge between services and components... No business
 * logic — hooks *call* services."
 *
 * ## Why this is context, not a fetch
 *
 * The session is resolved once on the server, in the protected layout, and
 * handed down. A hook that fetched `/api/auth/session` on mount would mean
 * every client component triggers a verified round trip (see the adapter's note
 * on `getUser`), and the first paint would flash a signed-out state before
 * correcting itself.
 *
 * TanStack Query is the eventual home for this (§5.1) — it is not installed
 * yet, and adding it for a single value that is already available at render
 * time would be premature.
 */

import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { Permission, Role } from '@naitikos/core';

/** The client's view. Mirrors the `/api/auth/session` contract — no tokens. */
export type ClientSession = {
  readonly email: string;
  readonly role: Role;
  readonly strategy: string;
  readonly authenticatedAt: string;
  readonly permissions: readonly string[];
};

export type SessionContextValue = {
  readonly session: ClientSession | null;
  readonly isAuthenticated: boolean;
  /**
   * Whether the role holds a permission.
   *
   * **Advisory only.** Every permission is re-checked server-side by
   * `authorize()`. This decides what to *render*, never what to allow — a
   * client that lied to itself would gain a button that returns 403.
   */
  readonly can: (permission: Permission) => boolean;
  /** True while a sign-out request is in flight. */
  readonly isSigningOut: boolean;
  readonly signOut: () => Promise<void>;
};

const SessionContext = createContext<SessionContextValue | null>(null);

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);

  if (value === null) {
    // A hard error rather than a null-object fallback. A component silently
    // believing it is signed out is a much worse failure than a loud one, and
    // it is the kind that reaches production.
    throw new Error(
      'useSession must be used inside <SessionProvider>. The protected layout provides it; ' +
        'a public route has no session to read.',
    );
  }

  return value;
}

/**
 * Build the context value.
 *
 * Exported separately from the provider component so it can be exercised
 * without rendering — §7.3's "directly unit testable" applied to a hook.
 */
export function useSessionValue(
  initial: ClientSession | null,
  onSignOut: () => Promise<void>,
): SessionContextValue {
  const [isSigningOut, setIsSigningOut] = useState(false);

  const permissions = useMemo(
    () => new Set(initial?.permissions ?? []),
    [initial?.permissions],
  );

  const can = useCallback(
    (permission: Permission) => permissions.has(permission),
    [permissions],
  );

  const signOut = useCallback(async () => {
    setIsSigningOut(true);
    try {
      await onSignOut();
    } finally {
      // Reset even on failure: leaving the button spinning forever after a
      // network error strands the user with no way to retry.
      setIsSigningOut(false);
    }
  }, [onSignOut]);

  return useMemo(
    () => ({
      session: initial,
      isAuthenticated: initial !== null,
      can,
      isSigningOut,
      signOut,
    }),
    [initial, can, isSigningOut, signOut],
  );
}

export { SessionContext };
