/**
 * `/today` — the default authenticated route (§3.2).
 *
 * §3.2 lists five regions here: the Now panel, the Daily Close, quick capture,
 * one insight card, and open loops. Three of those exist now; the other two
 * cannot yet and their absence is deliberate rather than incomplete.
 *
 * - **Today's signal** is one insight card, and it now renders — see the note in
 *   `detectors/battery.ts` on why §10.6's sixty-day gate applies to inference
 *   and not to a count. Before there is enough data it says so, which §10.6
 *   requires: "'not enough data yet' is honest and builds trust."
 * - **Open loops** needs domains with unfinished items in them, and the first
 *   one lands in week three.
 *
 * The Close itself is at `/today/close` rather than in a modal here. §3.2
 * suggests a modal; §4.0 requires "a single screen, no scrolling on a phone",
 * and a modal over a page that already has two cards cannot honour that on a
 * small viewport. The route is the honest reading of the constraint that
 * matters more.
 */

import type { ReactNode } from 'react';
import { Suspense } from 'react';
import { ErrorState, LoadingState } from '@naitikos/design-system';
import { dayKeyInZone, systemClock, isoFromMillis } from '@naitikos/core';
import { createDailyCloseRepository, createMetricRepository } from '@naitikos/db';

import { PageContainer } from '@/components/shell';
import { NowPanel, SignalCard } from '@/features/today';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';
import { loadInsights, topFinding } from '@/lib/platform/insights';

export const metadata = { title: 'Today · Ekayu' };
export const dynamic = 'force-dynamic';

/** §1.5's window. Ninety days, and the gate is 25 of 30 during validation. */
const COMPOUNDING_WINDOW_DAYS = 90;

async function TodaySummary(): Promise<ReactNode> {
  /*
   * Authorized here as well as in the layout.
   *
   * The layout's guard is what redirects a signed-out visitor; this one is what
   * §5.4 means by a single authorization site being reached on every data path.
   * A Server Component that reads the record without asking is a second way in.
   */
  const authorized = await requireServerPermission('observation:read');
  if (!authorized.ok) {
    // The layout has already redirected anyone who could hit this, so reaching
    // it means a permission was revoked mid-session. Rendering nothing is
    // correct: the shell is still there, and the next navigation redirects.
    return null;
  }

  const db = getDb();
  const zone = DEFAULT_PROFILE_ZONE;
  const dayKey = dayKeyInZone(isoFromMillis(systemClock.nowMillis()), zone);

  const registry = await createMetricRepository(db).registry();
  if (!registry.ok) {
    /*
     * Said out loud rather than returned as `null`.
     *
     * This was `return null`, and it is how a transient database failure became
     * an unexplained blank screen in production: the shell painted, the
     * Suspense boundary resolved to nothing, and the operator was left looking
     * at an empty page with no way to tell a broken read from a day with
     * nothing in it. §8.9's rule is that missing data is shown as missing, and
     * the same instinct has to cover the case where the *read itself* failed —
     * an empty render is the one outcome that says nothing at all.
     *
     * Nothing is lost when this happens: the registry is reference data and
     * this is a read path. Retrying is safe and is what the operator will do.
     */
    return (
      <ErrorState
        title="Could not read the metric registry"
        description="Nothing was changed, and nothing recorded is affected — this is a read that failed. Reloading usually resolves it."
      />
    );
  }

  const closes = createDailyCloseRepository(db, registry.value);
  const [state, compounding, insights] = await Promise.all([
    closes.stateFor(dayKey, zone),
    closes.compoundingDays(dayKey, zone, COMPOUNDING_WINDOW_DAYS),
    loadInsights(db, { toDayKey: dayKey, zone }),
  ]);

  return (
    <>
      <NowPanel
        dayKey={dayKey}
        isClosed={
          state.ok && state.value.observations.some((o) => o.metricKey === 'system.daily_close.completed')
        }
        compoundingDays={compounding.ok ? compounding.value : 0}
        windowDays={COMPOUNDING_WINDOW_DAYS}
      />
      {/*
        One card, never two. The cap lives in `topFinding`, server-side, so no
        component can widen it (§3.2).
      */}
      {insights.ok && (
        <SignalCard
          finding={topFinding(insights.value)}
          insufficient={insights.value.insufficient}
          baseline={insights.value.baseline}
        />
      )}
    </>
  );
}

export default function TodayPage(): ReactNode {
  return (
    <PageContainer title="Today">
      {/*
        The Suspense boundary is what lets the shell paint before the two
        database reads finish. Without it the whole page waits on Postgres, and
        §11.5's budget is measured from the first paint rather than from the
        last query.
      */}
      <Suspense fallback={<LoadingState rows={3} label="Loading today" />}>
        <TodaySummary />
      </Suspense>
    </PageContainer>
  );
}
