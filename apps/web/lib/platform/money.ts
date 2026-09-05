/**
 * The Money service — §4.9, assembled.
 *
 * §4.9 justifies this pillar by the joins it makes possible rather than by the
 * ledger it keeps: "supplement and skincare spend against outcomes, food spend
 * against nutrition quality". So every board here is a plain statement of what
 * the record holds — where it went, what is committed, what is owned, what is
 * owed — and nothing on any of them is a score, a projection, or a claim about
 * a cause.
 *
 * ## Every board carries display strings, never a `bigint` and never a `Money`
 *
 * This is the one sentence to read before adding a field. Amounts are `bigint`
 * minor units from Postgres through `core` (§5.3), and **a `bigint` cannot be
 * serialised from a Server Component into a Client Component.** Neither can it
 * be handed to `JSON.stringify`: `JSON.stringify({ n: 1n })` throws. Every
 * board below is rendered by a Client Component, so every figure on one is a
 * string produced by `formatAmount`, and every other field is a plain `number`,
 * `string` or `boolean`.
 *
 * The failure this prevents is not a type error. It is a runtime serialisation
 * complaint in the browser, arriving from a page that compiled cleanly, on the
 * day somebody adds one convenient raw `amountMinor` to a row type.
 * `docs/money.md` §8 has the full argument; this comment is here because this
 * file is where the mistake gets made.
 *
 * ## No exchange rates, anywhere
 *
 * There is no rate table, no rate provider and no conversion function in this
 * system (`amount.ts`, `docs/money.md` §10). An account or a transaction
 * denominated in something other than a board's currency is **excluded from the
 * sums and counted**, never converted — a converted total is a wrong number
 * that looks right, which is the worst thing a money module can produce. Boards
 * that can exclude something carry `excludedCurrencies` so the page can say
 * which currencies were left out rather than quietly understating itself.
 *
 * ## Nothing here reports a zero it cannot support
 *
 * A figure with no readings behind it is `null`, and the screen renders a stated
 * reason. "₹0.00 spent" and "no statement imported yet" are different facts and
 * only one of them is true after a missed import — §10.0's rule that the system
 * does not fill in what it does not know, applied to the numbers an operator
 * would actually act on.
 */

import 'server-only';

import type { Result } from '@naitikos/shared';
import { ok } from '@naitikos/shared';
import type {
  AccountBalance,
  AccountKind,
  Budget,
  BudgetPeriod,
  DomainError,
  Money,
  SpendCategory,
} from '@naitikos/core';
import {
  ACCOUNT_KIND_LABELS,
  BUDGET_PERIOD_LABELS,
  SPEND_CATEGORY_LABELS,
  STALE_BALANCE_DAYS,
  budgetStanding,
  dayKeyInZone,
  dayKeyIndex,
  formatAmount,
  isBudgetActive,
  isOutflow,
  isoFromMillis,
  isoWeekday,
  minorUnitsFor,
  netWorthOn,
  shiftDayKey,
  spendByCategory,
  sumAmounts,
  systemClock,
  utcNoonOn,
  windowDayKeys,
} from '@naitikos/core';
import type { Database, ShoppingItem, Subscription } from '@naitikos/db';
import { createMoneyRepository } from '@naitikos/db';

/**
 * How much transaction history the transactions board carries by default.
 *
 * Ninety days — a quarter, which is three statement cycles: long enough that a
 * re-import overlapping last month is visible on the same screen as the rows it
 * skipped, and short enough that the page is a review rather than an archive.
 */
export const MONEY_WINDOW_DAYS = 90;

/**
 * How far back the net-worth series reaches.
 *
 * A year. §3.2 asks for "net worth over time", and a window shorter than a year
 * cannot show the thing that makes the question worth asking — a bonus, a large
 * purchase, a loan being paid down are annual-scale events.
 */
export const NET_WORTH_WINDOW_DAYS = 365;

/**
 * The currency every board is denominated in.
 *
 * A **setting**, not a finding. Nothing in the record determines it: the system
 * holds no exchange rates, so a board has to be denominated in exactly one
 * currency and something has to say which. It is named and exported so a page
 * can print it, and so the day it needs to come from a profile there is one
 * place to change.
 */
export const DEFAULT_CURRENCY = 'INR';

/** The categorical palette has eight slots (§8.9). Fixed per entity, per chart. */
export type ChartSlot = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

const CHART_SLOTS: readonly ChartSlot[] = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8] as const);

/** A shopping item's status, taken from the row type so it cannot drift from the enum. */
export type ShoppingStatusValue = ShoppingItem['status'];

/** A subscription's cadence, likewise. */
export type SubscriptionCadenceValue = Subscription['cadence'];

/* =========================================================================
 * Shared helpers
 * ====================================================================== */

/** Codes are compared upper-cased, so 'inr' and 'INR' are one currency. */
function normalise(currency: string): string {
  return currency.trim().toUpperCase();
}

/**
 * The distinct currencies in a set that are **not** the board's, sorted.
 *
 * The counterpart to the no-conversion rule: a board that silently dropped a
 * dollar account would be understating itself with no way for a reader to tell.
 * This is the list that lets the page say so.
 */
function excludedCurrencies(codes: readonly string[], target: string): readonly string[] {
  const out = new Set<string>();
  for (const code of codes) {
    const upper = normalise(code);
    if (upper !== target) out.add(upper);
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

/**
 * An amount as a plain `number` in **major** units.
 *
 * The only place in this file where a monetary value becomes a `number`, and it
 * exists for chart geometry alone — a bar length and a line's y-position are
 * pixels, and a pixel has no exactness to lose. Nothing downstream turns one of
 * these back into money: every figure a reader sees comes from `formatAmount`
 * on the `bigint`, which is why each chart-bearing row carries both.
 */
function majorUnits(money: Money): number {
  return Number(money.amountMinor) / 10 ** minorUnitsFor(money.currency);
}

/** Whole days between two day keys, or `null` when either is not a day key. */
function daysBetween(fromDayKey: string, toDayKey: string): number | null {
  const from = dayKeyIndex(fromDayKey);
  const to = dayKeyIndex(toDayKey);
  return from === null || to === null ? null : to - from;
}

/** The latest reading per account, at or before the day the balances were read for. */
function latestBalances(balances: readonly AccountBalance[]): ReadonlyMap<string, AccountBalance> {
  const latest = new Map<string, AccountBalance>();
  for (const balance of balances) {
    const held = latest.get(balance.accountId);
    /* Day keys are ISO, so a string comparison is a chronological one. */
    if (held === undefined || balance.asOfDayKey > held.asOfDayKey) {
      latest.set(balance.accountId, balance);
    }
  }
  return latest;
}

/**
 * The first day of the period a budget is currently in.
 *
 * Period-to-date, anchored to the calendar rather than to a rolling window: a
 * monthly budget is compared against what the calendar month has cost so far,
 * which is what "monthly" means to the person who set it. A rolling 30 days
 * would be a different figure that never matches a statement.
 */
function periodStartDayKey(period: BudgetPeriod, dayKey: string): string {
  switch (period) {
    case 'weekly': {
      /* ISO weeks start on Monday. `utcNoonOn` is the sanctioned parse (§11.3);
       * noon keeps the weekday stable regardless of the runtime's zone. */
      const anchor = utcNoonOn(dayKey);
      if (anchor === null) return dayKey;
      return shiftDayKey(dayKey, -(isoWeekday(anchor) - 1)) ?? dayKey;
    }
    case 'monthly':
      return `${dayKey.slice(0, 7)}-01`;
    case 'quarterly': {
      const month = Number(dayKey.slice(5, 7));
      if (!Number.isInteger(month) || month < 1 || month > 12) return `${dayKey.slice(0, 4)}-01-01`;
      const first = month - ((month - 1) % 3);
      return `${dayKey.slice(0, 4)}-${String(first).padStart(2, '0')}-01`;
    }
    default:
      return `${dayKey.slice(0, 4)}-01-01`;
  }
}

/* =========================================================================
 * Overview
 * ====================================================================== */

/** One category's spend, formatted for reading and numbered for a bar. */
export type SpendSlice = {
  readonly category: SpendCategory;
  readonly label: string;
  /** Already formatted — `'₹1250.00'`. Never a `bigint`. */
  readonly spent: string;
  /** Major units, for the bar's length only. See {@link majorUnits}. */
  readonly value: number;
  readonly transactions: number;
  readonly slot: ChartSlot;
};

export type MoneyOverview = {
  readonly todayDayKey: string;
  /** The first of the current calendar month — the window everything below covers. */
  readonly monthStartDayKey: string;
  readonly currency: string;
  readonly spendByCategory: readonly SpendSlice[];
  /** The total of the slices, formatted, or `null` when nothing was categorised. */
  readonly monthSpent: string | null;
  readonly monthTransactions: number;
  /** Transactions in the month with no category. A queue, not a total. */
  readonly uncategorised: number;
  /** The latest net worth, formatted, or `null` when no reading supports one. */
  readonly netWorth: string | null;
  readonly netWorthAsOfDayKey: string | null;
  readonly netWorthAccountsCounted: number;
  readonly netWorthAccountsStale: number;
  readonly activeBudgets: number;
  readonly activeSubscriptions: number;
  readonly openShoppingItems: number;
  readonly excludedCurrencies: readonly string[];
};

export async function loadMoneyOverview(
  db: Database,
  zone: string,
): Promise<Result<MoneyOverview, DomainError>> {
  const money = createMoneyRepository(db);
  const currency = DEFAULT_CURRENCY;

  const nowIso = isoFromMillis(systemClock.nowMillis());
  const todayDayKey = dayKeyInZone(nowIso, zone);
  const monthStartDayKey = `${todayDayKey.slice(0, 7)}-01`;

  const [transactions, accounts, budgets, subscriptions, shopping] = await Promise.all([
    money.transactionsBetween(monthStartDayKey, todayDayKey),
    money.accounts(),
    money.budgets(),
    money.subscriptions(),
    money.shoppingItems(),
  ]);
  if (!transactions.ok) return transactions;
  if (!accounts.ok) return accounts;
  if (!budgets.ok) return budgets;
  if (!subscriptions.ok) return subscriptions;
  if (!shopping.ok) return shopping;

  /* Balances depend on the account ids, so this read cannot join the batch above. */
  const balances = await money.balancesFor(
    accounts.value.map((account) => account.id),
    todayDayKey,
  );
  if (!balances.ok) return balances;

  /* Summed from the transactions on this read, every time. A budget — and an
   * overview — owns no spending (§9.3(4)). */
  const spend = spendByCategory(transactions.value, currency);

  const slices = spend.map((slice, index) => ({
    category: slice.category,
    label: SPEND_CATEGORY_LABELS[slice.category],
    spent: formatAmount(slice.spent),
    value: majorUnits(slice.spent),
    transactions: slice.transactions,
    /*
     * Slots cycle past the eighth. The chart renders the top eight (§8.9's
     * palette holds no more), so a repeated slot can only appear in the list
     * below it, where colour is not the encoding — and no category is dropped
     * from the list, because a total that omits a category is a wrong total.
     */
    slot: CHART_SLOTS[index % CHART_SLOTS.length] ?? 1,
  }));

  /* Every slice was filtered to `currency` by `spendByCategory`, so this total
   * cannot hit the mismatch branch — but the `Result` is honoured rather than
   * discarded, because a filter that changes later must fail loudly. */
  const total = sumAmounts(spend.map((slice) => slice.spent));
  if (!total.ok) return total;

  const netWorth = netWorthOn(accounts.value, balances.value, todayDayKey, currency);

  return ok({
    todayDayKey,
    monthStartDayKey,
    currency,
    spendByCategory: slices,
    monthSpent: total.value === null ? null : formatAmount(total.value),
    monthTransactions: transactions.value.length,
    uncategorised: transactions.value.filter((txn) => txn.category === null).length,
    netWorth: netWorth.net === null ? null : formatAmount(netWorth.net),
    netWorthAsOfDayKey: netWorth.net === null ? null : netWorth.asOfDayKey,
    netWorthAccountsCounted: netWorth.accountsCounted,
    netWorthAccountsStale: netWorth.accountsStale,
    activeBudgets: budgets.value.filter((entry) => isBudgetActive(entry, todayDayKey)).length,
    /* A cancelled subscription is history and stays in the table; it is not a
     * commitment, so it is not counted as one. */
    activeSubscriptions: subscriptions.value.filter((entry) => entry.cancelledOn === null).length,
    openShoppingItems: shopping.value.filter((item) => item.status === 'wanted').length,
    excludedCurrencies: excludedCurrencies(
      [
        ...accounts.value.map((account) => account.currency),
        ...transactions.value.map((txn) => txn.currency),
      ],
      currency,
    ),
  });
}

/* =========================================================================
 * Accounts
 * ====================================================================== */

export type AccountRow = {
  readonly id: string;
  readonly name: string;
  readonly kind: AccountKind;
  readonly kindLabel: string;
  readonly institution: string | null;
  readonly currency: string;
  readonly isLiability: boolean;
  readonly openedOn: string | null;
  readonly closedOn: string | null;
  /** The balance last read off the account, formatted, or `null` if never read. */
  readonly balance: string | null;
  /** The day it was read, which is not necessarily the day it was entered. */
  readonly asOfDayKey: string | null;
  /** Whole days since that reading, or `null` when there has been none. */
  readonly ageDays: number | null;
  readonly isStale: boolean;
  readonly note: string | null;
};

export type AccountsBoard = {
  readonly todayDayKey: string;
  readonly accounts: readonly AccountRow[];
  /** What "stale" means here, so the page can say it rather than imply it. */
  readonly staleThresholdDays: number;
  readonly staleCount: number;
  /** Accounts with no reading at all — a different fact from an old one. */
  readonly unreadCount: number;
};

export async function loadAccounts(
  db: Database,
  zone: string,
): Promise<Result<AccountsBoard, DomainError>> {
  const money = createMoneyRepository(db);

  const nowIso = isoFromMillis(systemClock.nowMillis());
  const todayDayKey = dayKeyInZone(nowIso, zone);

  const accounts = await money.accounts();
  if (!accounts.ok) return accounts;

  const balances = await money.balancesFor(
    accounts.value.map((account) => account.id),
    todayDayKey,
  );
  if (!balances.ok) return balances;

  const latest = latestBalances(balances.value);

  const rows = accounts.value.map((account): AccountRow => {
    const balance = latest.get(account.id) ?? null;
    const ageDays = balance === null ? null : daysBetween(balance.asOfDayKey, todayDayKey);
    return {
      id: account.id,
      name: account.name,
      kind: account.kind,
      kindLabel: ACCOUNT_KIND_LABELS[account.kind],
      institution: account.institution,
      currency: account.currency,
      isLiability: account.isLiability,
      openedOn: account.openedOn,
      closedOn: account.closedOn,
      /*
       * Formatted in the currency of the **reading**, not of the account. That
       * is the currency the number was denominated in when it was observed, and
       * relabelling it with the account's would be a silent conversion.
       */
      balance:
        balance === null
          ? null
          : formatAmount({ amountMinor: balance.amountMinor, currency: balance.currency }),
      asOfDayKey: balance === null ? null : balance.asOfDayKey,
      ageDays,
      /* An account with no reading is not stale — it is unread, which the board
       * counts separately. Conflating the two would put a brand-new account on
       * the "nobody has looked at this" list on the day it was created. */
      isStale: ageDays !== null && ageDays > STALE_BALANCE_DAYS,
      note: account.note,
    };
  });

  return ok({
    todayDayKey,
    accounts: rows,
    staleThresholdDays: STALE_BALANCE_DAYS,
    staleCount: rows.filter((row) => row.isStale).length,
    unreadCount: rows.filter((row) => row.balance === null).length,
  });
}

/* =========================================================================
 * Transactions
 * ====================================================================== */

export type TransactionRow = {
  readonly id: string;
  readonly dayKey: string;
  /** Already formatted, sign included — `'-₹1250.00'`. */
  readonly amount: string;
  readonly currency: string;
  /** Money leaving. Read from `core`, never from a `< 0` written at a call site. */
  readonly isOutflow: boolean;
  readonly merchant: string | null;
  readonly rawDescription: string | null;
  readonly category: SpendCategory | null;
  readonly categoryLabel: string | null;
  /** Whether a person chose the category. An import's guess never sets this. */
  readonly isCategoryConfirmed: boolean;
  readonly accountId: string | null;
  readonly accountName: string | null;
};

/** Enough of an account to attach a row or a batch to it. */
export type AccountOption = {
  readonly id: string;
  readonly name: string;
  readonly currency: string;
};

export type TransactionsBoard = {
  readonly todayDayKey: string;
  readonly fromDayKey: string;
  readonly toDayKey: string;
  readonly transactions: readonly TransactionRow[];
  /** Rows nobody has categorised. A review queue, deliberately not folded into `other`. */
  readonly uncategorised: number;
  readonly accounts: readonly AccountOption[];
  readonly defaultCurrency: string;
};

export async function loadTransactions(
  db: Database,
  zone: string,
  options: { readonly fromDayKey?: string; readonly toDayKey?: string } = {},
): Promise<Result<TransactionsBoard, DomainError>> {
  const money = createMoneyRepository(db);

  const nowIso = isoFromMillis(systemClock.nowMillis());
  const todayDayKey = dayKeyInZone(nowIso, zone);
  const toDayKey = options.toDayKey ?? todayDayKey;
  const fromDayKey = options.fromDayKey ?? shiftDayKey(toDayKey, -(MONEY_WINDOW_DAYS - 1)) ?? toDayKey;

  const [transactions, accounts] = await Promise.all([
    money.transactionsBetween(fromDayKey, toDayKey),
    money.accounts(),
  ]);
  if (!transactions.ok) return transactions;
  if (!accounts.ok) return accounts;

  const names = new Map(accounts.value.map((account) => [account.id, account.name]));

  return ok({
    todayDayKey,
    fromDayKey,
    toDayKey,
    transactions: transactions.value.map((txn): TransactionRow => {
      const amount: Money = { amountMinor: txn.amountMinor, currency: txn.currency };
      return {
        id: txn.id,
        dayKey: txn.dayKey,
        amount: formatAmount(amount),
        currency: normalise(txn.currency),
        isOutflow: isOutflow(amount),
        merchant: txn.merchant,
        rawDescription: txn.rawDescription,
        category: txn.category,
        categoryLabel: txn.category === null ? null : SPEND_CATEGORY_LABELS[txn.category],
        isCategoryConfirmed: txn.isCategoryConfirmed,
        accountId: txn.accountId,
        accountName: txn.accountId === null ? null : (names.get(txn.accountId) ?? null),
      };
    }),
    uncategorised: transactions.value.filter((txn) => txn.category === null).length,
    accounts: accounts.value.map((account) => ({
      id: account.id,
      name: account.name,
      currency: account.currency,
    })),
    defaultCurrency: DEFAULT_CURRENCY,
  });
}

/* =========================================================================
 * Budgets
 * ====================================================================== */

export type BudgetRow = {
  readonly id: string;
  readonly category: SpendCategory;
  readonly categoryLabel: string;
  readonly period: BudgetPeriod;
  readonly periodLabel: string;
  /** The allowance, formatted. */
  readonly amount: string;
  readonly currency: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly isActive: boolean;
  /** The window the spend below was summed over — period-to-date. */
  readonly periodFromDayKey: string;
  readonly periodToDayKey: string;
  /** Spent in that window, formatted, or `null` when there is nothing to report. */
  readonly spent: string | null;
  readonly remaining: string | null;
  /** `spent / allowance`, for a bar. `null` when either half is missing. */
  readonly ratio: number | null;
  readonly transactions: number;
  readonly note: string | null;
};

export type BudgetsBoard = {
  readonly todayDayKey: string;
  readonly budgets: readonly BudgetRow[];
  readonly currency: string;
  readonly activeCount: number;
};

/**
 * Budgets, each against what the current period has actually cost.
 *
 * **A budget owns no spending** (§9.3(4), and the schema repeats it verbatim):
 * what was spent is summed from `money_transaction` on every read. A stored
 * `spent` would be a cache with no invalidation story — the first recategorised
 * transaction puts it out of step with the rows it claims to summarise, and
 * nothing in the system would ever notice.
 */
export async function loadBudgets(
  db: Database,
  zone: string,
): Promise<Result<BudgetsBoard, DomainError>> {
  const money = createMoneyRepository(db);

  const nowIso = isoFromMillis(systemClock.nowMillis());
  const todayDayKey = dayKeyInZone(nowIso, zone);

  const budgets = await money.budgets();
  if (!budgets.ok) return budgets;

  /* One read covering the earliest period any budget needs, then filtered per
   * budget in memory. An annual budget and a weekly one otherwise mean two
   * round trips to overlapping ranges. */
  const windows = budgets.value.map((entry) => periodStartDayKey(entry.period, todayDayKey));
  const earliest = windows.reduce((lowest, start) => (start < lowest ? start : lowest), todayDayKey);

  const transactions = await money.transactionsBetween(earliest, todayDayKey);
  if (!transactions.ok) return transactions;

  const rows = budgets.value.map((entry: Budget, index): BudgetRow => {
    const periodStart = windows[index] ?? todayDayKey;
    /* A budget that began mid-period is only answerable for the part of the
     * period it was in force for, and one that ended is answerable to its last
     * day rather than to today. */
    const from = entry.effectiveFrom > periodStart ? entry.effectiveFrom : periodStart;
    const to =
      entry.effectiveTo !== null && entry.effectiveTo < todayDayKey ? entry.effectiveTo : todayDayKey;

    const inWindow = transactions.value.filter((txn) => txn.dayKey >= from && txn.dayKey <= to);
    const spend =
      spendByCategory(inWindow, entry.currency).find((slice) => slice.category === entry.category) ??
      null;
    const standing = budgetStanding(entry, spend);

    return {
      id: entry.id,
      category: entry.category,
      categoryLabel: SPEND_CATEGORY_LABELS[entry.category],
      period: entry.period,
      periodLabel: BUDGET_PERIOD_LABELS[entry.period],
      amount: formatAmount({ amountMinor: entry.amountMinor, currency: entry.currency }),
      currency: normalise(entry.currency),
      effectiveFrom: entry.effectiveFrom,
      effectiveTo: entry.effectiveTo,
      isActive: isBudgetActive(entry, todayDayKey),
      periodFromDayKey: from,
      periodToDayKey: to,
      /* `null`, not a full allowance remaining. No transactions is not the same
       * fact as no spending, and the likelier explanation is an import that has
       * not happened yet. */
      spent: standing.spent === null ? null : formatAmount(standing.spent),
      remaining: standing.remaining === null ? null : formatAmount(standing.remaining),
      ratio: standing.ratio,
      transactions: standing.transactions,
      note: entry.note,
    };
  });

  return ok({
    todayDayKey,
    budgets: rows,
    currency: DEFAULT_CURRENCY,
    activeCount: rows.filter((row) => row.isActive).length,
  });
}

/* =========================================================================
 * Subscriptions
 * ====================================================================== */

/** How many times a cadence occurs in a year. */
const CADENCE_PER_YEAR: Readonly<Record<SubscriptionCadenceValue, bigint>> = Object.freeze({
  /* 52, not 365/7. A weekly charge lands 52 times in a year; the extra day and
   * a bit is not a payment, and rounding it into one overstates every weekly
   * commitment by roughly 2%. */
  weekly: 52n,
  monthly: 12n,
  quarterly: 4n,
  annual: 1n,
});

export type SubscriptionRow = {
  readonly id: string;
  readonly name: string;
  /** The charge itself, formatted. */
  readonly amount: string;
  /** The same commitment over a year, formatted. Exact `bigint` multiplication. */
  readonly annualised: string;
  readonly currency: string;
  readonly cadence: SubscriptionCadenceValue;
  readonly category: SpendCategory | null;
  readonly categoryLabel: string | null;
  readonly accountId: string | null;
  readonly startedOn: string | null;
  readonly nextDueOn: string | null;
  readonly cancelledOn: string | null;
  readonly cancellationNote: string | null;
  readonly lastReviewedOn: string | null;
  /** Days since anyone looked at this commitment, or `null` if nobody ever has. */
  readonly daysSinceReviewed: number | null;
  readonly note: string | null;
};

export type SubscriptionsBoard = {
  readonly active: readonly SubscriptionRow[];
  /** Cancelled rows are history, never removed — §4.9's most interesting rows. */
  readonly cancelled: readonly SubscriptionRow[];
  /** Annualised total of the active rows in {@link DEFAULT_CURRENCY}, or `null`. */
  readonly annualisedTotal: string | null;
  readonly currency: string;
  /** Active rows that have never been reviewed. Counted, not guessed at. */
  readonly neverReviewed: number;
  readonly excludedCurrencies: readonly string[];
};

export async function loadSubscriptions(
  db: Database,
): Promise<Result<SubscriptionsBoard, DomainError>> {
  const money = createMoneyRepository(db);

  const subscriptions = await money.subscriptions();
  if (!subscriptions.ok) return subscriptions;

  /*
   * Read in UTC, and deliberately so: this loader takes no zone because a
   * review age in whole days does not turn on one. The threshold a reader
   * applies to "last looked at" is months, and an off-by-one at midnight is not
   * a fact worth an extra parameter on every call site.
   */
  const todayDayKey = dayKeyInZone(isoFromMillis(systemClock.nowMillis()), 'UTC');

  const rows = subscriptions.value.map((entry: Subscription): SubscriptionRow => {
    const amount: Money = { amountMinor: entry.amountMinor, currency: entry.currency };
    const perYear = CADENCE_PER_YEAR[entry.cadence];
    return {
      id: entry.id,
      name: entry.name,
      amount: formatAmount(amount),
      annualised: formatAmount({
        amountMinor: entry.amountMinor * perYear,
        currency: entry.currency,
      }),
      currency: normalise(entry.currency),
      cadence: entry.cadence,
      category: entry.category,
      categoryLabel: entry.category === null ? null : SPEND_CATEGORY_LABELS[entry.category],
      accountId: entry.accountId,
      startedOn: entry.startedOn,
      nextDueOn: entry.nextDueOn,
      cancelledOn: entry.cancelledOn,
      cancellationNote: entry.cancellationNote,
      lastReviewedOn: entry.lastReviewedOn,
      /* `null` rather than a large number. "Never reviewed" and "reviewed 400
       * days ago" are different sentences, and the second is wrong for a row
       * that was created yesterday. */
      daysSinceReviewed:
        entry.lastReviewedOn === null ? null : daysBetween(entry.lastReviewedOn, todayDayKey),
      note: entry.note,
    };
  });

  const active = rows.filter((row) => row.cancelledOn === null);
  const activeEntries = subscriptions.value.filter((entry) => entry.cancelledOn === null);

  /* Only the board's currency totals. A commitment in dollars is listed with its
   * own figures and left out of the sum — there is no rate to fold it in with. */
  const totalled = sumAmounts(
    activeEntries
      .filter((entry) => normalise(entry.currency) === DEFAULT_CURRENCY)
      .map((entry) => ({
        amountMinor: entry.amountMinor * CADENCE_PER_YEAR[entry.cadence],
        currency: DEFAULT_CURRENCY,
      })),
  );
  if (!totalled.ok) return totalled;

  return ok({
    active,
    cancelled: rows.filter((row) => row.cancelledOn !== null),
    annualisedTotal: totalled.value === null ? null : formatAmount(totalled.value),
    currency: DEFAULT_CURRENCY,
    neverReviewed: active.filter((row) => row.lastReviewedOn === null).length,
    excludedCurrencies: excludedCurrencies(
      activeEntries.map((entry) => entry.currency),
      DEFAULT_CURRENCY,
    ),
  });
}

/* =========================================================================
 * Shopping
 * ====================================================================== */

export type ShoppingRow = {
  readonly id: string;
  readonly name: string;
  readonly status: ShoppingStatusValue;
  readonly category: SpendCategory | null;
  readonly categoryLabel: string | null;
  readonly quantity: number | null;
  /** Expected or actual price, formatted, or `null` — most things arrive unpriced. */
  readonly amount: string | null;
  readonly currency: string | null;
  readonly purchasedAt: string | null;
  readonly transactionId: string | null;
  readonly linkedEntityType: string | null;
  readonly linkedEntityId: string | null;
  readonly note: string | null;
};

export type ShoppingBoard = {
  readonly wanted: readonly ShoppingRow[];
  readonly purchased: readonly ShoppingRow[];
  /** A first-class outcome, not a failure to buy — the reason `abandoned` exists on a learning item. */
  readonly dropped: readonly ShoppingRow[];
  /** What the wanted list would cost, counting only the items that carry a price. */
  readonly wantedTotal: string | null;
  /** How many wanted items carry no price, so the total above can be read honestly. */
  readonly wantedUnpriced: number;
  readonly currency: string;
  readonly excludedCurrencies: readonly string[];
};

export async function loadShopping(db: Database): Promise<Result<ShoppingBoard, DomainError>> {
  const money = createMoneyRepository(db);

  const items = await money.shoppingItems();
  if (!items.ok) return items;

  const rows = items.value.map((item: ShoppingItem): ShoppingRow => {
    /* The schema pairs amount and currency with a CHECK, so one without the
     * other cannot arrive; this reads both or neither and renders neither. */
    const priced =
      item.amountMinor === null || item.currency === null
        ? null
        : { amountMinor: item.amountMinor, currency: item.currency };
    return {
      id: item.id,
      name: item.name,
      status: item.status,
      category: item.category,
      categoryLabel: item.category === null ? null : SPEND_CATEGORY_LABELS[item.category],
      quantity: item.quantity,
      amount: priced === null ? null : formatAmount(priced),
      currency: item.currency === null ? null : normalise(item.currency),
      purchasedAt: item.purchasedAt,
      transactionId: item.transactionId,
      linkedEntityType: item.linkedEntityType,
      linkedEntityId: item.linkedEntityId,
      note: item.note,
    };
  });

  const wantedItems = items.value.filter((item) => item.status === 'wanted');
  const totalled = sumAmounts(
    wantedItems.flatMap((item) =>
      item.amountMinor === null ||
      item.currency === null ||
      normalise(item.currency) !== DEFAULT_CURRENCY
        ? []
        : [{ amountMinor: item.amountMinor, currency: DEFAULT_CURRENCY }],
    ),
  );
  if (!totalled.ok) return totalled;

  return ok({
    wanted: rows.filter((row) => row.status === 'wanted'),
    purchased: rows.filter((row) => row.status === 'purchased'),
    dropped: rows.filter((row) => row.status === 'dropped'),
    wantedTotal: totalled.value === null ? null : formatAmount(totalled.value),
    wantedUnpriced: wantedItems.filter((item) => item.amountMinor === null).length,
    currency: DEFAULT_CURRENCY,
    excludedCurrencies: excludedCurrencies(
      wantedItems.flatMap((item) => (item.currency === null ? [] : [item.currency])),
      DEFAULT_CURRENCY,
    ),
  });
}

/* =========================================================================
 * Net worth
 * ====================================================================== */

export type NetWorthPoint = {
  readonly dayKey: string;
  /** Major units, for the line. `null` on a day with no reading — see below. */
  readonly value: number | null;
  /** The same figure formatted, or `null`. */
  readonly label: string | null;
};

export type NetWorthBoard = {
  readonly todayDayKey: string;
  readonly windowDays: number;
  readonly currency: string;
  /** One entry per day in the window, oldest first. */
  readonly series: readonly NetWorthPoint[];
  /** Totals as of today, from each account's latest reading. `null` when none. */
  readonly assets: string | null;
  readonly liabilities: string | null;
  readonly net: string | null;
  readonly accountsCounted: number;
  readonly accountsStale: number;
  readonly staleThresholdDays: number;
  readonly excludedCurrencies: readonly string[];
};

/**
 * Net worth over a year, from balances that were read.
 *
 * ## The series is `null` on a day nothing was read, and is not carried forward
 *
 * The choice, stated once: **a day with no balance reading contributes `null`**,
 * and the chart draws a gap. The alternative — repeating yesterday's figure
 * across the days since — draws a flat line that looks like a period of
 * stability, which is a claim the record does not support. A flat line is a
 * finding; silence is not, and only one of them is honest about an operator who
 * did not open their banking app for five weeks.
 *
 * One consequence has to be said plainly, because it is the honest limit of
 * this approach: on a day that *does* carry a reading, the accounts that were
 * not read that day contribute their most recent earlier reading — that is what
 * `netWorthOn` does, and there is no way to total accounts otherwise. So a
 * point is "everything known as of this day", not "everything read on this
 * day". `accountsStale` on the summary is how old that knowledge is allowed to
 * be before the page is expected to say so.
 */
export async function loadNetWorth(
  db: Database,
  zone: string,
): Promise<Result<NetWorthBoard, DomainError>> {
  const money = createMoneyRepository(db);
  const currency = DEFAULT_CURRENCY;

  const nowIso = isoFromMillis(systemClock.nowMillis());
  const todayDayKey = dayKeyInZone(nowIso, zone);

  const accounts = await money.accounts();
  if (!accounts.ok) return accounts;

  const balances = await money.balancesFor(
    accounts.value.map((account) => account.id),
    todayDayKey,
  );
  if (!balances.ok) return balances;

  const windowFrom = shiftDayKey(todayDayKey, -(NET_WORTH_WINDOW_DAYS - 1)) ?? todayDayKey;
  const readingDays = new Set(
    balances.value
      .filter((balance) => balance.asOfDayKey >= windowFrom)
      .map((balance) => balance.asOfDayKey),
  );

  const series = windowDayKeys(todayDayKey, NET_WORTH_WINDOW_DAYS).map((dayKey): NetWorthPoint => {
    /* Only days that carry a reading produce a point. Everything else is a gap,
     * which is the whole argument above. */
    if (!readingDays.has(dayKey)) return { dayKey, value: null, label: null };

    const onDay = netWorthOn(accounts.value, balances.value, dayKey, currency);
    return onDay.net === null
      ? { dayKey, value: null, label: null }
      : { dayKey, value: majorUnits(onDay.net), label: formatAmount(onDay.net) };
  });

  const summary = netWorthOn(accounts.value, balances.value, todayDayKey, currency);

  return ok({
    todayDayKey,
    windowDays: NET_WORTH_WINDOW_DAYS,
    currency,
    series,
    assets: summary.assets === null ? null : formatAmount(summary.assets),
    liabilities: summary.liabilities === null ? null : formatAmount(summary.liabilities),
    net: summary.net === null ? null : formatAmount(summary.net),
    accountsCounted: summary.accountsCounted,
    accountsStale: summary.accountsStale,
    staleThresholdDays: STALE_BALANCE_DAYS,
    /*
     * The codes rather than `summary.accountsExcluded`'s count. "Two accounts
     * omitted" leaves a reader guessing; "USD, AED omitted" tells them which
     * part of their holdings this figure does not describe.
     */
    excludedCurrencies: excludedCurrencies(
      accounts.value.map((account) => account.currency),
      currency,
    ),
  });
}
