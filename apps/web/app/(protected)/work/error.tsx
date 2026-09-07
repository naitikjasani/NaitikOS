'use client';

/**
 * `/work` error boundary.
 *
 * Work is a V3 pillar and currently thin — tasks, projects, the career log —
 * which is precisely why it gets a boundary now rather than later. A boundary
 * added alongside the pillar is one file written once; a boundary retrofitted
 * across a pillar that has grown is a review of every screen beneath it, and it
 * only ever gets scheduled after the first blank page.
 *
 * One boundary for the pillar, per the reasoning in `app/error.tsx`.
 */

import type { ReactNode } from 'react';
import { Container, ErrorState } from '@naitikos/design-system';

export default function WorkError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): ReactNode {
  return (
    <Container width="content" style={{ paddingBlock: 'var(--space-6)' }}>
      <ErrorState
        title="Work could not be loaded"
        description="Every other pillar is unaffected, and navigation and quick capture are still working. Nothing has been lost: tasks, projects and the career log are all still recorded, and this failed on the way to the screen rather than on the way to the record."
        {...(error.digest === undefined ? {} : { traceId: error.digest })}
        onRetry={reset}
      />
    </Container>
  );
}
