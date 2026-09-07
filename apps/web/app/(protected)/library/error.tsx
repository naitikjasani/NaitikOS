'use client';

/**
 * `/library` error boundary.
 *
 * Library is a read surface rather than a pillar, and it owns no rows — every
 * registry beneath it is authored by the module that writes to it. That makes
 * the reassurance specific and true: a failure here cannot have affected an
 * exercise or a food, because this page has no route by which to change one.
 *
 * Worth saying explicitly in the copy, because the modules that *do* own those
 * registries carry on working while this page is down — logging a set still
 * resolves its exercise, whatever `/library/exercises` is doing.
 *
 * One boundary for the segment, per the reasoning in `app/error.tsx`.
 */

import type { ReactNode } from 'react';
import { Container, ErrorState } from '@naitikos/design-system';

export default function LibraryError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): ReactNode {
  return (
    <Container width="content" style={{ paddingBlock: 'var(--space-6)' }}>
      <ErrorState
        title="Library could not be loaded"
        description="Nothing has been lost. Library only reads registries that other modules own, so exercises, foods and products are all still there — and the modules that use them are still working. Every pillar is unaffected, as are navigation and quick capture."
        {...(error.digest === undefined ? {} : { traceId: error.digest })}
        onRetry={reset}
      />
    </Container>
  );
}
