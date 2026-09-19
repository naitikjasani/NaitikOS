'use client';

import { useEffect, type ReactNode } from 'react';

import { useNavigationStore } from '@/lib/stores/navigation.store';
import { destinationFor } from './navigation-tree';

/**
 * How long a pending navigation is allowed to look pending.
 *
 * A safety valve, not a timeout: the pending state is normally cleared by the
 * new pathname arriving. This covers the cases where it never does — a
 * navigation that redirects back to where it started, or one that errors into a
 * boundary that renders without changing the URL. A track that never goes out
 * is worse than no track, because it stops meaning anything.
 */
const PENDING_CEILING_MS = 10_000;

/**
 * Navigation progress.
 *
 * ## The problem
 *
 * Server components stream. A tap on a route whose first byte is 800ms away
 * produces, until that byte lands, an application that looks exactly as it did
 * before the tap. The operator's reasonable conclusion is that the tap missed,
 * and the reasonable response is to tap again.
 *
 * ## Why a track and not a spinner
 *
 * §8.6 keeps motion functional and forbids animating data. This is neither: it
 * is state feedback about the *shell*, which is the one thing §8.6 explicitly
 * says motion is for ("communicates causality, continuity, and state change").
 * A spinner over the content would blank a page the operator can still usefully
 * read, and a skeleton would claim to know the shape of what is coming.
 *
 * ## Reduced motion
 *
 * The sweep's travel is multiplied by `--motion-travel` (§8.6, set once in
 * `base.css`), so under reduced motion both keyframes resolve to no movement
 * and the segment simply sits there. It is still visible, still says "loading",
 * and never strobes — which is what collapsing the duration to 1ms would do to
 * an animated indicator that had not been written this way.
 */
export function RouteProgress(): ReactNode {
  const pendingHref = useNavigationStore((state) => state.pendingHref);
  const endNavigation = useNavigationStore((state) => state.endNavigation);

  useEffect(() => {
    if (pendingHref === null) return;
    const timer = window.setTimeout(endNavigation, PENDING_CEILING_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [pendingHref, endNavigation]);

  const isPending = pendingHref !== null;
  const label = pendingHref === null ? null : (destinationFor(pendingHref)?.label ?? null);

  return (
    <>
      <div
        className="route-progress"
        data-pending={isPending ? 'true' : undefined}
        aria-hidden="true"
      >
        <span className="route-progress__sweep" />
      </div>
      {/*
        Announced separately from the track, because §8.13 forbids state carried
        by a visual alone. Polite rather than assertive: Next announces the new
        page title on arrival, and an assertive region here would talk over it.
      */}
      <div className="nos-visually-hidden" role="status" aria-live="polite">
        {isPending ? (label === null ? 'Loading' : `Loading ${label}`) : ''}
      </div>
    </>
  );
}
