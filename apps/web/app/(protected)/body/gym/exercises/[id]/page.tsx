/** `/body/gym/exercises/:id` — detail and all-time progression (§3.2). */

import type { ReactNode } from 'react';

import { PageContainer } from '@/components/shell';
import { ExerciseDetailScreen } from '@/features/gym';

export const metadata = { title: 'Exercise · NaitikOS' };
export const dynamic = 'force-dynamic';

export default async function ExerciseDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<ReactNode> {
  const { id } = await params;
  return (
    <PageContainer title="Exercise" description="Every session, and how the numbers have moved." width="wide">
      <ExerciseDetailScreen exerciseId={id} />
    </PageContainer>
  );
}
