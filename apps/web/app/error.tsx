'use client';

/**
 * Root error boundary — the last resort, not the first responder.
 *
 * §5.12: "error boundaries per pillar, so a failure in Skin never blanks
 * Today." The per-pillar boundaries are the eleven `error.tsx` files under
 * `(protected)/`, and they are what a failing page should normally hit. This
 * one catches only what they cannot: a throw inside `(protected)/layout.tsx`
 * itself — the auth resolution, the query provider, the shell.
 *
 * Which is why it draws its own `app-shell__content`. A boundary renders in
 * place of *its segment's children*, and the shell mounts in the protected
 * layout, so a failure caught here has already taken the sidebar and the tab
 * bar with it and there is no `<main>` left to render into. An earlier version
 * of this comment claimed the shell sat outside this boundary and therefore
 * survived a content failure. It did not, and could not; the pillar boundaries
 * below are what make that claim true at the level where it matters.
 *
 * ## Granularity: one per pillar, no deeper — decided once, recorded here
 *
 * The eleven §3.2 segments — `/today`, `/body`, `/mind`, `/work`, `/money`,
 * `/life`, `/timeline`, `/insights`, `/ask`, `/library`, `/settings` — get a
 * boundary each. `/body/skin`, `/body/gym/log`, `/today/close` and the other
 * ninety-odd routes do not, and the reason is structural rather than a matter
 * of taste worth arguing about.
 *
 * No pillar owns a `layout.tsx`. Every page renders straight into the shell's
 * `<main>`. So a boundary at `/body/skin` and a boundary at `/body` replace
 * *the same region of the screen*, with the same everything-else-intact
 * result — the deeper file would buy no visible difference, only a narrower
 * `reset()` scope, and the scope is already exactly the page that failed.
 * Eleven files that have to stay correct is a cost §5.12 asks for. A hundred
 * and four is a cost nothing asks for, and each one is a place for the copy to
 * drift out of step with the truth.
 *
 * That calculus flips the day a pillar gains a real layout — sub-navigation, a
 * shared header, a persistent filter bar — because then the pillar boundary
 * *would* blank it and a nested one would not. Whoever adds that layout should
 * add the boundary beneath it in the same commit.
 *
 * ## `error.message` is never rendered, here or in any pillar boundary
 *
 * Only `error.digest`. Next already strips messages from production builds, so
 * for prod this is belt-and-braces — but development builds pass the real
 * message through, and the messages this application generates are the problem:
 * a Postgres constraint violation quotes the offending row, a Zod failure
 * quotes the input that failed, and both of those are a journal entry or a lab
 * result. §5.13 makes redaction structural rather than a list to remember; the
 * same instinct applies to the screen. The digest is the identifier that
 * correlates with the log, which is what an operator actually needs, and it
 * carries no record content by construction.
 */

import type { ReactNode } from 'react';
import { ErrorState } from '@naitikos/design-system';

export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): ReactNode {
  return (
    <div className="app-shell__content">
      <ErrorState
        title="This page could not be loaded"
        description="Nothing you entered has been lost. The error has been logged."
        {...(error.digest === undefined ? {} : { traceId: error.digest })}
        onRetry={reset}
      />
    </div>
  );
}
