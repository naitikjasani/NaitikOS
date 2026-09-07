'use client';

/**
 * `/life` error boundary.
 *
 * Life holds the document vault, goals, reviews, people and places. The vault
 * is the part worth naming in the copy: a page that will not render, sitting
 * where somebody's passport scans and insurance documents live, invites exactly
 * the wrong inference. Files in object storage are entirely untouched by a
 * failure in the React tree that lists them, and the description says so.
 *
 * One boundary for the pillar, per the reasoning in `app/error.tsx`.
 */

import type { ReactNode } from 'react';
import { Container, ErrorState } from '@naitikos/design-system';

export default function LifeError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): ReactNode {
  return (
    <Container width="content" style={{ paddingBlock: 'var(--space-6)' }}>
      <ErrorState
        title="Life could not be loaded"
        description="Nothing has been lost — stored documents, goals and reviews are all still there, and this failed while drawing the page rather than while reading them. Every other pillar is unaffected, and navigation and quick capture are still working."
        {...(error.digest === undefined ? {} : { traceId: error.digest })}
        onRetry={reset}
      />
    </Container>
  );
}
