/**
 * Route-level loading state.
 *
 * Skeletons rather than a spinner: §8.6 requires them to "hold layout", and a
 * centred spinner guarantees a layout shift when content arrives. No shimmer.
 */

import type { ReactNode } from 'react';
import { Container, LoadingState } from '@naitikos/design-system';

export default function Loading(): ReactNode {
  return (
    <Container width="content" style={{ paddingBlock: 'var(--space-6)' }}>
      <LoadingState rows={5} label="Loading page" />
    </Container>
  );
}
