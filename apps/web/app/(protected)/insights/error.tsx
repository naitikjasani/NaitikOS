'use client';

/**
 * `/insights` error boundary.
 *
 * Insights is not a pillar in §3.2's sense, and it gets a boundary anyway,
 * because the thing worth telling the operator here is unique to it: nothing
 * else in the system depends on this surface. §5.10 makes the AI layer a
 * sidecar — every feature must work with it switched off entirely — so an
 * Insights failure is genuinely inert, and saying "nothing else depends on
 * this" is a stronger and truer reassurance than the generic one the other
 * pillars carry.
 *
 * The copy also refuses an implication the operator might otherwise draw. An
 * insight that cannot be displayed has not been dismissed, actioned or
 * silently discarded; the inbox is unchanged and it will be there on reload.
 *
 * `/insights/[id]`, `/insights/archive` and `/insights/calibration` share this
 * boundary, per the reasoning in `app/error.tsx`.
 */

import type { ReactNode } from 'react';
import { Container, ErrorState } from '@naitikos/design-system';

export default function InsightsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): ReactNode {
  return (
    <Container width="content" style={{ paddingBlock: 'var(--space-6)' }}>
      <ErrorState
        title="Insights could not be loaded"
        description="Nothing else depends on this page — every pillar, quick capture and the Daily Close work whether or not insights are available. No insight has been dismissed or discarded; the inbox is exactly as you left it."
        {...(error.digest === undefined ? {} : { traceId: error.digest })}
        onRetry={reset}
      />
    </Container>
  );
}
