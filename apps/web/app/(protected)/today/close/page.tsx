/**
 * `/today/close` — the Daily Close, full page.
 *
 * §4.0: "Single screen, no scrolling on a phone. If it does not fit, something
 * must be cut." A route of its own is what makes that testable — there is
 * nothing else on the page to compete for the viewport.
 *
 * `?day=YYYY-MM-DD` back-fills an earlier day. §4.0 does not ask for it, but
 * §9.5's bitemporality does: a close written the following morning is a fact
 * about yesterday recorded today, and the record has to be able to say so.
 */

import type { ReactNode } from 'react';
import { dayKeyInZone, isoFromMillis, systemClock } from '@naitikos/core';

import { PageContainer } from '@/components/shell';
import { DailyCloseScreen } from '@/features/daily-close';
import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';

export const metadata = { title: 'Daily Close · NaitikOS' };
export const dynamic = 'force-dynamic';

export default async function DailyClosePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const params = await searchParams;
  const zone = DEFAULT_PROFILE_ZONE;
  const today = dayKeyInZone(isoFromMillis(systemClock.nowMillis()), zone);

  /*
   * The requested day is validated here rather than trusted. An arbitrary
   * string would reach `zonedDayBounds`, which refuses it — but it would reach
   * it as a *failed request* rather than as a page showing today, and a bad
   * bookmark should not look like an outage.
   */
  const requested = params['day'];
  const dayKey =
    typeof requested === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : today;

  return (
    <PageContainer
      title="Daily Close"
      description="The day's minimum viable record, in under sixty seconds."
    >
      <DailyCloseScreen dayKey={dayKey} zone={zone} isToday={dayKey === today} />
    </PageContainer>
  );
}
