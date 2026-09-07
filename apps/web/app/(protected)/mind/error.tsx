'use client';

/**
 * `/mind` error boundary.
 *
 * This is the pillar that settles the `error.message` question for the whole
 * hierarchy. Beneath it sit the journal, mood, anxiety episodes, therapy notes
 * and the psychiatric medication lens — the most sensitive rows in the
 * database. A driver error thrown from a query over `journal_entry` can quote
 * the row it choked on, and a Zod failure quotes the input verbatim; rendering
 * either would put a reflection somebody wrote in confidence onto a screen that
 * might be shared, screenshotted for a bug report, or simply left open. So this
 * boundary shows `error.digest` and stops. Full reasoning in `app/error.tsx`.
 *
 * The wording of the description matters more here than anywhere else. A person
 * who has just lost a page containing their journal needs to be told, in the
 * first breath, that the journal is intact — a render failure is a drawing
 * failure, and §9.1's log is append-only besides, so there is no mechanism by
 * which this could have destroyed anything.
 *
 * No sub-boundary for `/mind/journal`, for the structural reason in
 * `app/error.tsx`. Note that it would not have protected an unsaved draft in
 * any case: §8.10 requires journal entries to autosave continuously, and that
 * requirement lives in the editor, not in a boundary above it.
 */

import type { ReactNode } from 'react';
import { Container, ErrorState } from '@naitikos/design-system';

export default function MindError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): ReactNode {
  return (
    <Container width="content" style={{ paddingBlock: 'var(--space-6)' }}>
      <ErrorState
        title="Mind could not be loaded"
        description="Nothing you have written has been lost — journal entries, mood and episode records are all still stored, and this failed while drawing the page rather than while reading or writing it. Every other pillar is unaffected, and navigation and quick capture are still working."
        {...(error.digest === undefined ? {} : { traceId: error.digest })}
        onRetry={reset}
      />
    </Container>
  );
}
