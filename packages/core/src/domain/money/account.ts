/**
 * Accounts, balances, and net worth — §4.9.
 *
 * §3.2 asks for "net worth over time", and this file is the arithmetic behind
 * that sentence. Almost all of it is spent on the two ways a net-worth figure
 * goes wrong without complaining.
 *
 * ## The sign is decided by the account, never by the balance
 *
 * `is_liability` is a stored flag on the account, and the schema comment says
 * why in the strongest terms available: "A credit card with ₹40,000 on it is
 * −₹40,000 of net worth, and a net worth that silently added it instead would
 * be wrong by twice the balance." So {@link netWorthOn} reads the flag and
 * nothing else. Not the sign of the amount — a card balance is recorded as the
 * positive sum owed, exactly as the statement prints it. Not the account kind
 * either: `kind` is a label for grouping, and a loan account someone recorded
 * as `other` would silently flip from a debt into an asset if the kind decided.
 *
 * ## A number built from a stale reading is not a fact
 *
 * Balances are observed, never derived (the schema is explicit about that), and
 * an observation has an age. A net worth assembled from a six-month-old savings
 * balance is arithmetically correct and materially false, and the operator has
 * no way to tell from the figure alone. So {@link NetWorth} carries
 * `accountsStale` beside the total, and the page that renders one is expected
 * to render the other. That is the same instinct §10.0 applies to model output:
 * a figure travels with what is known about its reliability.
 *
 * ## Currencies are excluded, never converted
 *
 * There are no exchange rates here (see `amount.ts`). An account denominated in
 * something other than the requested currency is left out of the sums and
 * counted in `accountsExcluded`, so a net worth that omits a third of the
 * holdings says so rather than quietly understating itself.
 */

import type { Result } from '@naitikos/shared';
import { err, ok } from '@naitikos/shared';

import type { DomainError } from '../../errors/domain-error';
import { validationError } from '../../errors/domain-error';
import { dayKeyIndex } from '../../temporal/instant';
import type { Money } from './amount';

/** Mirrors the `account_kind` pgEnum exactly. */
export const ACCOUNT_KINDS = Object.freeze([
  'current',
  'savings',
  'credit_card',
  'investment',
  'loan',
  'cash',
  'wallet',
  'other',
] as const);

export type AccountKind = (typeof ACCOUNT_KINDS)[number];

export const ACCOUNT_KIND_LABELS: Readonly<Record<AccountKind, string>> = Object.freeze({
  current: 'Current',
  savings: 'Savings',
  credit_card: 'Credit card',
  investment: 'Investment',
  loan: 'Loan',
  cash: 'Cash',
  wallet: 'Wallet',
  other: 'Other',
});

export function isAccountKind(value: string): value is AccountKind {
  return (ACCOUNT_KINDS as readonly string[]).includes(value);
}

/**
 * An account, as the record knows it.
 *
 * No account number, no IBAN, no card PAN — the schema explains that omission
 * at length, and the type mirrors it so nothing can be carried here that the
 * table refuses to store.
 */
export type FinancialAccount = {
  readonly id: string;
  readonly name: string;
  readonly kind: AccountKind;
  readonly institution: string | null;
  readonly currency: string;
  /** Whether a positive balance is money owed rather than money held. */
  readonly isLiability: boolean;
  readonly openedOn: string | null;
  readonly closedOn: string | null;
  readonly note: string | null;
};

/** A balance reading. One per account per day; observed, never computed. */
export type AccountBalance = {
  readonly id: string;
  readonly accountId: string;
  readonly asOfDayKey: string;
  readonly amountMinor: bigint;
  readonly currency: string;
};

export type AccountInput = {
  readonly id: string;
  readonly name: string;
  readonly kind: AccountKind;
  readonly institution?: string | null;
  readonly currency: string;
  readonly isLiability?: boolean;
  readonly openedOn?: string | null;
  readonly closedOn?: string | null;
  readonly note?: string | null;
};

const CURRENCY_PATTERN = /^[A-Za-z]{3}$/u;

export function validateAccount(input: AccountInput): Result<AccountInput, DomainError> {
  if (input.name.trim() === '') {
    return err(validationError('account_name_empty', 'An account needs a name.'));
  }
  if (!isAccountKind(input.kind)) {
    return err(validationError('account_kind_unknown', `Unknown account kind: ${input.kind}.`));
  }
  if (!CURRENCY_PATTERN.test(input.currency.trim())) {
    return err(
      validationError('account_currency_invalid', 'An account needs a three-letter ISO-4217 currency.'),
    );
  }

  const opened = input.openedOn ?? null;
  const closed = input.closedOn ?? null;
  if (opened !== null && dayKeyIndex(opened) === null) {
    return err(validationError('account_opened_invalid', 'openedOn must be a YYYY-MM-DD day key.'));
  }
  if (closed !== null && dayKeyIndex(closed) === null) {
    return err(validationError('account_closed_invalid', 'closedOn must be a YYYY-MM-DD day key.'));
  }
  /* Mirrors `financial_account_dates_ordered`. Checked here as well as in the
   * database so a form can say which field is wrong, rather than surfacing a
   * constraint name to the operator. */
  if (opened !== null && closed !== null && opened > closed) {
    return err(
      validationError('account_dates_disordered', 'An account cannot close before it opened.'),
    );
  }

  return ok(input);
}

/* -------------------------------------------------------------------------
 * Net worth
 * ---------------------------------------------------------------------- */

/**
 * How old a balance may be before the figure it feeds is flagged.
 *
 * Six weeks. Long enough that a monthly statement cycle plus a missed weekend
 * does not raise a flag on an account that is being maintained; short enough
 * that an account nobody has read since the last quarter does. The number is a
 * judgement rather than a standard, which is why it is named and exported —
 * a page that shows a stale count should be able to say what stale means.
 */
export const STALE_BALANCE_DAYS = 45;

export type NetWorth = {
  readonly asOfDayKey: string;
  /** Total of the non-liability accounts, or `null` when none could be read. */
  readonly assets: Money | null;
  /** Total owed across the liability accounts, as a positive magnitude. */
  readonly liabilities: Money | null;
  /** `assets − liabilities`. */
  readonly net: Money | null;
  /** Accounts that contributed a reading. */
  readonly accountsCounted: number;
  /** Of those, how many were last read more than {@link STALE_BALANCE_DAYS} ago. */
  readonly accountsStale: number;
  /**
   * Accounts left out because they are denominated in another currency.
   *
   * Reported rather than silently dropped. A net worth missing the dollar
   * account is not wrong arithmetic, it is an incomplete answer, and the only
   * thing that distinguishes the two for a reader is this count.
   */
  readonly accountsExcluded: number;
  /** The currency everything above is denominated in, or `null` when nothing was counted. */
  readonly currency: string | null;
};

/**
 * Net worth on a day, in one currency.
 *
 * Uses **the most recent balance at or before `dayKey`** for each account. Not
 * the balance on that exact day — readings are irregular by nature, and
 * requiring an exact match would make net worth undefined on every day the
 * operator did not open their banking app.
 *
 * Everything is `null` when nothing can be said. A zero would be a claim that
 * the accounts were empty, which is a different statement from "no reading
 * exists", and the difference is the whole point (§10.0's rule that the system
 * does not fill in what it does not know).
 */
export function netWorthOn(
  accounts: readonly FinancialAccount[],
  balances: readonly AccountBalance[],
  dayKey: string,
  currency: string,
): NetWorth {
  const target = currency.trim().toUpperCase();

  /*
   * Latest reading per account, at or before the day.
   *
   * Day keys are ISO `YYYY-MM-DD`, so a string comparison is a chronological
   * one — no parsing, and no timezone anywhere near a comparison that has no
   * business being zoned.
   */
  const latest = new Map<string, AccountBalance>();
  for (const balance of balances) {
    if (balance.asOfDayKey > dayKey) continue;
    const held = latest.get(balance.accountId);
    if (held === undefined || balance.asOfDayKey > held.asOfDayKey) {
      latest.set(balance.accountId, balance);
    }
  }

  const asOf = dayKeyIndex(dayKey);
  let assets = 0n;
  let liabilities = 0n;
  let assetsSeen = false;
  let liabilitiesSeen = false;
  let counted = 0;
  let stale = 0;
  let excluded = 0;

  for (const account of accounts) {
    /*
     * A closed account holds nothing after the day it closed, and its final
     * balance is history rather than a holding. Counting it would leave a
     * settled loan subtracting from net worth for as long as the record lasts.
     */
    if (account.closedOn !== null && account.closedOn <= dayKey) continue;
    /* An account opened after the day did not exist on it. */
    if (account.openedOn !== null && account.openedOn > dayKey) continue;

    if (account.currency.trim().toUpperCase() !== target) {
      excluded += 1;
      continue;
    }

    const balance = latest.get(account.id);
    /* No reading at or before the day: nothing to add and nothing to claim.
     * Not counted, and not stale either — an account with no reading has no
     * reading, which is a different thing from an old one. */
    if (balance === undefined) continue;

    if (balance.currency.trim().toUpperCase() !== target) {
      /* The account says one currency and its reading says another. Trust the
       * reading, since that is the value that would be summed, and exclude it. */
      excluded += 1;
      continue;
    }

    counted += 1;
    if (account.isLiability) {
      liabilities += balance.amountMinor;
      liabilitiesSeen = true;
    } else {
      assets += balance.amountMinor;
      assetsSeen = true;
    }

    const read = dayKeyIndex(balance.asOfDayKey);
    if (asOf !== null && read !== null && asOf - read > STALE_BALANCE_DAYS) stale += 1;
  }

  if (counted === 0) {
    return {
      asOfDayKey: dayKey,
      assets: null,
      liabilities: null,
      net: null,
      accountsCounted: 0,
      accountsStale: 0,
      accountsExcluded: excluded,
      currency: null,
    };
  }

  /*
   * Summed as bigints directly rather than through `sumAmounts`.
   *
   * Every contributing balance was filtered to `target` above, so the currency
   * mismatch `sumAmounts` guards against is unreachable here — and a `Result`
   * that cannot fail is an error branch with no honest handling, which would
   * end up as a discarded `ok` or a thrown exception. The filter is the
   * guarantee; this is the arithmetic.
   */
  const assetTotal: Money | null = assetsSeen ? { amountMinor: assets, currency: target } : null;
  const liabilityTotal: Money | null = liabilitiesSeen
    ? { amountMinor: liabilities, currency: target }
    : null;

  /* The flag decides the operation, the balance supplies the magnitude. */
  const net: Money = { amountMinor: assets - liabilities, currency: target };

  return {
    asOfDayKey: dayKey,
    assets: assetTotal,
    liabilities: liabilityTotal,
    net,
    accountsCounted: counted,
    accountsStale: stale,
    accountsExcluded: excluded,
    currency: target,
  };
}
