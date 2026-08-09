'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';

import { flush, record } from './client';

/**
 * Emits `route.transition` on every navigation.
 *
 * One line of behaviour, and it is the source for §1.4's counter-metric —
 * "median daily foreground minutes, ≤ 6 min and falling". `core`'s
 * `foregroundMinutesByDay` sessionises these into spans; without them the
 * counter-metric has no input at all, which is how it stood before this file.
 *
 * ## It records the pattern, never the path
 *
 * `record` runs every pathname through `routePattern` first, so
 * `/mind/journal/018f…` is stored as `/mind/journal/:id`. §5.11 forbids
 * payloads, and which journal entry was opened is a payload.
 *
 * ## Mounted in the protected layout, not the root
 *
 * A signed-out visitor's navigation is not the operator's, and §5.11's telemetry
 * exists to protect §1.4's metrics — all of which are about the operator's use.
 * Recording the sign-in page would put noise in the denominator.
 */
export function RouteTelemetry(): ReactNode {
  const pathname = usePathname();
  const previous = useRef<string | null>(null);

  useEffect(() => {
    // Guarded against React 18's double-invoke in development, which would
    // otherwise double every session's transition count.
    if (previous.current === pathname) return;
    previous.current = pathname;
    record('route.transition', undefined, pathname);
  }, [pathname]);

  /*
   * Flush on unmount as well as on hide. A sign-out unmounts this subtree
   * without ever hiding the document, and the events buffered during the last
   * fifteen seconds of a session are the ones that measure its end.
   */
  useEffect(() => {
    return () => {
      flush({ beacon: true });
    };
  }, []);

  return null;
}
