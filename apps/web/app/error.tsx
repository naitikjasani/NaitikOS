'use client';

/**
 * Root error boundary.
 *
 * §5.12: "error boundaries per pillar, so a failure in Skin never blanks
 * Today." This is the outermost one; per-pillar boundaries arrive with the
 * pillars, and the shell is deliberately *outside* it so navigation survives a
 * content failure.
 *
 * Renders the digest and nothing else. Next strips the real message from
 * production builds, which is correct here rather than inconvenient — an
 * exception in this application could carry a journal entry.
 */

import type { ReactNode } from 'react';
import { ErrorState } from '@naitikos/design-system';

export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): ReactNode {
  return (
    <div className="app-shell__content">
      <ErrorState
        title="This page could not be loaded"
        description="Nothing you entered has been lost. The error has been logged."
        {...(error.digest === undefined ? {} : { traceId: error.digest })}
        onRetry={reset}
      />
    </div>
  );
}
