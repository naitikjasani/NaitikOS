/**
 * The Now panel — §3.2's "what's due, right now".
 *
 * A Server Component. It reads the record directly rather than through the API,
 * which is the whole reason §5.1 chose the App Router: the numbers are in the
 * HTML on first paint, with no client fetch, no loading state, and no bundle.
 *
 * ## What it shows, and what it deliberately does not
 *
 * §1.5 names Compounding Days the North Star — "the count of days in the
 * trailing 90 on which a Daily Close was completed" — so that number is here,
 * and it is the only number here.
 *
 * There is no streak. §5.9 bans streak *notifications*; §1.5's reasoning bans
 * the concept: a streak makes the cost of one missed day the loss of everything
 * before it, which is precisely the pressure that ends a twenty-year record in
 * month three. A count in ninety recovers from a bad week on its own.
 */

import 'server-only';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { Badge, Button, Card, CardBody, Inline, Stack, Text } from '@naitikos/design-system';

export type NowPanelProps = {
  readonly dayKey: string;
  readonly isClosed: boolean;
  /** Days closed in the trailing ninety (§1.5). */
  readonly compoundingDays: number;
  readonly windowDays: number;
};

export function NowPanel({
  dayKey,
  isClosed,
  compoundingDays,
  windowDays,
}: NowPanelProps): ReactNode {
  return (
    <Stack gap="4">
      <Card>
        <CardBody>
          <Stack gap="4">
            <Inline gap="2">
              <Text role="title-3" as="h2">
                {isClosed ? 'Today is closed' : 'Close the day'}
              </Text>
              {isClosed && <Badge tone="positive">Done</Badge>}
            </Inline>

            <Text role="body" tone="secondary">
              {isClosed
                ? 'Recorded. Open it again to change an answer — the original is kept either way.'
                : 'Under sixty seconds. Every field is optional.'}
            </Text>

            {/*
              `asChild` so this stays an anchor: middle-click, open-in-new-tab
              and the browser's own link affordances all keep working, which a
              `<button>` that navigates would break.
            */}
            <Button asChild variant={isClosed ? 'secondary' : 'primary'} fullWidth>
              <Link href="/today/close">{isClosed ? 'Review the Close' : 'Start the Close'}</Link>
            </Button>
          </Stack>
        </CardBody>
      </Card>

      <Card variant="outlined">
        <CardBody>
          <Stack gap="2">
            <Text role="caption" tone="tertiary">
              Compounding Days
            </Text>
            {/*
              A bare number, not a chart. §8.9 reserves charts for questions a
              trend answers, and "how many of the last ninety days did I close?"
              is answered by the number itself.
            */}
            <Text role="display" as="p">
              {compoundingDays}
              <Text role="title-3" tone="tertiary" as="span">
                {' '}
                / {windowDays}
              </Text>
            </Text>
            <Text role="body-sm" tone="secondary">
              Days closed in the trailing {windowDays}. Not a streak — a missed day costs one day.
            </Text>
          </Stack>
        </CardBody>
      </Card>

      <Text role="caption" tone="tertiary" as="p">
        {dayKey}
      </Text>
    </Stack>
  );
}
