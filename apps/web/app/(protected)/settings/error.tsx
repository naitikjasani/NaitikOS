'use client';

/**
 * `/settings` error boundary.
 *
 * The specific fear this page has to answer is not "have I lost data" but "have
 * my settings been reset" — a preferences screen that will not render looks
 * exactly like one that has been wiped. It has not: the stored values are
 * unchanged and still in force everywhere else in the application, and only the
 * editor for them is unavailable. The description says that first, before
 * anything else, because it is the question the operator is actually asking.
 *
 * One boundary for the segment, covering `/settings/appearance`, `/settings/ai`,
 * `/settings/privacy`, `/settings/data` and the rest, per the reasoning in
 * `app/error.tsx`. That includes `/settings/developer`, which is where §5.11's
 * telemetry dashboard renders — the one screen an operator would reach *because*
 * something is wrong. It is worth being aware that this boundary is the last
 * thing standing between a broken dashboard and a diagnostic dead end, which is
 * an argument for the digest being on screen rather than only in the log.
 */

import type { ReactNode } from 'react';
import { Container, ErrorState } from '@naitikos/design-system';

export default function SettingsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): ReactNode {
  return (
    <Container width="content" style={{ paddingBlock: 'var(--space-6)' }}>
      <ErrorState
        title="Settings could not be loaded"
        description="Your preferences are unchanged and still in effect — this page could not be drawn, which is not the same as being reset. Every pillar is unaffected, and navigation and quick capture are still working."
        {...(error.digest === undefined ? {} : { traceId: error.digest })}
        onRetry={reset}
      />
    </Container>
  );
}
