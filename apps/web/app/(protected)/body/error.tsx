'use client';

/**
 * `/body` error boundary.
 *
 * The pillar §5.12 names by example — "a failure in Skin never blanks Today" —
 * and the largest one: gym, nutrition, health, skin, teeth, composition, sleep,
 * appearance and devices all render beneath this file. It is therefore the most
 * tempting place to start subdividing, and the argument against that is
 * recorded once in `app/error.tsx` rather than repeated here: with no
 * `/body/layout.tsx`, a boundary at `/body/skin` would replace the identical
 * region of the screen, so the extra file would cost maintenance and buy the
 * operator nothing they could see.
 *
 * The consequence to be clear-eyed about is that a broken `/body/skin` takes
 * `/body/gym` down with it until the operator navigates away. That is a real
 * loss of resolution, and it is the one the blueprint chose: §5.12's line is
 * drawn at the pillar, and Skin failing without blanking Today is exactly what
 * this delivers.
 *
 * Body holds the densest medical data in the system — labs, medications,
 * conditions, symptom logs — which is why the boundary reports `error.digest`
 * and never `error.message`. The reasoning is in `app/error.tsx`.
 */

import type { ReactNode } from 'react';
import { Container, ErrorState } from '@naitikos/design-system';

export default function BodyError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): ReactNode {
  return (
    <Container width="content" style={{ paddingBlock: 'var(--space-6)' }}>
      <ErrorState
        title="Body could not be loaded"
        description="Every other pillar is unaffected, and navigation and quick capture are still on screen and still working. Nothing has been lost: sessions, vitals, labs and photos are all still recorded, and this failed on the way to the screen rather than on the way to the record."
        {...(error.digest === undefined ? {} : { traceId: error.digest })}
        onRetry={reset}
      />
    </Container>
  );
}
