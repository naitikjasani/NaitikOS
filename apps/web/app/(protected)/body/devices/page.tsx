/** `/body/devices` — wearable ingestion and what it has put in the record (§2.3). */

import type { ReactNode } from 'react';
import { ErrorState } from '@naitikos/design-system';

import { PageContainer } from '@/components/shell';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { loadDevices } from '@/lib/platform/devices';
import { DevicesScreen } from '@/features/devices';

export const metadata = { title: 'Devices · NaitikOS' };
export const dynamic = 'force-dynamic';

export default async function DevicesPage(): Promise<ReactNode> {
  const authorized = await requireServerPermission('observation:write');
  if (!authorized.ok) return null;

  const board = await loadDevices(getDb());

  return (
    <PageContainer
      title="Devices"
      description="What a wearable has put in the record, and how to put more of it there."
    >
      {board.ok ?
        <DevicesScreen board={board.value} />
      : <ErrorState title="Could not read the device data" description={board.error.message} />}
    </PageContainer>
  );
}
