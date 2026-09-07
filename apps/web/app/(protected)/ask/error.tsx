'use client';

/**
 * `/ask` error boundary.
 *
 * The same sidecar argument as `/insights`, and it lands harder here because
 * Ask is the surface most likely to fail: it is the only one whose render
 * depends on a third-party model API. §5.10 requires the whole product to
 * function with the AI layer disabled, and the acceptance test for the kill
 * switch is exactly that. This boundary is where that architectural promise
 * becomes something the operator can read.
 *
 * `/ask/[threadId]` shares it, per the reasoning in `app/error.tsx`.
 */

import type { ReactNode } from 'react';
import { Container, ErrorState } from '@naitikos/design-system';

export default function AskError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): ReactNode {
  return (
    <Container width="content" style={{ paddingBlock: 'var(--space-6)' }}>
      <ErrorState
        title="Ask could not be loaded"
        description="Nothing else depends on the assistant — every pillar, quick capture and the Daily Close work with it switched off entirely. Your existing threads are still saved and are not affected by this."
        {...(error.digest === undefined ? {} : { traceId: error.digest })}
        onRetry={reset}
      />
    </Container>
  );
}
