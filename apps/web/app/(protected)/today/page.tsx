/**
 * /today — the default authenticated route (§3.2).
 *
 * **A platform placeholder, deliberately.** This milestone builds the UI
 * foundation and explicitly excludes dashboard widgets and health features; the
 * Daily Close is Week 2 (§12). What renders here is the shell proving itself:
 * a page container, a card, an empty state, and nothing that reads data.
 */

import type { ReactNode } from 'react';
import { Suspense } from 'react';

import { PageContainer } from '@/components/shell';
import { PlatformStatus } from '@/components/PlatformStatus';
import { LoadingState } from '@naitikos/design-system';

export const metadata = { title: 'Today · NaitikOS' };
export const dynamic = 'force-dynamic';

export default function TodayPage(): ReactNode {
  return (
    <PageContainer
      title="Today"
      description="The platform foundation. Features arrive from Week 2 of the roadmap."
    >
      {/*
        A Suspense boundary around the one interactive region.
        Not decoration: it is what lets the page shell stream and paint before
        the client component hydrates, so the title and layout are visible
        immediately rather than after the JS bundle lands (§11.5's budget).
      */}
      <Suspense fallback={<LoadingState rows={4} label="Loading platform status" />}>
        <PlatformStatus />
      </Suspense>
    </PageContainer>
  );
}
