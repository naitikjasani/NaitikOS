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
import { createConsoleLogger, createDailyCloseRepository, createMetricRepository } from '@naitikos/db';

import { PageContainer } from '@/components/shell';
import { NowPanel, SignalCard } from '@/features/today';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';
import { loadInsights, topFinding } from '@/lib/platform/insights';

export const metadata = { title: 'Today · Ekayu' };
export const dynamic = 'force-dynamic';

/** §1.5's window. Ninety days, and the gate is 25 of 30 during validation. */
const COMPOUNDING_WINDOW_DAYS = 90;

/**
 * How long any one read on this page may take before the page gives up on it.
 *
 * Eight seconds. Every query this page issues completes in under 100 ms
 * against the hosted database — measured, repeatedly — so eight seconds is two
 * orders of magnitude of headroom and still fast enough that a person waiting
 * has not yet decided the application is broken.
 *
 * The number exists because of what happened without it. A read hung, the
 * `Promise.all` below had no way to give up, and the request sat until
 * **Vercel's own 300-second limit** killed the function. The operator saw a
 * skeleton for five minutes and then nothing — no error, no explanation, and
 * no way to tell it apart from a page that simply had nothing to show.
 *
 * A page that cannot fail cannot tell you it failed. This is the smaller,
 * honest failure that replaces the silent one.
 */
const READ_BUDGET_MS = 8_000;

/** §5.13's structured logger. `console` is lint-forbidden, and rightly. */
const pageLogger = createConsoleLogger();

/**
 * Resolve `work`, or give up after {@link READ_BUDGET_MS}.
 *
 * Returns `null` on timeout rather than throwing, because the caller's job is
 * to render what it *does* have. §8.9: a missing figure is shown as missing,
 * and a read that took too long is a missing figure with a reason.
 *
 * The timer is cleared on both paths — an unresolved timer keeps the serverless
 * invocation alive after the response has been sent, which is how a page that
 * looks fine still bills for eight seconds.
 */
async function withinBudget<T>(label: string, work: Promise<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const started = systemClock.nowMillis();

  try {
    return await Promise.race([
      work,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          /* Named, so the next occurrence says which read was slow rather than
           * leaving the whole page under suspicion. Through the logger rather
           * than `console`: §5.13 requires structured output, and the lint rule
           * enforcing it is why a journal entry has never reached a hosting
           * provider's log aggregator. */
          pageLogger.error(`read exceeded its budget: ${label}`, {
            component: 'today.page',
            identifiers: { label, budgetMs: String(READ_BUDGET_MS) },
          });
          resolve(null);
        }, READ_BUDGET_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    const elapsed = systemClock.nowMillis() - started;
    if (elapsed > 1_000) {
      pageLogger.warn(`slow read: ${label}`, {
        component: 'today.page',
        identifiers: { label, elapsedMs: String(elapsed) },
      });
    }
  }
}

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

  const registry = await withinBudget('metric-registry', createMetricRepository(db).registry());
  if (registry === null || !registry.ok) {
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

  /*
   * Each read is budgeted separately, and the page renders whatever arrived.
   *
   * Previously one `Promise.all` with no ceiling: any single slow read held the
   * whole page until Vercel killed the function at 300 seconds, and the
   * operator got a skeleton and then silence.
   *
   * Budgeting them individually also makes the *right* thing degrade. The Now
   * panel is the reason to open this page; the signal card is §3.2's "at most
   * ONE insight" and is the most expensive read here, because it assembles the
   * whole detector battery. If the insight is what is slow, the Close should
   * still be one tap away — so a missing signal costs the signal and nothing
   * else.
   */
  const [state, compounding, insights] = await Promise.all([
    withinBudget('close-state', closes.stateFor(dayKey, zone)),
    withinBudget('compounding-days', closes.compoundingDays(dayKey, zone, COMPOUNDING_WINDOW_DAYS)),
    withinBudget('insights', loadInsights(db, { toDayKey: dayKey, zone })),
  ]);

  return (
    <>
      <NowPanel
        dayKey={dayKey}
        isClosed={
          state !== null &&
          state.ok &&
          state.value.observations.some((o) => o.metricKey === 'system.daily_close.completed')
        }
        compoundingDays={compounding !== null && compounding.ok ? compounding.value : 0}
        windowDays={COMPOUNDING_WINDOW_DAYS}
      />
      {/*
        One card, never two. The cap lives in `topFinding`, server-side, so no
        component can widen it (§3.2).
      */}
      {insights !== null && insights.ok && (
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
