'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { BarChart, Card, CardBody, EmptyState, Inline, Stack, Text } from '@naitikos/design-system';
import type { BarDatum } from '@naitikos/design-system';

import type { MoneyOverview } from '@/lib/platform/money';

/**
 * `/money` — the pillar overview (§3.2, §4.9).
 *
 * ## Doors, and two figures behind them
 *
 * §7.5's thin composition, in the shape `/body` uses: §3.2's `/money` block
 * names six surfaces and this page is six links to them. A pillar overview that
 * tries to summarise six surfaces at once becomes a dashboard, and a dashboard
 * is the room in which a composite score gets invented.
 *
 * So exactly two things sit beside the doors — where this month's money went,
 * and what the last balance readings add up to — because those are the two
 * questions §3.2 puts on the parent page and there is no third.
 *
 * ## There is no financial health score, and there will not be one
 *
 * A single number here would need weights, the weights would be invented, and
 * "10% over budget with no debt" would render identically to "on budget with a
 * maxed card" while looking authoritative about a judgement nobody made. That
 * is §4.8's argument against a project health score, and it applies harder to
 * money because a money score is the one an operator would actually act on
 * (§10.0). Spend and net worth are therefore reported separately and never
 * combined, not even into a ratio.
 *
 * ## Nothing here is laid beside a mood series
 *
 * §4.9 names "the correlation between financial stress and anxiety episodes" as
 * worth knowing. Knowing is not saying. §10.6's five controls govern any claim
 * stronger than adjacency and none of them is met by two charts on one page —
 * least of all for a pair where the arrow plausibly runs both ways and a bad
 * month at work (already in §4.8) plausibly drives both.
 *
 * ## Read-only, and therefore mutation-free
 *
 * Every write in this pillar belongs to the surface that owns the row. This
 * page is a Client Component only because the board it renders was assembled
 * for one — every amount on it is a display string, and the loader explains at
 * length why a `bigint` can never cross that boundary.
 */
export function MoneyOverviewScreen({
  overview,
}: {
  readonly overview: MoneyOverview;
}): ReactNode {
  const doors = [
    {
      href: '/money/accounts',
      title: 'Accounts',
      description: 'Named, not numbered. Each with the balance last read off it, and how old that reading is.',
    },
    {
      href: '/money/transactions',
      title: 'Transactions',
      description: `Import a statement. ${
        overview.uncategorised === 0
          ? 'Nothing is waiting to be categorised.'
          : `${String(overview.uncategorised)} ${
              overview.uncategorised === 1 ? 'row is' : 'rows are'
            } waiting to be categorised.`
      }`,
    },
    {
      href: '/money/budgets',
      title: 'Budgets',
      description: `${String(overview.activeBudgets)} in force. A budget owns no spending — what was spent is summed from transactions, every time.`,
    },
    {
      href: '/money/subscriptions',
      title: 'Subscriptions',
      description: `${String(overview.activeSubscriptions)} recurring ${
        overview.activeSubscriptions === 1 ? 'commitment' : 'commitments'
      }. The question is what you have stopped noticing.`,
    },
    {
      href: '/money/shopping',
      title: 'Shopping',
      description: `${String(overview.openShoppingItems)} on the list. A list and a purchase history, because they are one thing at two moments.`,
    },
    {
      href: '/money/networth',
      title: 'Net worth',
      description: 'Built from balances that were read, never from balances that were computed.',
    },
  ] as const;

  /*
   * The top eight only. §8.9's categorical palette has eight slots and the
   * loader cycles past them, so a ninth category would repeat a colour and
   * colour is the encoding here. The full list is printed underneath, where it
   * is not — no category is dropped, because a total that omits one is wrong.
   */
  const bars: readonly BarDatum[] = overview.spendByCategory.slice(0, 8).map((slice) => ({
    id: slice.category,
    label: slice.label,
    value: slice.value,
    slot: slice.slot,
    detail: `${slice.spent} · ${String(slice.transactions)} ${slice.transactions === 1 ? 'transaction' : 'transactions'}`,
  }));

  return (
    <Stack gap="6">
      <Stack gap="2">
        {doors.map((door) => (
          <Card key={door.href} variant="interactive">
            <CardBody>
              <Link href={door.href} className="nos-card__link">
                <Inline justify="between" align="center">
                  <Stack gap="1">
                    <Text role="title-3" as="h2">
                      {door.title}
                    </Text>
                    <Text role="body-sm" tone="secondary">
                      {door.description}
                    </Text>
                  </Stack>
                </Inline>
              </Link>
            </CardBody>
          </Card>
        ))}
      </Stack>

      <Stack gap="2">
        <Text role="title-3" as="h2">
          This month
        </Text>
        <Text role="caption" tone="tertiary">
          {overview.monthStartDayKey} to {overview.todayDayKey}, in {overview.currency}.
        </Text>

        {overview.spendByCategory.length === 0 ? (
          <EmptyState
            title="Nothing categorised this month"
            /* Not "you spent nothing". §10.0: the far likelier explanation is
               that the statement has not been imported yet, and a confident
               zero on a spending page is reassuring in the wrong direction. */
            description="Either no statement has been imported yet, or nothing imported has been given a category. An uncategorised row is in no total."
          />
        ) : (
          <>
            <BarChart
              title="Spend by category"
              description="Outflows only, summed from transactions. Income and transfers are not spending and are not here."
              data={bars}
              unit={overview.currency}
            />

            <Inline gap="6" wrap>
              <Figure
                label="Categorised spend"
                value={overview.monthSpent ?? 'Nothing categorised yet'}
              />
              <Figure label="Transactions in the month" value={String(overview.monthTransactions)} />
              <Figure
                label="Waiting to be categorised"
                value={String(overview.uncategorised)}
              />
            </Inline>

            {overview.uncategorised > 0 && (
              <Text role="caption" tone="tertiary">
                An uncategorised transaction is in no category total, so the figures above understate
                the month by exactly that queue. They are on{' '}
                <Link href="/money/transactions">the transactions page</Link>.
              </Text>
            )}

            {overview.spendByCategory.length > bars.length && (
              <Stack gap="1">
                {overview.spendByCategory.slice(bars.length).map((slice) => (
                  <Text key={slice.category} role="body-sm" tone="secondary">
                    {slice.label} · {slice.spent} · {String(slice.transactions)}{' '}
                    {slice.transactions === 1 ? 'transaction' : 'transactions'}
                  </Text>
                ))}
                <Text role="caption" tone="tertiary">
                  Listed rather than plotted: the palette holds eight colours and a ninth bar would
                  repeat one.
                </Text>
              </Stack>
            )}
          </>
        )}
      </Stack>

      <Stack gap="2">
        <Text role="title-3" as="h2">
          Net worth
        </Text>
        <Inline gap="6" wrap>
          <Figure
            label={`Latest, in ${overview.currency}`}
            /* Never zero. No reading is not a balance of nothing. */
            value={overview.netWorth ?? 'No balance readings yet'}
          />
          <Figure
            label="As at"
            value={overview.netWorthAsOfDayKey ?? 'Nothing read'}
          />
          <Figure label="Accounts counted" value={String(overview.netWorthAccountsCounted)} />
        </Inline>

        {overview.netWorthAccountsStale > 0 && (
          <Text role="body-sm" tone="secondary">
            {String(overview.netWorthAccountsStale)} of those{' '}
            {overview.netWorthAccountsStale === 1 ? 'accounts contributed a reading' : 'accounts contributed readings'}{' '}
            older than the staleness threshold. A net worth built from a six-month-old balance is a
            number, not a fact.
          </Text>
        )}

        <Link href="/money/networth">
          <Text role="body" tone="accent" as="span">
            The whole line →
          </Text>
        </Link>
      </Stack>

      {overview.excludedCurrencies.length > 0 && (
        <Card variant="outlined">
          <CardBody>
            {/*
              Named, never converted. There is no rate table in this system and
              adding one would make every historical figure depend on the day it
              was redrawn — a chart that cannot be compared against itself.
            */}
            <Text role="body-sm" tone="secondary">
              Amounts in {listCurrencies(overview.excludedCurrencies)} are not in any figure above.
              This system holds no exchange rates, so nothing is converted and nothing is summed
              across currencies.
            </Text>
          </CardBody>
        </Card>
      )}
    </Stack>
  );
}

function Figure({ label, value }: { readonly label: string; readonly value: string }): ReactNode {
  return (
    <Stack gap="1">
      <Text role="caption" tone="tertiary">
        {label}
      </Text>
      <Text role="metric-m" as="span">
        {value}
      </Text>
    </Stack>
  );
}

/** `['USD', 'AED']` → `'USD and AED'`. A sentence, not a comma-joined list. */
function listCurrencies(codes: readonly string[]): string {
  if (codes.length <= 1) return codes.join('');
  return `${codes.slice(0, -1).join(', ')} and ${codes[codes.length - 1] ?? ''}`;
}
