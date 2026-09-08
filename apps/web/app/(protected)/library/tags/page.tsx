/** `/library/tags` — the controlled tag vocabulary (§3.2, §9.2). */

import type { ReactNode } from 'react';

import { PageContainer } from '@/components/shell';
import { TagVocabularyScreen } from '@/features/library';
import { requireServerPermission } from '@/lib/auth/session';
import { loadTagVocabulary } from '@/lib/platform/library';

export const metadata = { title: 'Tags · Ekayu' };
export const dynamic = 'force-dynamic';

export default async function TagVocabularyPage(): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) return null;

  /*
   * No database handle. `loadTagVocabulary` reads nothing — the tag tables have
   * no repository — so passing one would advertise a query that does not
   * happen. `force-dynamic` stays, so that the day the loader does read, this
   * page needs no other change.
   */
  const board = loadTagVocabulary();

  return (
    <PageContainer
      title="Tags"
      description="The controlled vocabulary applied across every domain, so that 'everything tagged travel' is one query."
    >
      {board.ok ? (
        <TagVocabularyScreen board={board.value} />
      ) : (
        <p>Could not load the tag vocabulary: {board.error.message}</p>
      )}
    </PageContainer>
  );
}
