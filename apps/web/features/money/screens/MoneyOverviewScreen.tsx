import 'server-only';

import type { ReactNode } from 'react';
import Link from 'next/link';
import {
  BarChart,
  Button,
  Card,
  CardBody,
  CardHeader,
  Grid,
  Inline,
  Stack,
  Text,
} from '@naitikos/design-system';
import type { BarDatum } from '@naitikos/design-system';

import type { MoneyOverview } from '@/lib/platform/money';

/**
 * `/money` — the pillar overview (§3.2, §4.9).
 *
 * Laid out in the five bands settled in `HealthOverviewScreen` — act, attend,
 * state, record, doors. The doors moved to the bottom in the process: they were
 * the first six things on the page, which meant the two figures §3.2 actually
 * asks this page to carry were below six cards of prose.
 *
 * ## Doors, and two figures behind them
 *
 * §7.5's thin composition: §3.2's `/money` block names six surfaces and this
 * page is six links to them. A pillar overview that tries to summarise six
 * surfaces at once becomes a dashboard, and a dashboard is the room in which a
 * composite score gets invented.
 *
 * So exactly two things sit beside the doors — where this month's money went,
 * and what the last balance readings add up to — because those are the two
 * questions §3.2 puts on the parent page and there is no third.
 *
 * These doors stay full cards rather than the button row the other overviews
 * use for band 5, and the exception is deliberate: each one carries a live
 * count, and the count is the reason to open the door. "Nine rows waiting to be
 * categorised" is the sentence that gets a statement imported.
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
 * Nor is anything on this page coloured by whether the month went well. §8.2's
 * valence rule is written for health data and there is no version of the
 * argument that stops at the pillar boundary: the person reading an overspend
 * in amber is the person §8.2 was written about.
 *
 * ## Nothing here is laid beside a mood series
 *
 * §4.9 names "the correlation between financial stress and anxiety episodes" as
 * worth knowing. Knowing is not saying. §10.6's five controls govern any claim
 * stronger than adjacency and none of them is met by two charts on one page —
 * least of all for a pair where the arrow plausibly runs both ways and a bad
 * month at work (already in §4.8) plausibly drives both.
 *
 * ## Read-only, and therefore a Server Component
 *
 * Every write in this pillar belongs to the surface that owns the row, so there
 * is no interaction on this page at all. It carried `'use client'` because the
 * board was assembled for one — every amount arrives as a display string, since
 * a `bigint` cannot cross the boundary — but that is a fact about the loader,
 * not a reason to ship a hydration bundle for six links and a bar chart.
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
      {/* 1 — Act. This pillar has one write worth putting above the fold: the
          statement import, which is what makes every figure below it true. */}
      <Inline gap="3" wrap>
        <Button asChild variant="primary">
          <Link href="/money/transactions">Import a statement</Link>
        </Button>
        <Button asChild variant="secondary">
          <Link href="/money/accounts">Update a balance</Link>
        </Button>
      </Inline>

      {/* 2 — Attend. Both are statements about the *data*, not about the
          operator's finances — which is the only kind of thing this band is
          allowed to hold on a money page. Neither is rendered when the queue is
          empty and the readings are fresh. */}
      {overview.uncategorised > 0 && (
        <Card variant="outlined">
          <CardHeader
            as="h2"
            title={`${String(overview.uncategorised)} ${overview.uncategorised === 1 ? 'transaction is' : 'transactions are'} in no category total`}
            actions={
              <Button asChild variant="ghost" size="sm">
                <Link href="/money/transactions">Categorise them</Link>
              </Button>
            }
          />
          <CardBody>
            <Text role="body-sm" tone="secondary">
              The month below understates spending by exactly that queue. Every figure on this page
              is a sum over categorised rows, so an uncategorised row is invisible rather than
              wrong.
            </Text>
          </CardBody>
        </Card>
      )}

      {overview.netWorthAccountsStale > 0 && (
        <Card variant="outlined">
          <CardHeader
            as="h2"
            title={`${String(overview.netWorthAccountsStale)} ${overview.netWorthAccountsStale === 1 ? 'balance is' : 'balances are'} older than the staleness threshold`}
            actions={
              <Button asChild variant="ghost" size="sm">
                <Link href="/money/accounts">Accounts</Link>
              </Button>
            }
          />
          <CardBody>
            <Text role="body-sm" tone="secondary">
              A net worth built from a six-month-old balance is a number, not a fact.
            </Text>
          </CardBody>
        </Card>
      )}

      {/* 3 — State. */}
      <Card variant="outlined">
        <CardHeader
          as="h2"
          title="This month"
          description={`${overview.monthStartDayKey} to ${overview.todayDayKey}, in ${overview.currency}.`}
        />
        <CardBody
          empty={{
            title: 'Nothing categorised this month',
            /* Not "you spent nothing". §10.0: the far likelier explanation is
               that the statement has not been imported yet, and a confident
               zero on a spending page is reassuring in the wrong direction. */
            description:
              'Either no statement has been imported yet, or nothing imported has been given a category. An uncategorised row is in no total.',
          }}
        >
          {overview.spendByCategory.length === 0 ? null : (
            <Stack gap="4">
              <BarChart
                title="Spend by category"
                description="Outflows only, summed from transactions. Income and transfers are not spending and are not here."
                data={bars}
                unit={overview.currency}
              />

              <Grid gap="4" minColumnWidth="10rem">
                <Figure
                  label="Categorised spend"
                  value={overview.monthSpent ?? 'Nothing categorised yet'}
                />
                <Figure label="Transactions in the month" value={String(overview.monthTransactions)} />
                <Figure label="Waiting to be categorised" value={String(overview.uncategorised)} />
              </Grid>

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
            </Stack>
          )}
        </CardBody>
      </Card>

      <Card variant="outlined">
        <CardHeader
          as="h2"
          title="Net worth"
          actions={
            <Button asChild variant="ghost" size="sm">
              <Link href="/money/networth">The whole line</Link>
            </Button>
          }
        />
        <CardBody>
          <Grid gap="4" minColumnWidth="10rem">
            <Figure
              label={`Latest, in ${overview.currency}`}
              /* Never zero. No reading is not a balance of nothing. */
              value={overview.netWorth ?? 'No balance readings yet'}
            />
            <Figure label="As at" value={overview.netWorthAsOfDayKey ?? 'Nothing read'} />
            <Figure label="Accounts counted" value={String(overview.netWorthAccountsCounted)} />
          </Grid>
        </CardBody>
      </Card>

      {/* 4 — Record. One card, and only when it has something to say: a
          currency the figures above exclude is the single thing that can make
          them silently wrong. */}
      {overview.excludedCurrencies.length > 0 && (
        <Card variant="outlined">
          <CardHeader as="h2" title="Not in any figure above" />
          <CardBody>
            {/*
              Named, never converted. There is no rate table in this system and
              adding one would make every historical figure depend on the day it
              was redrawn — a chart that cannot be compared against itself.
            */}
            <Text role="body-sm" tone="secondary">
              Amounts in {listCurrencies(overview.excludedCurrencies)} are not included. This system
              holds no exchange rates, so nothing is converted and nothing is summed across
              currencies.
            </Text>
          </CardBody>
        </Card>
      )}

      {/* 5 — Doors. Cards rather than a button row; see the header. */}
      <Stack gap="2">
        <Text role="title-3" as="h2">
          Everything in Money
        </Text>
        {doors.map((door) => (
          <Card key={door.href} variant="interactive">
            <CardBody>
              <Link href={door.href} className="nos-card__link">
                <Stack gap="1">
                  <Text role="title-3" as="h3">
                    {door.title}
                  </Text>
                  <Text role="body-sm" tone="secondary">
                    {door.description}
                  </Text>
                </Stack>
              </Link>
            </CardBody>
          </Card>
        ))}
      </Stack>
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
