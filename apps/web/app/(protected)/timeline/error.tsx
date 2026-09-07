'use client';

/**
 * `/timeline` error boundary.
 *
 * Timeline is a projection: P3's "a query with a UI attached", reading §9.1's
 * append-only event log and writing nothing back. That makes the reassurance in
 * the description a structural fact rather than a soothing phrase — there is no
 * code path from this page to a mutation, so a failure here cannot have damaged
 * the record it failed to display. The copy says so in those terms, because
 * §8.9(3)'s instinct applies to failures as much as to charts: a gap is shown
 * as a gap, and a blank column where a life's record should be is the single
 * most alarming thing this application could render without explanation.
 *
 * `/timeline/[date]`, `/timeline/life` and `/timeline/medical` share this
 * boundary, per the granularity decision in `app/error.tsx`.
 */

import type { ReactNode } from 'react';
import { Container, ErrorState } from '@naitikos/design-system';

export default function TimelineError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): ReactNode {
  return (
    <Container width="content" style={{ paddingBlock: 'var(--space-6)' }}>
      <ErrorState
        title="Timeline could not be loaded"
        description="The record itself is untouched. Timeline only reads the event log and never writes to it, so nothing behind this page has changed. Every pillar is unaffected, and navigation and quick capture are still working."
        {...(error.digest === undefined ? {} : { traceId: error.digest })}
        onRetry={reset}
      />
    </Container>
  );
}
