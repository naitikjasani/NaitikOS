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

import { PageContainer } from '@/components/shell';
import { TherapyScreen } from '@/features/mind';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { loadTherapyBoard } from '@/lib/platform/therapy';

export const metadata = { title: 'Therapy · NaitikOS' };
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
    >
      {board.ok ? (
        <TherapyScreen board={board.value} />
      ) : (
        <p>Could not load the sessions: {board.error.message}</p>
      )}
    </PageContainer>
  );
}
