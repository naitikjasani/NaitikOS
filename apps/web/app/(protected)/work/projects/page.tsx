/** `/work/projects` — §3.2, §4.8. */

import type { ReactNode } from 'react';

import { PageContainer } from '@/components/shell';
import { ProjectsScreen } from '@/features/work';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { loadProjects } from '@/lib/platform/work';

export const metadata = { title: 'Projects · Ekayu' };
export const dynamic = 'force-dynamic';

export default async function ProjectsPage(): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) return null;

  const board = await loadProjects(getDb());

  return (
    <PageContainer title="Projects" description="The container above tasks, linked to career artifacts.">
      {board.ok ? <ProjectsScreen board={board.value} /> : <p>Could not load projects: {board.error.message}</p>}
    </PageContainer>
  );
}
