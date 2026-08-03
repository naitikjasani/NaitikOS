/**
 * Public layout.
 *
 * Renders no session and mounts no provider — a signed-out visitor has nothing
 * to provide. Middleware has already redirected an authenticated user away from
 * these routes, so this layout never needs to consider one.
 */

import type { ReactNode } from 'react';

export default function PublicLayout({ children }: { children: ReactNode }): ReactNode {
  return <>{children}</>;
}
