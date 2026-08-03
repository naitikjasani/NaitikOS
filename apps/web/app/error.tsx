'use client';

/**
 * Root error boundary.
 *
 * §5.12: "error boundaries per pillar, so a failure in Skin never blanks
 * Today." This is the outermost one; per-pillar boundaries arrive with the
 * pillars.
 *
 * It renders the digest and nothing else. Next strips the real message from
 * production builds, and that is the correct behaviour here rather than an
 * inconvenience — an exception in this application could carry a journal entry.
 */

import type { ReactNode } from 'react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): ReactNode {
  return (
    <main className="auth-shell" id="main">
      <div className="auth-card">
        <h1>Something went wrong</h1>
        <p className="subtitle">
          The error has been logged. Nothing you entered has been lost.
        </p>
        {error.digest !== undefined && (
          <p className="muted" style={{ marginBottom: 'calc(var(--space) * 2)' }}>
            Reference: <code>{error.digest}</code>
          </p>
        )}
        <button className="button" type="button" onClick={reset}>
          Try again
        </button>
      </div>
    </main>
  );
}
