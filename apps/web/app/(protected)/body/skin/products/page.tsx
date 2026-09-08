/** `/body/skin/products` — the register and reaction history (§3.2, §4.2). */

import type { ReactNode } from 'react';
import { dayKeyInZone, isoFromMillis, systemClock } from '@naitikos/core';

import { PageContainer } from '@/components/shell';
import { ProductsScreen } from '@/features/skin';
import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';

export const metadata = { title: 'Products · Ekayu' };
export const dynamic = 'force-dynamic';

export default function ProductsPage(): ReactNode {
  const today = dayKeyInZone(isoFromMillis(systemClock.nowMillis()), DEFAULT_PROFILE_ZONE);
  return (
    <PageContainer title="Products" description="What you use, when you started, and what happened.">
      <ProductsScreen dayKey={today} />
    </PageContainer>
  );
}
