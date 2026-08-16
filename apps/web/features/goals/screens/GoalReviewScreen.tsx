'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { PROGRESS_STATUS_LABELS, describeTarget, explainProgress, formatDay } from '@naitikos/core';
import { Badge, Card, CardBody, EmptyState, Inline, Stack, Text } from '@naitikos/design-system';

import type { GoalReview } from '@/lib/platform/goals';

/**
 * `/life/goals/review` — §4.10's review ritual.
 *
 * ## Not "where am I". "What changed, and why."
 *
 * The overview already answers the first question. This page answers the one
 * that only a snapshot history can: *has the picture moved since I last looked?*
 * — and, crucially, it cannot tell you whether it moved because you did or
 * because the data behind it was corrected. §9.2 is why the snapshots exist:
 * "the trajectory as it was believed at the time is preserved even after the
 * underlying data is corrected."
 *
 * So the page shows the delta and says plainly that it does not know which of
 * the two produced it. Guessing would be the more useful-looking answer and the
 * wrong one (P5).
 *
 * ## No score, no grade, no streak
 *
 * A review that scored the week would be a streak with a longer name, and
 * §1.5 refused a streak for a reason that applies here exactly: "miss day 34
 * and the incentive collapses, which is precisely the anxiety-amplifying
 * dynamic P6 prohibits."
 */
export function GoalReviewScreen({ review }: { readonly review: GoalReview }): ReactNode {
  if (review.lines.length === 0) {
    return (
      <Stack gap="4">
        <EmptyState
          icon="domain.streak"
          title="Nothing to review"
          description="Active goals appear here with how their trajectory has moved since you last looked."
        />
        <Text role="body-sm" tone="secondary" align="center">
          <Link className="nos-inline-link" href="/life/goals">
            Set a goal
          </Link>
        </Text>
      </Stack>
    );
  }

  return (
    <Stack gap="5">
      <Text role="body-sm" tone="secondary">
        Compared against what was believed on or before {formatDay(review.since) ?? review.since.slice(0, 10)}.
      </Text>

      <Stack gap="2">
        {review.lines.map((line) => (
          <Card key={line.target.id} variant="outlined">
            <CardBody>
              <Stack gap="2">
                <Inline justify="between" align="center" wrap>
                  <Link className="nos-inline-link" href={`/life/goals/${line.goal.id}`}>
                    {line.goal.title}
                  </Link>
                  <Badge
                    tone={
                      line.progress.status === 'away'
                        ? 'caution'
                        : line.progress.status === 'met' || line.progress.status === 'on_track'
                          ? 'accent'
                          : 'neutral'
                    }
                  >
                    {PROGRESS_STATUS_LABELS[line.progress.status]}
                  </Badge>
                </Inline>

                <Text role="caption" tone="tertiary">
                  {line.target.metricKey} — {describeTarget(line.target)}
                </Text>

                <Text role="body-sm" tone="secondary">
                  {describeChange(line)}
                </Text>

                <Text role="caption" tone="tertiary">
                  {explainProgress(line.progress, line.target)}
                </Text>
              </Stack>
            </CardBody>
          </Card>
        ))}
      </Stack>

      {review.tensions.length > 0 && (
        <Stack gap="2">
          <Text role="title-3" as="h2">
            Still pulling against each other
          </Text>
          {review.tensions.map((tension) => (
            <Text role="body-sm" tone="secondary" key={tension.id}>
              {tension.claim}
            </Text>
          ))}
        </Stack>
      )}

      <Text role="body-sm" tone="secondary">
        <Link className="nos-inline-link" href="/life/goals">
          All goals
        </Link>
      </Text>
    </Stack>
  );
}

/**
 * The sentence, including the part the system does not know.
 *
 * A movement in the ratio has two possible causes and this page cannot separate
 * them. Saying so is the whole difference between a review that is trustworthy
 * and one that quietly attributes a data correction to effort.
 */
function describeChange(line: GoalReview['lines'][number]): string {
  if (line.comparedTo === null) {
    return 'No earlier snapshot to compare against — this is the first look.';
  }

  const moved = line.arrivalMoved ? ' The projected arrival has moved.' : '';

  if (line.ratioDelta === null) {
    return `The picture has changed since ${formatDay(line.comparedTo) ?? line.comparedTo.slice(0, 10)}, but not in a way that compares as a number.${moved}`;
  }

  const size = Math.abs(line.ratioDelta);
  if (size < 0.01) return `Essentially unchanged since ${formatDay(line.comparedTo) ?? line.comparedTo.slice(0, 10)}.${moved}`;

  const direction = line.ratioDelta > 0 ? 'closer to' : 'further from';
  return `${(size * 100).toFixed(0)}% ${direction} the target than at the last look.${moved} That is either you moving or the underlying readings being corrected — this page cannot tell which.`;
}
