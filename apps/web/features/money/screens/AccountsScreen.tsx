'use client';

import { useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { uuidV7 } from '@naitikos/shared';
import { ACCOUNT_KINDS, ACCOUNT_KIND_LABELS, systemClock } from '@naitikos/core';
import type { AccountKind } from '@naitikos/core';
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
  ToggleField,
} from '@naitikos/design-system';

import type { AccountRow, AccountsBoard } from '@/lib/platform/money';
import { recordBalance, saveAccount } from '../services/moneyClient';

/**
 * `/money/accounts` — §4.9, and `docs/money.md` §4 and §5.
 *
 * ## A liability's balance is labelled as owed, in words, on every row
 *
 * `is_liability` is stored on the account rather than derived from its kind,
 * and the schema states the reason in the strongest terms it has: a credit card
 * with ₹40,000 on it is −₹40,000 of net worth, and a sum that added it instead
 * of subtracting it is wrong by ₹80,000 — twice the balance, in the flattering
 * direction, which is exactly the kind of error nobody notices.
 *
 * The screen carries that decision visibly. A liability's figure never appears
 * bare: it reads "₹40,000 owed", the badge says the same thing, and the form
 * that creates an account asks the question in a sentence rather than offering
 * a checkbox labelled with a column name. This page is the only place the
 * operator will ever be asked to get the sign right, and every net-worth figure
 * in the system inherits their answer.
 *
 * `kind` does not decide it, either here or in `core`. A wallet holding a
 * prepaid balance and a wallet representing a credit line are the same kind and
 * opposite signs.
 *
 * ## The age of a reading is part of the reading
 *
 * Balances are observed, never computed (`docs/money.md` §4). A running total
 * rolled forward from imported transactions is wrong from the first missing
 * statement and then stays wrong silently, compounding into every later figure;
 * a number read off the account is a fact with a date on it. The price of that
 * choice is staleness, so staleness is stated: past the threshold the row
 * carries a caution badge, and the threshold itself is printed rather than
 * implied, because a page that flags something owes the reader the rule.
 *
 * An account nobody has ever read is **not** stale — it is unread, counted
 * separately, and described differently. Conflating the two would put a
 * brand-new account on the "nobody has looked at this" list the day it is made.
 *
 * ## No conversion, and no cross-currency total
 *
 * There are no exchange rates in this system. Each account is listed in its own
 * currency and this page sums nothing at all — the only total that exists is on
 * `/money/networth`, in one currency, with what it excluded named.
 */
export function AccountsScreen({ board }: { readonly board: AccountsBoard }): ReactNode {
  const router = useRouter();

  const refresh = (): void => {
    router.refresh();
  };

  const open = board.accounts.filter((account) => account.closedOn === null);
  const closed = board.accounts.filter((account) => account.closedOn !== null);

  return (
    <Stack gap="6">
      <RecordBalance board={board} onSaved={refresh} />
      <AddAccount onSaved={refresh} />

      <Inline gap="6" wrap>
        <Figure label="Accounts" value={String(open.length)} />
        <Figure
          label={`Read more than ${String(board.staleThresholdDays)} days ago`}
          value={String(board.staleCount)}
        />
        <Figure label="Never read" value={String(board.unreadCount)} />
      </Inline>
      <Text role="caption" tone="tertiary">
        Stale means the last reading is older than {String(board.staleThresholdDays)} days — long
        enough that a monthly statement cycle plus a missed weekend does not trip it, short enough
        that an account nobody opened last quarter does.
      </Text>

      {board.accounts.length === 0 ? (
        <EmptyState
          title="No accounts yet"
          description="An account is a name and a currency. No number, no IBAN, no card — this record tells accounts apart, it does not address payments to them."
        />
      ) : (
        <Stack gap="2">
          {open.map((account) => (
            <AccountCard key={account.id} account={account} threshold={board.staleThresholdDays} />
          ))}
        </Stack>
      )}

      {closed.length > 0 && (
        <Stack gap="2">
          <Text role="title-3" as="h2">
            Closed
          </Text>
          {/* Kept rather than removed. A settled loan is history worth having,
              and `netWorthOn` already stops counting it on the day it closed. */}
          <Text role="caption" tone="tertiary">
            Closed accounts hold nothing after the day they closed and contribute nothing to net
            worth. They stay here because the history did happen.
          </Text>
          {closed.map((account) => (
            <AccountCard key={account.id} account={account} threshold={board.staleThresholdDays} />
          ))}
        </Stack>
      )}
    </Stack>
  );
}

function AccountCard({
  account,
  threshold,
}: {
  readonly account: AccountRow;
  readonly threshold: number;
}): ReactNode {
  return (
    <Card variant="outlined">
      <CardBody>
        <Stack gap="2">
          <Inline gap="3" align="center" justify="between">
            <Stack gap="1">
              <Text role="body" as="span">
                {account.name}
              </Text>
              <Text role="caption" tone="tertiary">
                {account.kindLabel}
                {account.institution === null ? '' : ` · ${account.institution}`} · {account.currency}
                {account.openedOn === null ? '' : ` · opened ${account.openedOn}`}
                {account.closedOn === null ? '' : ` · closed ${account.closedOn}`}
              </Text>
            </Stack>
            <Inline gap="2">
              {/*
                The sign convention, said out loud on every liability row. It is
                the one thing on this page a reader could get backwards, and the
                figure alone cannot tell them.
              */}
              <Badge tone={account.isLiability ? 'caution' : 'neutral'}>
                {account.isLiability ? 'Owed' : 'Held'}
              </Badge>
              {account.isStale && <Badge tone="caution">Stale reading</Badge>}
            </Inline>
          </Inline>

          <Stack gap="1">
            <Text role="metric-m" as="span">
              {/* Never a dash and never a zero: an account with no reading has
                  no balance, which is a different fact from an empty one. */}
              {account.balance === null
                ? 'No reading yet'
                : account.isLiability
                  ? `${account.balance} owed`
                  : account.balance}
            </Text>
            <Text role="caption" tone="tertiary">
              {describeReading(account, threshold)}
            </Text>
          </Stack>

          {account.note !== null && (
            <Text role="body-sm" tone="secondary">
              {account.note}
            </Text>
          )}
        </Stack>
      </CardBody>
    </Card>
  );
}

function describeReading(account: AccountRow, threshold: number): string {
  if (account.asOfDayKey === null || account.ageDays === null) {
    return 'Nobody has read a balance off this account. It contributes nothing to net worth until somebody does.';
  }
  const age =
    account.ageDays === 0
      ? 'read today'
      : account.ageDays === 1
        ? 'read yesterday'
        : `read ${String(account.ageDays)} days ago`;
  const suffix = account.isStale
    ? ` — past ${String(threshold)} days, so every figure built on it is that old too`
    : '';
  return `As at ${account.asOfDayKey}, ${age}${suffix}.`;
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

/** What the wire accepts: a decimal string in major units, never a `number`. */
const AMOUNT_PATTERN = /^-?\d+(\.\d+)?$/u;

/* ======================================================================
 * Recording a balance
 * ====================================================================== */

function RecordBalance({
  board,
  onSaved,
}: {
  readonly board: AccountsBoard;
  readonly onSaved: () => void;
}): ReactNode {
  const [accountId, setAccountId] = useState<string | null>(null);
  const [asOfDay, setAsOfDay] = useState(board.todayDayKey);
  const [amount, setAmount] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const selected = board.accounts.find((account) => account.id === accountId) ?? null;

  const save = useMutation({
    mutationFn: async (target: AccountRow) => {
      await recordBalance({
        accountId: target.id,
        /* The day it was **read**, which is not always today. A statement
         * opened on Monday for Friday's closing balance is a Friday reading,
         * and filing it under Monday would date every figure built on it. */
        asOfDayKey: asOfDay,
        amount: amount.trim(),
        /* The account's own currency. A reading in something else is a
         * different account's balance, not a conversion this system can make. */
        currency: target.currency,
      });
    },
    onSuccess: () => {
      setAmount('');
      setProblem(null);
      onSaved();
    },
    onError: (error: unknown) => {
      setProblem(error instanceof Error ? error.message : 'Could not record that balance.');
    },
  });

  if (board.accounts.length === 0) return null;

  const usable = selected !== null && AMOUNT_PATTERN.test(amount.trim());

  return (
    <Card variant="raised">
      <CardBody>
        <Stack gap="3">
          <Text role="title-3" as="h2">
            Record a balance
          </Text>
          <Text role="caption" tone="tertiary">
            A number read off the account, not one this system worked out. Nothing here rolls
            transactions forward into a balance, and there is no wire kind that asks it to.
          </Text>

          <Inline gap="2" wrap>
            {board.accounts
              .filter((account) => account.closedOn === null)
              .map((account) => (
                <Button
                  key={account.id}
                  size="sm"
                  variant={account.id === accountId ? 'primary' : 'secondary'}
                  aria-pressed={account.id === accountId}
                  onClick={() => {
                    setAccountId(account.id === accountId ? null : account.id);
                  }}
                >
                  {account.name}
                </Button>
              ))}
          </Inline>

          <DateField
            label="The day it was read"
            hint="One reading per account per day. Re-recording the same day replaces it."
            value={asOfDay}
            max={board.todayDayKey}
            onValueChange={setAsOfDay}
          />

          <TextField
            label={selected === null ? 'Balance' : `Balance in ${selected.currency}`}
            hint={
              selected?.isLiability === true
                ? 'This is a liability. Enter what is owed as a positive number, exactly as the statement prints it — the account carries the sign, not the figure.'
                : 'A decimal, as written: 1250.00. Not a number field — a float is not money (§5.3).'
            }
            inputMode="decimal"
            value={amount}
            onChange={(event) => {
              setAmount(event.target.value);
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
              disabled={!usable || save.isPending}
              onClick={() => {
                if (selected === null) return;
                save.mutate(selected);
              }}
            >
              Record it
            </Button>
          </Inline>
        </Stack>
      </CardBody>
    </Card>
  );
}

/* ======================================================================
 * Adding an account
 * ====================================================================== */

function AddAccount({ onSaved }: { readonly onSaved: () => void }): ReactNode {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<AccountKind>('savings');
  const [institution, setInstitution] = useState('');
  const [currency, setCurrency] = useState('INR');
  const [isLiability, setIsLiability] = useState(false);
  const [openedOn, setOpenedOn] = useState('');
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      await saveAccount({
        id: uuidV7(systemClock.nowMillis()),
        name: name.trim(),
        kind,
        institution: institution.trim() === '' ? null : institution.trim(),
        currency: currency.trim().toUpperCase(),
        isLiability,
        openedOn: openedOn === '' ? null : openedOn,
        note: note.trim() === '' ? null : note.trim(),
      });
    },
    onSuccess: () => {
      setOpen(false);
      setName('');
      setInstitution('');
      setIsLiability(false);
      setOpenedOn('');
      setNote('');
      setProblem(null);
      onSaved();
    },
    onError: (error: unknown) => {
      setProblem(error instanceof Error ? error.message : 'Could not save that account.');
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
          New account
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
            hint="What you call it. There is no account number field here, on purpose — a record that cannot move money is a record whose loss is survivable."
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />

          <Inline gap="2" wrap>
            {ACCOUNT_KINDS.map((option) => (
              <Button
                key={option}
                size="sm"
                variant={option === kind ? 'primary' : 'secondary'}
                aria-pressed={option === kind}
                onClick={() => {
                  setKind(option);
                }}
              >
                {ACCOUNT_KIND_LABELS[option]}
              </Button>
            ))}
          </Inline>

          <TextField
            label="Institution"
            value={institution}
            onChange={(event) => {
              setInstitution(event.target.value);
            }}
          />

          <TextField
            label="Currency"
            hint="Three letters, ISO-4217. Nothing in this system converts between two of them."
            value={currency}
            maxLength={3}
            onChange={(event) => {
              setCurrency(event.target.value.toUpperCase());
            }}
          />

          {/*
            Asked as a question about money rather than as a column name. The
            answer is arithmetic: `netWorthOn` reads this flag and nothing else,
            so getting it wrong is wrong by twice the balance, forever, quietly.
          */}
          <ToggleField
            label="A positive balance here means money owed"
            description="On for a credit card, a loan, or a credit line. Off for anything you hold. The kind does not decide this — a wallet can be either."
            checked={isLiability}
            onCheckedChange={setIsLiability}
          />

          <DateField label="Opened" value={openedOn} onValueChange={setOpenedOn} />

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
              disabled={name.trim() === '' || currency.trim().length !== 3 || save.isPending}
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
