'use client';

import { useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { uuidV7 } from '@naitikos/shared';
import {
  BUDGET_PERIODS,
  BUDGET_PERIOD_LABELS,
  NON_SPEND_CATEGORIES,
  SPEND_CATEGORIES,
  SPEND_CATEGORY_LABELS,
  systemClock,
} from '@naitikos/core';
import type { BudgetPeriod, SpendCategory } from '@naitikos/core';
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
  TextField,
} from '@naitikos/design-system';

import type { BudgetRow, BudgetsBoard } from '@/lib/platform/money';
import { saveBudget } from '../services/moneyClient';

/**
 * `/money/budgets` — §4.9, and `docs/money.md` §6.
 *
 * ## A budget owns no spending
 *
 * There is no `spent` column anywhere in this pillar. What was spent is summed
 * from `money_transaction` on every read, and the query cost is trivial against
 * a personal ledger. §9.3(4)'s argument, the same one that stops a goal owning
 * its progress: the moment a stored total exists it is a cache, the first
 * recategorisation puts it out of step with the rows it claims to summarise,
 * and nothing in the system would ever notice.
 *
 * ## A `null` ratio prints its reason and never 0%
 *
 * This is the rule the whole page is arranged around. "No transactions in this
 * period" is not the same fact as "nothing was spent", and after a missed
 * import the second one is false. A progress bar at zero is not the absence of
 * a claim — it is a specific claim, it is reassuring, and on a budget page the
 * reassuring wrong number is the dangerous one. §10.9 asks for *insufficient
 * data* rather than a guess, so each `null` here is rendered as the sentence
 * that explains which of the three reasons produced it.
 *
 * ## Period-to-date, anchored to the calendar
 *
 * A monthly budget is compared against what the calendar month has cost so far,
 * because that is what "monthly" means to the person who set it. A rolling
 * thirty days would be a defensible figure that never matches a statement, and
 * a figure nobody can reconcile is a figure nobody believes.
 *
 * ## No total across budgets, and no score
 *
 * Nothing here adds the budgets together or renders "how you are doing" as one
 * number. Weights would have to be invented and §10.0 forbids the system
 * asserting what it cannot support; being over on `eating_out` and under on
 * `transport` is two facts, not a net one.
 */
export function BudgetsScreen({ board }: { readonly board: BudgetsBoard }): ReactNode {
  const router = useRouter();

  const refresh = (): void => {
    router.refresh();
  };

  const active = board.budgets.filter((budget) => budget.isActive);
  const inactive = board.budgets.filter((budget) => !budget.isActive);

  return (
    <Stack gap="6">
      <SaveBudget board={board} onSaved={refresh} />

      <Inline gap="6" wrap>
        <Figure label="In force today" value={String(board.activeCount)} />
        <Figure label="Recorded" value={String(board.budgets.length)} />
      </Inline>

      {board.budgets.length === 0 ? (
        <EmptyState
          title="No budgets yet"
          description="A budget is a category, a period and a number. It holds no spending of its own — that is summed from transactions every time this page is opened."
        />
      ) : (
        <Stack gap="2">
          {active.map((budget) => (
            <BudgetCard key={budget.id} budget={budget} />
          ))}
        </Stack>
      )}

      {inactive.length > 0 && (
        <Stack gap="2">
          <Text role="title-3" as="h2">
            Not in force today
          </Text>
          <Text role="caption" tone="tertiary">
            Either they start later or they have ended. Kept, because a budget that ended is how you
            find out what last year's allowance was.
          </Text>
          {inactive.map((budget) => (
            <BudgetCard key={budget.id} budget={budget} />
          ))}
        </Stack>
      )}
    </Stack>
  );
}

function BudgetCard({ budget }: { readonly budget: BudgetRow }): ReactNode {
  const percent = budget.ratio === null ? null : Math.round(budget.ratio * 100);

  return (
    <Card variant="outlined">
      <CardBody>
        <Stack gap="2">
          <Inline gap="3" align="center" justify="between">
            <Stack gap="1">
              <Text role="body" as="span">
                {budget.categoryLabel}
              </Text>
              <Text role="caption" tone="tertiary">
                {budget.periodLabel} · {budget.amount} · from {budget.effectiveFrom}
                {budget.effectiveTo === null ? '' : ` to ${budget.effectiveTo}`}
              </Text>
            </Stack>
            {/*
              Over budget is a fact about two numbers, not a judgement about the
              operator, so it is a caution badge and nothing more. Nothing on
              this page tells anyone what to do about it (P5).
            */}
            {percent !== null && percent > 100 ? (
              <Badge tone="caution">{String(percent)}% of the allowance</Badge>
            ) : percent !== null ? (
              <Badge tone="neutral">{String(percent)}% of the allowance</Badge>
            ) : (
              <Badge tone="neutral">No ratio</Badge>
            )}
          </Inline>

          <Inline gap="6" wrap>
            <Figure label="Spent" value={budget.spent ?? 'Not enough to say'} />
            <Figure label="Remaining" value={budget.remaining ?? 'Not enough to say'} />
            <Figure label="Transactions" value={String(budget.transactions)} />
          </Inline>

          <Text role="caption" tone="tertiary">
            Summed over {budget.periodFromDayKey} to {budget.periodToDayKey}.
          </Text>

          {/*
            The `null` sentence. Three different situations produce a missing
            ratio and they mean different things, so the screen says which —
            printing "0%" for any of them would be a claim the record cannot
            support (§10.9).
          */}
          {budget.ratio === null && (
            <Text role="body-sm" tone="secondary">
              {explainMissingRatio(budget)}
            </Text>
          )}

          {budget.note !== null && (
            <Text role="body-sm" tone="secondary">
              {budget.note}
            </Text>
          )}
        </Stack>
      </CardBody>
    </Card>
  );
}

function explainMissingRatio(budget: BudgetRow): string {
  if (budget.spent === null && budget.transactions === 0) {
    return 'No transactions in this period, which is not the same as nothing spent — the likelier explanation is a statement that has not been imported yet. Reported as unknown rather than as a full allowance remaining.';
  }
  if (budget.spent === null) {
    return `${String(budget.transactions)} ${budget.transactions === 1 ? 'transaction' : 'transactions'} landed in this category in another currency. There are no exchange rates in this system, so they cannot be set against an allowance in ${budget.currency}, and the count is reported instead of an invented total.`;
  }
  return 'The allowance is zero, so there is no proportion to compute. Division by it would be an infinity, and an infinity renders as a percentage on a page.';
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

/* ======================================================================
 * Setting a budget
 * ====================================================================== */

/** What the wire accepts: a decimal string in major units, never a `number`. */
const AMOUNT_PATTERN = /^\d+(\.\d+)?$/u;

/*
 * `income` and `transfer` are not spending, so they cannot be budgeted.
 * `transfer` is the dangerous one: money moved between the operator's own
 * accounts appears twice in an import, and a budget against it would be an
 * allowance for moving your own money.
 */
const BUDGETABLE: readonly SpendCategory[] = SPEND_CATEGORIES.filter(
  (category) => !NON_SPEND_CATEGORIES.includes(category),
);

function SaveBudget({
  board,
  onSaved,
}: {
  readonly board: BudgetsBoard;
  readonly onSaved: () => void;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<SpendCategory>('groceries');
  const [period, setPeriod] = useState<BudgetPeriod>('monthly');
  const [amount, setAmount] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(`${board.todayDayKey.slice(0, 7)}-01`);
  const [effectiveTo, setEffectiveTo] = useState('');
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      await saveBudget({
        id: uuidV7(systemClock.nowMillis()),
        category,
        period,
        amount: amount.trim(),
        currency: board.currency,
        effectiveFrom,
        /* An open-ended budget is the normal one. An end date is for the
         * allowance that was deliberately temporary. */
        effectiveTo: effectiveTo === '' ? null : effectiveTo,
        note: note.trim() === '' ? null : note.trim(),
      });
    },
    onSuccess: () => {
      setOpen(false);
      setAmount('');
      setEffectiveTo('');
      setNote('');
      setProblem(null);
      onSaved();
    },
    onError: (error: unknown) => {
      setProblem(error instanceof Error ? error.message : 'Could not save that budget.');
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
          Set a budget
        </Button>
      </Inline>
    );
  }

  return (
    <Card variant="raised">
      <CardBody>
        <Stack gap="3">
          <Inline gap="2" wrap>
            {BUDGETABLE.map((option) => (
              <Button
                key={option}
                size="sm"
                variant={option === category ? 'primary' : 'secondary'}
                aria-pressed={option === category}
                onClick={() => {
                  setCategory(option);
                }}
              >
                {SPEND_CATEGORY_LABELS[option]}
              </Button>
            ))}
          </Inline>

          <Inline gap="2" wrap>
            {BUDGET_PERIODS.map((option) => (
              <Button
                key={option}
                size="sm"
                variant={option === period ? 'primary' : 'secondary'}
                aria-pressed={option === period}
                onClick={() => {
                  setPeriod(option);
                }}
              >
                {BUDGET_PERIOD_LABELS[option]}
              </Button>
            ))}
          </Inline>

          <TextField
            label={`Allowance in ${board.currency}`}
            hint="A decimal, as written: 8000.00. Sent as a string — a float is not money (§5.3)."
            inputMode="decimal"
            value={amount}
            onChange={(event) => {
              setAmount(event.target.value);
            }}
          />

          <DateField
            label="In force from"
            hint="Backdate it and this period's spending is measured from that day, not from today."
            value={effectiveFrom}
            onValueChange={setEffectiveFrom}
          />

          <DateField
            label="Until"
            hint="Leave empty for an open-ended budget, which is the usual case."
            value={effectiveTo}
            onValueChange={setEffectiveTo}
          />

          <TextField
            label="Note"
            value={note}
            onChange={(event) => {
              setNote(event.target.value);
            }}
          />

          <Text role="caption" tone="tertiary">
            One live budget per category and period. Setting a second for the same pair is a
            contradiction rather than an addition, and the schema refuses it.
          </Text>

          {problem !== null && (
            <Text role="body-sm" tone="critical">
              {problem}
            </Text>
          )}

          <Inline gap="2">
            <Button
              variant="primary"
              disabled={!AMOUNT_PATTERN.test(amount.trim()) || effectiveFrom === '' || save.isPending}
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
