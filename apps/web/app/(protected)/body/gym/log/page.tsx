/**
 * `/body/gym/log` — the live session logger.
 *
 * The one route in this milestone whose *latency* is a requirement rather than a
 * quality: §12's exit criterion is "a real training session logged in the gym,
 * on a phone, without friction."
 *
 * Thin, per §6.2 — `app/` is routing. Everything the logger needs, including
 * the bodyweight that decides whether bodyweight movements count towards volume,
 * arrives on the one request the screen already makes.
 */

import type { ReactNode } from 'react';

import { PageContainer } from '@/components/shell';
import { SessionLoggerScreen } from '@/features/gym';
import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';

export const metadata = { title: 'Session · Ekayu' };
export const dynamic = 'force-dynamic';

export default function SessionLogPage(): ReactNode {
  return (
    <PageContainer title="Session" description="Log as you go. Everything works offline.">
      <SessionLoggerScreen zone={DEFAULT_PROFILE_ZONE} />
    </PageContainer>
  );
}
