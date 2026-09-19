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
 *
 * ## The two cards are not equals
 *
 * §P8: one screen, one question, and this one's is *"what do I do next?"*. The
 * ritual card answers it and the count does not, so the count is outlined,
 * quieter, and sized at `metric-l` rather than `display` — a 36px number
 * competing with the page's own `h1` made the record's *score* the loudest
 * thing on the first screen of the day, which is both the wrong answer to the
 * question and the wrong tone to open on.
 *
 * ## Nought of ninety
 *
 * The operator starts at zero and the honest presentation of zero is the whole
 * design problem of the first two months. §10.6's principle — "'not enough data
 * yet' is honest and builds trust" — is applied here as *what the number is
 * for* rather than what it is short of. No target, no bar filling towards 75,
 * no days-remaining countdown: a progress bar at 3 of 90 is a picture of
 * failure, and §13.3 puts "the app becomes a source of anxiety" at severe.
 */

import 'server-only';

import type { ReactNode } from 'react';
import Link from 'next/link';
import {
  Badge,
  Button,
  Card,
  CardBody,
  Inline,
  Stack,
  Text,
  axisLabel,
  dayIndex,
} from '@naitikos/design-system';

/**
 * Whether today has been closed — including the case where nobody knows.
 *
 * `unknown` is what a read that exceeded the page's budget produces. It exists
 * as a third state rather than collapsing to `open` because those two are
 * different sentences: "you have not closed today" is a claim about the
 * operator, and making it wrongly at 11pm sends them to re-answer a form they
 * already filled in. §8.9's rule is that missing data is shown as missing, and
 * a boolean cannot show missing.
 */
export type CloseState = 'closed' | 'open' | 'unknown';

export type NowPanelProps = {
  readonly dayKey: string;
  readonly closeState: CloseState;
  /**
   * Days closed in the trailing ninety (§1.5), or `null` when the read failed.
   *
   * `null` rather than `0`, for the same reason. Zero is a fact about a record
   * that has nothing in it; a failed read rendered as zero tells an operator on
   * day forty that forty days of their record have gone, which is the single
   * most alarming thing this panel could say and it would not even be true.
   */
  readonly compoundingDays: number | null;
  readonly windowDays: number;
};

/**
 * What the count means today, said in the register the operator can live with.
 *
 * Three cases and no fourth. Everything here describes what the record *has*;
 * nothing describes what it is missing, and nothing compares this week to last.
 * §1.3's P6 — "no streaks that shame, no badges, no red numbers" — is a rule
 * about copy at least as much as about colour.
 */
function recordFraming(compoundingDays: number, windowDays: number): string {
  if (compoundingDays === 0) {
    return `Nothing recorded in the last ${String(windowDays)} days yet. The first Close is the whole of day one.`;
  }
  if (compoundingDays === 1) {
    return 'One day closed so far, and it is the day everything else gets measured from.';
  }
  return `Days closed in the trailing ${String(windowDays)}. Each one is history the rest of the system reads from.`;
}

export function NowPanel({
  dayKey,
  closeState,
  compoundingDays,
  windowDays,
}: NowPanelProps): ReactNode {
  /*
   * `14 Sep` rather than `2026-09-14`. The ISO key is the record's identifier
   * and it belongs in a URL; the first line of the first screen of the day is
   * read by a person, and a person reading their own date should not have to
   * parse it. Falls back to the raw key if the day is unparseable, because a
   * missing date is worse than an ugly one.
   */
  const index = dayIndex(dayKey);
  const dateLabel = index === null ? dayKey : axisLabel(index);

  return (
    <Stack gap="4">
      <Card>
        <CardBody>
          <Stack gap="4">
            <Stack gap="1">
              {/* Orientation first, and at the top rather than stranded at the
                  bottom of the panel where it used to sit — a date below the
                  action it dates is a caption for nothing. */}
              <Text role="caption" tone="tertiary" as="p">
                {dateLabel}
              </Text>
              <Inline gap="2">
                <Text role="title-2" as="h2">
                  {closeState === 'closed' ? 'Today is closed' : 'Close the day'}
                </Text>
                {closeState === 'closed' && <Badge tone="positive">Done</Badge>}
              </Inline>
            </Stack>

            <Text role="body" tone="secondary">
              {closeState === 'closed'
                ? 'Nothing else is needed today. Open it again to change an answer — the original is kept either way.'
                : closeState === 'unknown'
                  ? 'Today’s status could not be read just now, so this may already be recorded. Opening the Close will show you, and re-answering never overwrites what is there.'
                  : 'About a minute. Every field is optional, and a partial close still counts.'}
            </Text>

            {/*
              `asChild` so this stays an anchor: middle-click, open-in-new-tab
              and the browser's own link affordances all keep working, which a
              `<button>` that navigates would break.
            */}
            <Button asChild variant={closeState === 'closed' ? 'secondary' : 'primary'} fullWidth>
              <Link href="/today/close">
                {closeState === 'closed'
                  ? 'Review the Close'
                  : closeState === 'unknown'
                    ? 'Open the Close'
                    : 'Start the Close'}
              </Link>
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
              is answered by the number itself. `metric-l` rather than `display`
              because §8.3 assigns that role to "primary metric value" and
              carries tabular figures with it — the count changes daily and
              non-tabular digits make it jump.
            */}
            <Inline gap="2" align="baseline">
              <Text role="metric-l" as="p">
                {/* An em dash, and never a zero. See {@link NowPanelProps}. */}
                {compoundingDays === null ? '—' : compoundingDays}
              </Text>
              <Text role="body-sm" tone="tertiary" as="span">
                / {windowDays}
              </Text>
            </Inline>
            <Text role="body-sm" tone="secondary">
              {compoundingDays === null
                ? 'This count could not be read just now. Nothing is lost — it is a read that failed, and reloading usually resolves it.'
                : recordFraming(compoundingDays, windowDays)}
            </Text>
            <Text role="caption" tone="tertiary" as="p">
              Not a streak — a missed day costs one day, never the days before it.
            </Text>
          </Stack>
        </CardBody>
      </Card>
    </Stack>
  );
}
