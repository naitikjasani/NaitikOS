'use client';

/**
 * `/today` error boundary.
 *
 * Today is the default route (§3.2), which makes it the one pillar where a
 * failure caught by the *root* boundary would be indistinguishable from the
 * application being down: the operator opens the app, lands here, and sees a
 * bare error with no navigation to prove anything else exists. This file is
 * what keeps the sidebar and the tab bar on screen while it says so.
 *
 * The description leans on a fact that is true only because of where the shell
 * puts things: §3.3(4) mounts quick capture on the shell rather than on this
 * page, so a Today that will not render still lets the operator log. That is
 * worth stating outright — it is the difference between "come back later" and
 * "carry on".
 *
 * ## `/today/close` and `/today/capture/:kind` get no boundary of their own
 *
 * Declined, for the reason recorded in `app/error.tsx`: neither sits under a
 * pillar layout, so a nested boundary would replace the same region this one
 * does and change nothing the operator could see.
 *
 * There is a real gap underneath that decision, and it is honest to name it
 * rather than imply a boundary fixes it. §5.12's "failure never loses user
 * input" is about a *save* failing — the entered data stays on screen and goes
 * to the outbox. A render crash part-way through the Daily Close is a different
 * animal: React unmounts the subtree, and whatever was typed into an
 * unsubmitted step goes with it, at whatever depth the boundary sits. The fix
 * for that is §8.10's autosave — drafts persisted as they are entered — not a
 * boundary, and it belongs in the Close feature rather than here.
 */

import type { ReactNode } from 'react';
import { Container, ErrorState } from '@naitikos/design-system';

export default function TodayError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): ReactNode {
  return (
    <Container width="content" style={{ paddingBlock: 'var(--space-6)' }}>
      <ErrorState
        title="Today could not be loaded"
        description="Everything else is unaffected. Quick capture and navigation belong to the shell rather than to this page, so logging still works, and every pillar is still reachable from the menu. Nothing has been lost: this failed on the way to the screen, not on the way to the record."
        {...(error.digest === undefined ? {} : { traceId: error.digest })}
        onRetry={reset}
      />
    </Container>
  );
}
