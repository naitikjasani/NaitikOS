/**
 * `/work/career` — §3.2, §4.8.
 *
 * The period is a query parameter so a review window can be linked to and
 * revisited. A review conversation happens twice about the same twelve months,
 * and a page that could only show "the last year from today" would show a
 * different twelve months the second time.
 */

import type { ReactNode } from 'react';

import { PageContainer } from '@/components/shell';
import { CareerScreen } from '@/features/work';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';
import { loadCareer } from '@/lib/platform/work';

export const metadata = { title: 'Career log · NaitikOS' };
export const dynamic = 'force-dynamic';

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/u;

export default async function CareerPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | readonly string[] | undefined>>;
}): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) return null;

  const params = await searchParams;
  const dayKeyParam = (name: string): string | undefined => {
    const raw = params[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    return typeof value === 'string' && DAY_KEY.test(value) ? value : undefined;
  };

  const board = await loadCareer(getDb(), DEFAULT_PROFILE_ZONE, {
    ...(dayKeyParam('from') === undefined ? {} : { fromDayKey: dayKeyParam('from') as string }),
    ...(dayKeyParam('to') === undefined ? {} : { toDayKey: dayKeyParam('to') as string }),
  });

  return (
    <PageContainer
      title="Career log"
      description="One line on the day it ships. So that November is not spent reconstructing March."
    >
      {board.ok ? (
        <CareerScreen board={board.value} zone={DEFAULT_PROFILE_ZONE} />
      ) : (
        <p>Could not load the career log: {board.error.message}</p>
      )}
    </PageContainer>
  );
}
