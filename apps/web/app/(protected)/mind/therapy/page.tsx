/**
 * `/mind/therapy` — therapy sessions and notes (§3.2, §4.7).
 *
 * Gated on `journal:read` rather than `observation:read`. §4.7 groups therapy
 * notes with the journal as the most sensitive data in the system, and
 * `core/auth/roles.ts` already separates that permission from `medical:*` so a
 * clinician export can carry a medication history without carrying a diary —
 * the `clinician` role is deliberately not granted it.
 */

import type { ReactNode } from 'react';
import { isoFromMillis, systemClock } from '@naitikos/core';

import { ErrorState } from '@naitikos/design-system';

import { PageContainer } from '@/components/shell';
import { TherapyScreen } from '@/features/mind';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { loadTherapyBoard } from '@/lib/platform/therapy';

export const metadata = { title: 'Therapy · Ekayu' };
export const dynamic = 'force-dynamic';

export default async function TherapyPage(): Promise<ReactNode> {
  const authorized = await requireServerPermission('journal:read');
  if (!authorized.ok) return null;

  const board = await loadTherapyBoard(getDb(), {
    nowIso: isoFromMillis(systemClock.nowMillis()),
  });

  return (
    <PageContainer
      title="Therapy"
      description="Your sessions, and what was agreed between them. Nothing here is ever written or read by a model."
      width="reading"
    >
      {board.ok ? (
        <TherapyScreen board={board.value} />
      ) : (
        /*
          `ErrorState`, not a bare paragraph carrying the exception's message.
          Two reasons, and the second is the important one. A raw `<p>` inherits
          none of the type scale, so a failure on the most sensitive read-only
          screen in Mind rendered as unstyled text — which reads as *broken*
          rather than as *unavailable*. And a repository error message is
          internal detail: on a screen whose subject is therapy notes, the one
          thing worth saying is that nothing was lost and nothing was shown.
        */
        <ErrorState
          title="Could not load the sessions"
          description="The record is intact and nothing was changed. This view failed to read it."
        />
      )}
    </PageContainer>
  );
}
