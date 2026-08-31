'use client';

import { useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { uuidV7 } from '@naitikos/shared';
import { REVIEW_KINDS, REVIEW_KIND_LABELS, systemClock } from '@naitikos/core';
import type { ReviewKind } from '@naitikos/core';
import { Badge, Button, Card, CardBody, EmptyState, Inline, Stack, Text } from '@naitikos/design-system';

import type { ReviewsBoard } from '@/lib/platform/reviews';
import { draftReview } from '../services/reviewClient';

/**
 * `/life/reviews` — §4.12.
 *
 * ## The draft costs nothing and asserts nothing new
 *
 * Pressing "Draft this" runs a set of queries and arranges their answers. No
 * model is called, no key is needed, and the same period drafted twice produces
 * the same bytes. §10.0: "the model never computes, discovers, or asserts."
 * Every figure in the document came out of the record, which is why the page
 * says so above the list rather than leaving it to be assumed.
 *
 * ## An unfinished period cannot be drafted, and the button says why
 *
 * A greyed control with no explanation is a bug report waiting to be filed. The
 * reason is printed next to it: a review of a period that has not ended is a
 * review of a partial record, and §4.12 archives reviews permanently — so a
 * document quietly describing three days of a week as the week is a lie the
 * archive keeps.
 *
 * ## `drafted` is a state the page is allowed to look unimpressed by
 *
 * A drafted review and a completed one are not the same object, and the badge
 * distinguishes them. §4.12 is explicit that "a review the user did not edit is
 * a review they did not do", so a list that showed both as "done" would be
 * counting work that has not happened.
 */
export function ReviewsScreen({
  board,
  zone,
}: {
  readonly board: ReviewsBoard;
  readonly zone: string;
}): ReactNode {
  const router = useRouter();
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const draft = useMutation({
    mutationFn: async (input: { readonly kind: ReviewKind; readonly fromDayKey: string }) => {
      return draftReview({
        id: uuidV7(systemClock.nowMillis()),
        reviewKind: input.kind,
        periodStartDayKey: input.fromDayKey,
        zone,
      });
    },
    onSuccess: (result) => {
      setProblem(null);
      setPending(null);
      router.push(`/life/reviews/${result.review.id}`);
    },
    onError: (error: unknown) => {
      setPending(null);
      setProblem(error instanceof Error ? error.message : 'Could not draft that review.');
    },
  });

  return (
    <Stack gap="6">
      <Card variant="outlined">
        <CardBody>
          <Text role="body-sm" tone="secondary">
            A draft is assembled from the record — every figure in it comes from a query, and nothing in it
            is written by a model. It works with no network and no API key. The draft is the labour-saving
            part; the editing is the value.
          </Text>
        </CardBody>
      </Card>

      {problem !== null && (
        <Text role="body-sm" tone="critical">
          {problem}
        </Text>
      )}

      {REVIEW_KINDS.map((kind) => {
        const rows = board.periods.filter((entry) => entry.period.kind === kind);
        if (rows.length === 0) return null;

        return (
          <Stack key={kind} gap="2">
            <Text role="title-3" as="h2">
              {REVIEW_KIND_LABELS[kind]}
            </Text>

            {rows.map((entry) => {
              const busy = pending === entry.period.fromDayKey && draft.isPending;

              return (
                <Card key={`${kind}:${entry.period.fromDayKey}`} variant="outlined">
                  <CardBody>
                    <Stack gap="2">
                      <Inline gap="3" align="center" justify="between" wrap>
                        <Stack gap="1">
                          <Text role="body" as="span">
                            {entry.period.label}
                          </Text>
                          <Text role="caption" tone="tertiary">
                            {entry.period.fromDayKey} to {entry.period.toDayKey}
                          </Text>
                        </Stack>

                        <Inline gap="2" align="center" wrap>
                          {entry.review !== null && <StateBadge state={entry.review.state} />}

                          {entry.review !== null && (
                            <Link className="nos-inline-link" href={`/life/reviews/${entry.review.id}`}>
                              Open
                            </Link>
                          )}

                          <Button
                            size="sm"
                            variant={entry.review === null ? 'primary' : 'secondary'}
                            disabled={!entry.closed || draft.isPending}
                            onClick={() => {
                              setPending(entry.period.fromDayKey);
                              draft.mutate({ kind, fromDayKey: entry.period.fromDayKey });
                            }}
                          >
                            {busy ? 'Drafting…' : entry.review === null ? 'Draft this' : 'Re-draft'}
                          </Button>
                        </Inline>
                      </Inline>

                      {/* The reason, next to the disabled control rather than
                          left for the operator to infer from a grey button. */}
                      {!entry.closed && (
                        <Text role="caption" tone="tertiary">
                          This period has not ended. A review of a period still being lived is a review of a
                          partial record, and none of its figures would say so.
                        </Text>
                      )}

                      {/* §4.12, stated on the row it applies to. */}
                      {entry.review !== null && entry.review.state !== 'complete' && (
                        <Text role="caption" tone="tertiary">
                          Drafted, not done. A review you did not edit is a review you did not do.
                        </Text>
                      )}

                      {entry.review !== null && entry.review.state === 'complete' && (
                        <Text role="caption" tone="tertiary">
                          Re-drafting refreshes the figures and leaves every word you wrote where it is.
                        </Text>
                      )}
                    </Stack>
                  </CardBody>
                </Card>
              );
            })}
          </Stack>
        );
      })}

      <Stack gap="2">
        <Text role="title-3" as="h2">
          The archive
        </Text>
        {board.reviews.length === 0 ? (
          <EmptyState
            title="No reviews yet"
            description="Pick a period above and draft it. The draft takes a moment and asserts nothing you did not record."
          />
        ) : (
          board.reviews.map((review) => (
            <Card key={review.id} variant="flat">
              <CardBody>
                <Inline gap="3" align="center" justify="between" wrap>
                  <Link className="nos-inline-link" href={`/life/reviews/${review.id}`}>
                    {REVIEW_KIND_LABELS[review.kind]} · {review.periodStart.slice(0, 10)}
                  </Link>
                  <Inline gap="2" align="center">
                    <StateBadge state={review.state} />
                    {review.completedAt !== null && (
                      <Text role="caption" tone="tertiary">
                        {review.completedAt.slice(0, 10)}
                      </Text>
                    )}
                  </Inline>
                </Inline>
              </CardBody>
            </Card>
          ))
        )}
      </Stack>
    </Stack>
  );
}

/**
 * Three states, three badges.
 *
 * `drafted` is deliberately `neutral` rather than `positive`. It is the state a
 * review reaches by pressing one button, and dressing it as an achievement
 * would be the interface counting work that has not happened.
 */
function StateBadge({ state }: { readonly state: 'drafted' | 'editing' | 'complete' }): ReactNode {
  if (state === 'complete') return <Badge tone="positive">Complete</Badge>;
  if (state === 'editing') return <Badge tone="accent">Being edited</Badge>;
  return <Badge tone="neutral">Drafted, not done</Badge>;
}
