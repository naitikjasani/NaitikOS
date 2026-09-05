/**
 * `/insights/calibration` — §10.9.
 *
 * Filed under Insights rather than under a pillar because a prediction is not
 * about a domain, it is about the engine. §4.13 already puts "its evidence, its
 * method, its confidence, and a plain statement of what it does *not* prove"
 * next to every finding; this is the same obligation for the thing that guesses.
 */

import type { ReactNode } from 'react';

import { PageContainer } from '@/components/shell';
import { CalibrationScreen } from '@/features/insights';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { loadCalibration } from '@/lib/platform/predictions';

export const metadata = { title: 'Calibration · NaitikOS' };
export const dynamic = 'force-dynamic';

export default async function CalibrationPage(): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) return null;

  const board = await loadCalibration(getDb());

  return (
    <PageContainer
      title="Calibration"
      description="What the engine predicted, what actually happened, and how often it was right."
    >
      {board.ok ? (
        <CalibrationScreen board={board.value} />
      ) : (
        <p>Could not load the calibration record: {board.error.message}</p>
      )}
    </PageContainer>
  );
}
