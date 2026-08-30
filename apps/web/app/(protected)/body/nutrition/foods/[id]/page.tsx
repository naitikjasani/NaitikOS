/** `/body/nutrition/foods/:id` — one food and every version it has had (§9.2). */

import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';

import { PageContainer } from '@/components/shell';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { loadFoodDetail } from '@/lib/platform/nutrition';
import { FoodDetailScreen } from '@/features/nutrition';

export const metadata = { title: 'Food · NaitikOS' };
export const dynamic = 'force-dynamic';

export default async function FoodDetailPage({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) return null;

  const { id } = await params;
  const detail = await loadFoodDetail(getDb(), id);

  if (detail.ok && detail.value === null) notFound();

  return (
    <PageContainer title="Food" description="Versions are added, never edited — a logged meal keeps the numbers it was eaten with.">
      {detail.ok && detail.value !== null ? (
        <FoodDetailScreen detail={detail.value} />
      ) : (
        <p>Could not load the food{detail.ok ? '.' : `: ${detail.error.message}`}</p>
      )}
    </PageContainer>
  );
}
