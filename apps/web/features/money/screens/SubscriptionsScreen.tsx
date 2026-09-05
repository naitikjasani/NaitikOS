'use client';

import { useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { uuidV7 } from '@naitikos/shared';
import {
  SPEND_CATEGORIES,
  SPEND_CATEGORY_LABELS,
  dayKeyInZone,
  isoFromMillis,
  systemClock,
} from '@naitikos/core';
import type { SpendCategory } from '@naitikos/core';
import {
  Badge,
  Button,
  Card,
  CardBody,
  DateField,
  EmptyState,
  Inline,
  Stack,
  Text,
  TextAreaField,
  TextField,
} from '@naitikos/design-system';

import type { SubscriptionRow, SubscriptionsBoard } from '@/lib/platform/money';
import { cancelSubscription, markSubscriptionReviewed, saveSubscription } from '../services/moneyClient';

/**
 * `/money/subscriptions` — §3.2's "recurring commitments".
 *
 * ## The framing is the feature
 *
 * §3.2 does not call these subscriptions on the page it describes; it calls
 * them recurring commitments. The question is not *what do I pay for* — a bank
 * statement answers that — it is **what have I committed to and stopped
 * noticing**. So the two things on every row are the annualised cost and how
 * long it has been since anyone looked at it, and the list is ordered by the
 * second, unreviewed first. The ₹149 nobody has thought about since 2024 is the
 * row this page exists for.
 *
 * ## Annualised, because a cadence hides the number the decision is about
 *
 * ₹499 a month is a small number twelve times. `core` multiplies in `bigint`,
 * exactly, and weekly is 52 rather than 365/7 — the extra day and a bit is not
 * a payment, and rounding it into one overstates every weekly commitment by
 * about 2%.
 *
 * ## "Never reviewed" is not a large number of days
 *
 * `daysSinceReviewed` is `null` when nobody ever has, and it renders as its own
 * sentence. "You last looked 400 days ago" is wrong about a commitment recorded
 * yesterday, and inventing an age for an event that did not happen is the same
 * mistake as printing 0 for a figure with nothing behind it.
 *
 * ## Cancelling asks why, and the row stays
 *
 * A cancelled subscription is history, never a deleted row. In year three "we
 * cancelled this and re-subscribed four months later" is the interesting fact,
 * and a delete throws it away along with the reason. The note is asked for at
 * the moment the reason is known — later, it never is.
 *
 * ## What this screen deliberately cannot do
 *
 * There is no *mark as reviewed* button, because there is no wire kind that
 * records a review on its own and this board carries amounts as display strings
 * — a round-trip through the save kind would have to re-send a formatted
 * `'₹499.00'` as an amount, which the contract rightly refuses. The review date
 * is set when the commitment is recorded. Nothing here schedules a reminder
 * either: `next_due_on` records what is known and does not become a scheduler
 * (`docs/money.md` §10), and notifications are a separate consent surface
 * (§10.10) that this is not the pillar to open.
 */
export function SubscriptionsScreen({ board }: { readonly board: SubscriptionsBoard }): ReactNode {
  const router = useRouter();
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const refresh = (): void => {
    router.refresh();
  };

  /*
   * Reviewing is the counterpart to cancelling, and the list needs both to
   * mean anything. §3.2 calls these "recurring commitments"; the question is
   * what has been committed to and stopped noticing. With only a cancel
   * button the review age can go up and never down, so within a few months
   * every row reads "not reviewed for N days" and the measure stops carrying
   * information — the list becomes noise and stops being opened.
   */
  const review = useMutation({
    mutationFn: async (id: string) => {
      await markSubscriptionReviewed({
        id,
        /* The board is computed in UTC — `loadSubscriptions` takes no zone,
         * and a review date is a note about attention rather than an
         * observation, so the day it lands on need not match a capture zone. */
        reviewedOn: dayKeyInZone(isoFromMillis(systemClock.nowMillis()), 'UTC'),
      });
    },
    onSuccess: refresh,
    onError: (error: unknown) => {
      setProblem(error instanceof Error ? error.message : 'Could not record that review.');
    },
  });

  /*
   * Unreviewed first, then oldest review first. The ordering is the argument:
   * a list sorted by cost puts the commitment you think about most at the top,
   * which is exactly the one that needs no attention.
   */
  const active = [...board.active].sort((a, b) => {
    if (a.daysSinceReviewed === null && b.daysSinceReviewed === null) return a.name.localeCompare(b.name);
    if (a.daysSinceReviewed === null) return -1;
    if (b.daysSinceReviewed === null) return 1;
    return b.daysSinceReviewed - a.daysSinceReviewed;
  });

  return (
    <Stack gap="6">
      <AddSubscription board={board} onSaved={refresh} />

      <Inline gap="6" wrap>
        <Figure
          label={`Committed per year, in ${board.currency}`}
          /* Never zero. Nothing recorded is not a year that costs nothing. */
          value={board.annualisedTotal ?? 'Nothing recorded yet'}
        />
        <Figure label="Active commitments" value={String(board.active.length)} />
        <Figure label="Never reviewed" value={String(board.neverReviewed)} />
      </Inline>

      {board.excludedCurrencies.length > 0 && (
        <Text role="body-sm" tone="secondary">
          Commitments in {listCurrencies(board.excludedCurrencies)} are listed below with their own
          figures and are not in the yearly total. This system holds no exchange rates, so nothing is
          converted and nothing is summed across currencies.
        </Text>
      )}

      {problem !== null && (
        <Text role="body-sm" tone="critical">
          {problem}
        </Text>
      )}

      {active.length === 0 ? (
        <EmptyState
          title="Nothing recorded"
          description="A recurring commitment is a name, an amount and a cadence. The point of writing it down is to be asked about it later."
        />
      ) : (
        <Stack gap="2">
          {active.map((row) => (
            <Card key={row.id} variant="outlined">
              <CardBody>
                <Stack gap="2">
                  <Inline gap="3" align="center" justify="between">
                    <Stack gap="1">
                      <Text role="body" as="span">
                        {row.name}
                      </Text>
                      <Text role="caption" tone="tertiary">
                        {row.amount} {cadenceAdverb(row.cadence)}
                        {row.categoryLabel === null ? '' : ` · ${row.categoryLabel}`}
                        {row.nextDueOn === null ? '' : ` · next due ${row.nextDueOn}`}
                        {row.startedOn === null ? '' : ` · since ${row.startedOn}`}
                      </Text>
                    </Stack>
                    <Stack gap="1" align="end">
                      <Text role="metric-m" as="span">
                        {row.annualised}
                      </Text>
                      <Text role="caption" tone="tertiary">
                        a year, in {row.currency}
                      </Text>
                    </Stack>
                  </Inline>

                  <Inline gap="2" align="center" wrap>
                    <Badge tone={reviewTone(row.daysSinceReviewed)}>{describeReview(row)}</Badge>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={review.isPending || row.daysSinceReviewed === 0}
                      onClick={() => {
                        review.mutate(row.id);
                      }}
                    >
                      {/* "Still want it" rather than "Mark reviewed": the
                          decision being recorded is a judgement about the
                          commitment, not an administrative tick. */}
                      Still want it
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setCancelling(cancelling === row.id ? null : row.id);
                      }}
                    >
                      {cancelling === row.id ? 'Keep it' : 'Cancel it'}
                    </Button>
                  </Inline>

                  {row.note !== null && (
                    <Text role="body-sm" tone="secondary">
                      {row.note}
                    </Text>
                  )}

                  {cancelling === row.id && (
                    <CancelForm
                      row={row}
                      onDone={() => {
                        setCancelling(null);
                        refresh();
                      }}
                      onProblem={setProblem}
                    />
                  )}
                </Stack>
              </CardBody>
            </Card>
          ))}
        </Stack>
      )}

      {board.cancelled.length > 0 && (
        <Stack gap="2">
          <Text role="title-3" as="h2">
            Cancelled
          </Text>
          <Text role="caption" tone="tertiary">
            Kept, not deleted. What you cancelled and why is the part of this list worth reading in
            two years.
          </Text>
          {board.cancelled.map((row) => (
            <Card key={row.id} variant="outlined">
              <CardBody>
                <Stack gap="1">
                  <Inline gap="3" align="center" justify="between">
                    <Text role="body" as="span">
                      {row.name}
                    </Text>
                    <Badge tone="neutral">Cancelled {row.cancelledOn ?? ''}</Badge>
                  </Inline>
                  <Text role="caption" tone="tertiary">
                    {row.annualised} a year while it ran, in {row.currency}.
                  </Text>
                  {row.cancellationNote !== null && (
                    <Text role="body-sm" tone="secondary">
                      {row.cancellationNote}
                    </Text>
                  )}
                </Stack>
              </CardBody>
            </Card>
          ))}
        </Stack>
      )}
    </Stack>
  );
}

const CADENCES = ['weekly', 'monthly', 'quarterly', 'annual'] as const;

type Cadence = (typeof CADENCES)[number];

const CADENCE_LABELS: Readonly<Record<Cadence, string>> = {
  weekly: 'Weekly',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  annual: 'Annual',
};

function cadenceAdverb(cadence: SubscriptionRow['cadence']): string {
  switch (cadence) {
    case 'weekly':
      return 'a week';
    case 'monthly':
      return 'a month';
    case 'quarterly':
      return 'a quarter';
    default:
      return 'a year';
  }
}

/** Six months of nobody looking. A judgement, so it is stated where it is used. */
const UNREVIEWED_DAYS = 180;

function reviewTone(days: number | null): 'caution' | 'neutral' {
  return days === null || days >= UNREVIEWED_DAYS ? 'caution' : 'neutral';
}

function describeReview(row: SubscriptionRow): string {
  /* Never "0 days ago" and never a dash: nobody has looked at this, which is a
     different fact from having looked at it a long time ago. */
  if (row.daysSinceReviewed === null) return 'Never reviewed';
  if (row.daysSinceReviewed <= 0) return 'Reviewed today';
  if (row.daysSinceReviewed === 1) return 'Not reviewed since yesterday';
  return `Not reviewed for ${String(row.daysSinceReviewed)} days`;
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

/* ======================================================================
 * Cancelling
 * ====================================================================== */

function CancelForm({
  row,
  onDone,
  onProblem,
}: {
  readonly row: SubscriptionRow;
  readonly onDone: () => void;
  readonly onProblem: (message: string | null) => void;
}): ReactNode {
  /*
   * Today in UTC, which is what `loadSubscriptions` uses for the same reason:
   * a cancellation is a whole-day fact and an off-by-one at midnight is not
   * worth threading a zone through every call site to correct.
   */
  const [cancelledOn, setCancelledOn] = useState(
    dayKeyInZone(isoFromMillis(systemClock.nowMillis()), 'UTC'),
  );
  const [note, setNote] = useState('');

  const cancel = useMutation({
    mutationFn: async () => {
      await cancelSubscription({
        id: row.id,
        cancelledOn,
        cancellationNote: note.trim() === '' ? null : note.trim(),
      });
    },
    onSuccess: () => {
      onProblem(null);
      onDone();
    },
    onError: (error: unknown) => {
      onProblem(error instanceof Error ? error.message : 'Could not cancel that subscription.');
    },
  });

  return (
    <Stack gap="3">
      <DateField
        label="The day it was cancelled"
        hint="The day you actually cancelled, which may not be today."
        value={cancelledOn}
        onValueChange={setCancelledOn}
      />
      <TextAreaField
        label="Why"
        hint="Asked now because now is when you know. A cancellation with no reason is indistinguishable from a forgotten one."
        rows={2}
        value={note}
        onChange={(event) => {
          setNote(event.target.value);
        }}
      />
      <Inline gap="2">
        <Button
          size="sm"
          variant="primary"
          disabled={cancelledOn === '' || cancel.isPending}
          onClick={() => {
            cancel.mutate();
          }}
        >
          Record the cancellation
        </Button>
      </Inline>
    </Stack>
  );
}

/* ======================================================================
 * Recording a commitment
 * ====================================================================== */

/** What the wire accepts: a decimal string in major units, never a `number`. */
const AMOUNT_PATTERN = /^\d+(\.\d+)?$/u;

function AddSubscription({
  board,
  onSaved,
}: {
  readonly board: SubscriptionsBoard;
  readonly onSaved: () => void;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState(board.currency);
  const [cadence, setCadence] = useState<Cadence>('monthly');
  const [category, setCategory] = useState<SpendCategory | null>('subscriptions');
  const [nextDueOn, setNextDueOn] = useState('');
  const [lastReviewedOn, setLastReviewedOn] = useState('');
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      await saveSubscription({
        id: uuidV7(systemClock.nowMillis()),
        name: name.trim(),
        amount: amount.trim(),
        currency: currency.trim().toUpperCase(),
        cadence,
        category,
        /* No account picker here. Which card it lands on is a detail the
         * statement already carries, and this page's question is about the
         * commitment rather than about the payment rail. */
        accountId: null,
        nextDueOn: nextDueOn === '' ? null : nextDueOn,
        /* Left empty means never reviewed, and the page says exactly that
         * rather than treating the day it was typed as a review. */
        lastReviewedOn: lastReviewedOn === '' ? null : lastReviewedOn,
        note: note.trim() === '' ? null : note.trim(),
      });
    },
    onSuccess: () => {
      setOpen(false);
      setName('');
      setAmount('');
      setNextDueOn('');
      setLastReviewedOn('');
      setNote('');
      setProblem(null);
      onSaved();
    },
    onError: (error: unknown) => {
      setProblem(error instanceof Error ? error.message : 'Could not save that commitment.');
    },
  });

  if (!open) {
    return (
      <Inline gap="2">
        <Button
          variant="secondary"
          onClick={() => {
            setOpen(true);
          }}
        >
          Record a commitment
        </Button>
      </Inline>
    );
  }

  return (
    <Card variant="raised">
      <CardBody>
        <Stack gap="3">
          <TextField
            label="Name"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />

          <TextField
            label="What it charges"
            hint="A decimal, as written: 499.00. Sent as a string — a float is not money (§5.3)."
            inputMode="decimal"
            value={amount}
            onChange={(event) => {
              setAmount(event.target.value);
            }}
          />

          <TextField
            label="Currency"
            hint="Three letters. A commitment in another currency is listed with its own figures and left out of the yearly total."
            value={currency}
            maxLength={3}
            onChange={(event) => {
              setCurrency(event.target.value.toUpperCase());
            }}
          />

          <Inline gap="2" wrap>
            {CADENCES.map((option) => (
              <Button
                key={option}
                size="sm"
                variant={option === cadence ? 'primary' : 'secondary'}
                aria-pressed={option === cadence}
                onClick={() => {
                  setCadence(option);
                }}
              >
                {CADENCE_LABELS[option]}
              </Button>
            ))}
          </Inline>

          <Inline gap="2" wrap>
            {SPEND_CATEGORIES.map((option) => (
              <Button
                key={option}
                size="sm"
                variant={option === category ? 'primary' : 'secondary'}
                aria-pressed={option === category}
                onClick={() => {
                  setCategory(option === category ? null : option);
                }}
              >
                {SPEND_CATEGORY_LABELS[option]}
              </Button>
            ))}
          </Inline>

          <DateField label="Next due" value={nextDueOn} onValueChange={setNextDueOn} />

          <DateField
            label="Last reviewed"
            hint="Leave empty if nobody has actually sat down and asked whether this is still worth it. The page will say so."
            value={lastReviewedOn}
            onValueChange={setLastReviewedOn}
          />

          <TextField
            label="Note"
            value={note}
            onChange={(event) => {
              setNote(event.target.value);
            }}
          />

          {problem !== null && (
            <Text role="body-sm" tone="critical">
              {problem}
            </Text>
          )}

          <Inline gap="2">
            <Button
              variant="primary"
              disabled={
                name.trim() === '' ||
                !AMOUNT_PATTERN.test(amount.trim()) ||
                currency.trim().length !== 3 ||
                save.isPending
              }
              onClick={() => {
                save.mutate();
              }}
            >
              Save
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setOpen(false);
              }}
            >
              Cancel
            </Button>
          </Inline>
        </Stack>
      </CardBody>
    </Card>
  );
}
