'use client';

/**
 * `/money` error boundary.
 *
 * Money is the pillar where a half-rendered page is actively dangerous rather
 * than merely annoying: a net-worth figure or a budget remainder that fails
 * part-way through could otherwise leave a stale or partial number on screen
 * that reads as authoritative. A boundary replaces the region outright, which
 * is the right failure mode — no number at all beats a wrong one, and §8.9(3)'s
 * "missing data is shown as missing" is the same instinct applied to charts.
 *
 * One boundary for the pillar, per the reasoning in `app/error.tsx`.
 */

import type { ReactNode } from 'react';
import { Container, ErrorState } from '@naitikos/design-system';

export default function MoneyError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): ReactNode {
  return (
    <Container width="content" style={{ paddingBlock: 'var(--space-6)' }}>
      <ErrorState
        title="Money could not be loaded"
        description="No figures are shown rather than partial ones, which is deliberate. Nothing has been lost: accounts, transactions and budgets are all still recorded. Every other pillar is unaffected, and navigation and quick capture are still working."
        {...(error.digest === undefined ? {} : { traceId: error.digest })}
        onRetry={reset}
      />
    </Container>
  );
}
