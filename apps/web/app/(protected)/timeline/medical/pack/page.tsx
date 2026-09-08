/**
 * `/timeline/medical/pack` — the Consultation Pack (§10.7).
 *
 * It lived at `/body/health/pack` when it shipped, which was wrong: §3.2 puts
 * it under the medical timeline, and §10.7 introduces it as that timeline's
 * payoff rather than as a Health screen. `/body/health/pack` now redirects
 * here rather than 404ing, because a printed pack may already carry the old URL
 * in a browser's history.
 *
 * V2's highest-value deliverable, and December's gate item: "at least one
 * Consultation Pack taken to an actual appointment."
 *
 * `medical:read` rather than `observation:read`. The pack is the densest
 * clinical document the system produces — conditions, medications, labs and
 * symptoms on one page — and it is the one screen most likely to be open on a
 * phone that is handed to somebody else. The journal is deliberately absent
 * from it, which is exactly the separation §4.7 asks `journal:*` to preserve:
 * "a clinician export should be able to carry a medication history without
 * carrying a diary".
 */

import type { ReactNode } from 'react';

import { PageContainer } from '@/components/shell';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';
import { loadConsultationPack } from '@/lib/platform/consultation-pack';
import { ConsultationPackScreen } from '@/features/health';

export const metadata = { title: 'Consultation pack · Ekayu' };
export const dynamic = 'force-dynamic';

export default async function ConsultationPackPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const authorized = await requireServerPermission('medical:read');
  if (!authorized.ok) return null;

  const params = await searchParams;
  const raw = params['specialty'];
  const specialty = typeof raw === 'string' ? raw : 'general';

  const pack = await loadConsultationPack(getDb(), { specialty, zone: DEFAULT_PROFILE_ZONE });

  return (
    <PageContainer
      title="Consultation pack"
      description="Everything on record for a specialty and window, ordered so the relevant part leads — and a page of questions."
    >
      {pack.ok ? (
        <ConsultationPackScreen pack={pack.value} />
      ) : (
        <p>Could not assemble the pack: {pack.error.message}</p>
      )}
    </PageContainer>
  );
}
