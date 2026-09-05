'use client';

import type { ReactNode } from 'react';
import { Card, CardBody, Inline, Stack, Text, TrendChart } from '@naitikos/design-system';
import type { ChartData } from '@naitikos/design-system';

import type { NetWorthBoard } from '@/lib/platform/money';

/**
 * `/money/networth` — §3.2's "net worth over time".
 *
 * ## A number built from a six-month-old balance is a number, not a fact
 *
 * Balances are observed, never derived (`docs/money.md` §4), and an observation
 * has an age. A net worth assembled from a stale savings figure is
 * arithmetically correct and materially false, and nothing in the figure itself
 * says which. So the stale count is stated in a sentence beside the total
 * rather than tucked into a tooltip, and the threshold it uses is printed with
 * it — a page that flags something owes the reader the rule it flagged by.
 *
 * That is the same instinct §10.0 applies to model output: a figure travels
 * with what is known about its reliability. Arithmetic does not exempt it.
 *
 * ## Assets, liabilities and net are three figures, never one
 *
 * The same net worth can be ₹10L of savings, or ₹60L of savings against ₹50L of
 * loan, and those are different situations that one number renders identically.
 * There is also no composite score on this page and there will not be one: the
 * weights would be invented, and a single number that scored "on budget with a
 * maxed card" the same as "10% over with no debt" would look authoritative
 * about a judgement nobody made (§10.0).
 *
 * ## Gaps are gaps, and the line breaks
 *
 * A day with no balance reading contributes `null`, and the chart draws
 * nothing there. Carrying yesterday's figure forward would draw a flat line
 * across the five weeks the operator did not open their banking app, and a flat
 * line is a finding — stability — that the record does not support. §8.9(3):
 * interpolation across a week of no data is fabrication.
 *
 * ## One currency, and what it leaves out is named
 *
 * There are no exchange rates in this system. A converted historical total is
 * only meaningful paired with the rate and the date it was taken, and a chart
 * whose past silently changes each time it is redrawn cannot be compared
 * against itself — which is the entire reason this record exists (§1.2). An
 * account denominated in something else is excluded and its currency is named,
 * because "this figure does not describe your dollar account" is the one thing
 * a reader cannot work out from the figure.
 *
 * ## Read-only
 *
 * Nothing is written from here. A balance is recorded on `/money/accounts`,
 * beside the account it was read off and the flag that decides its sign.
 */
export function NetWorthScreen({ board }: { readonly board: NetWorthBoard }): ReactNode {
  const readings = board.series.filter((point) => point.value !== null);
  const latest = readings[readings.length - 1] ?? null;

  const data: ChartData = {
    series: [
      {
        id: 'net-worth',
        label: `Net worth (${board.currency})`,
        slot: 1,
        unit: board.currency,
        points: board.series.map((point) => ({
          at: point.dayKey,
          /* `null` is a day nobody read a balance on. The line breaks there. */
          value: point.value,
        })),
      },
    ],
    yAxis: {
      /*
       * Zero-baselined deliberately. A net-worth line cropped to its own range
       * turns a 2% month into a cliff, and this is the chart in the system most
       * likely to be looked at in a bad mood. §8.9(1) permits truncation when
       * it is marked; it is not needed here, so it is not taken.
       */
      zeroBaseline: true,
      unit: board.currency,
      label: 'Net worth',
    },
  };

  return (
    <Stack gap="6">
      <Inline gap="6" wrap>
        {/* Three figures. Never combined, and never a score. */}
        <Figure label={`Assets in ${board.currency}`} value={board.assets ?? 'No readings yet'} />
        <Figure
          label={`Owed in ${board.currency}`}
          value={board.liabilities ?? 'No readings yet'}
        />
        <Figure label={`Net in ${board.currency}`} value={board.net ?? 'No readings yet'} />
      </Inline>

      <Stack gap="1">
        <Text role="body-sm" tone="secondary">
          {describeReliability(board)}
        </Text>
        <Text role="caption" tone="tertiary">
          Liabilities are shown as the positive amount owed and subtracted from assets to get the
          net. Which accounts count as owed is a flag set on the account, not a guess from its kind
          — a wallet holding a prepaid balance and a wallet representing a credit line are the same
          kind and opposite signs.
        </Text>
      </Stack>

      {board.excludedCurrencies.length > 0 && (
        <Card variant="outlined">
          <CardBody>
            <Text role="body-sm" tone="secondary">
              Accounts denominated in {listCurrencies(board.excludedCurrencies)} are not in these
              figures or in the line below. This system holds no exchange rates: there is no
              conversion, so a second currency is a second line rather than a bigger number, and
              this one is missing whatever those accounts hold.
            </Text>
          </CardBody>
        </Card>
      )}

      <TrendChart
        title={`Net worth — last ${String(board.windowDays)} days`}
        description="Built only from balances that were read. A day with no reading is a gap, not a flat stretch."
        data={data}
        caveat="Each point totals every account's most recent reading as at that day, so a point is what was known then rather than what was read then. The staleness count above is how old that knowledge is allowed to get."
      />

      <Stack gap="1">
        <Text role="caption" tone="tertiary">
          {readings.length === 0
            ? 'No balance has been read in this window, so the line is drawn empty rather than hidden. Missing data is shown as missing.'
            : `${String(readings.length)} ${readings.length === 1 ? 'day carries' : 'days carry'} a reading in the last ${String(board.windowDays)} days${
                latest === null ? '' : `, the most recent on ${latest.dayKey}`
              }.`}
        </Text>
        {latest?.label !== null && latest?.label !== undefined && (
          <Text role="caption" tone="tertiary">
            That reading totalled {latest.label}.
          </Text>
        )}
      </Stack>
    </Stack>
  );
}

function describeReliability(board: NetWorthBoard): string {
  if (board.accountsCounted === 0) {
    /* Not "₹0.00". No account has been read, which is a statement about the
       record rather than about the operator's holdings (§10.0). */
    return 'No account has a balance reading, so there is no net worth to report. Record one on the accounts page and this figure starts existing.';
  }

  const counted = `${String(board.accountsCounted)} ${board.accountsCounted === 1 ? 'account' : 'accounts'} contributed a reading`;

  if (board.accountsStale === 0) {
    return `${counted}, and none of them is older than ${String(board.staleThresholdDays)} days.`;
  }

  return `${counted}, and ${String(board.accountsStale)} of those ${board.accountsStale === 1 ? 'reading is' : 'readings are'} more than ${String(board.staleThresholdDays)} days old. A net worth built from a six-month-old balance is a number, not a fact — this one is that old in ${board.accountsStale === 1 ? 'one place' : `${String(board.accountsStale)} places`}.`;
}

function Figure({ label, value }: { readonly label: string; readonly value: string }): ReactNode {
  return (
    <Stack gap="1">
      <Text role="caption" tone="tertiary">
        {label}
      </Text>
      <Text role="metric-l" as="span">
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
