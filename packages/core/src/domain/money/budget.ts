/**
 * Budgets and category spending — §4.9.
 *
 * ## A budget owns no spending
 *
 * §9.3(4) settles this for goals — a goal owns no progress — and the money
 * schema applies the same rule verbatim: "It owns no spending, exactly as a
 * goal owns no progress. What was actually spent is summed from
 * `money_transaction` on read, every time."
 *
 * So {@link spendByCategory} recomputes from transactions on every read, and
 * there is no `spent` field anywhere in this file that survives a function
 * call. A stored total would be a cache with no invalidation story: the first
 * recategorised transaction puts it out of step with the transactions it
 * summarises, and nothing in the system would ever notice — the budget page
 * would keep showing a figure that no longer corresponds to any set of rows.
 *
 * ## Only outflows count
 *
 * Two separate rules, and both are needed.
 *
 * A **positive** amount in a spending category is money coming back — a
 * refund, a reimbursement, a reversed charge. It does not reduce what was
 * spent for the purpose a budget answers ("how much did this month cost"), and
 * netting it off would make a month with a large refund look frugal.
 *
 * The **`transfer` and `income` categories** are excluded outright. A transfer
 * is money moving between the operator's own accounts: counted as spending it
 * inflates every total, and netted against spending it looks like a refund of
 * something that was never bought. Neither is a budget line, and there is no
 * budget anybody would set for either.
 */

import type { Result } from '@naitikos/shared';
import { err, ok } from '@naitikos/shared';

import type { DomainError } from '../../errors/domain-error';
import { validationError } from '../../errors/domain-error';
import { dayKeyIndex } from '../../temporal/instant';
import type { Money } from './amount';

/** Mirrors the `budget_period` pgEnum exactly. */
export const BUDGET_PERIODS = Object.freeze(['weekly', 'monthly', 'quarterly', 'annual'] as const);

export type BudgetPeriod = (typeof BUDGET_PERIODS)[number];

export const BUDGET_PERIOD_LABELS: Readonly<Record<BudgetPeriod, string>> = Object.freeze({
  weekly: 'Weekly',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  annual: 'Annual',
});

export function isBudgetPeriod(value: string): value is BudgetPeriod {
  return (BUDGET_PERIODS as readonly string[]).includes(value);
}

/**
 * Mirrors the `spend_category` pgEnum exactly — all eighteen, in schema order.
 *
 * The enum's own comment explains the shortness: `supplements`, `skincare` and
 * the food categories exist because §4.9 names those joins specifically, and
 * everything else is coarse on purpose, because a category the operator has to
 * think about is one that gets chosen inconsistently.
 */
export const SPEND_CATEGORIES = Object.freeze([
  'groceries',
  'eating_out',
  'supplements',
  'skincare',
  'health',
  'fitness',
  'rent',
  'utilities',
  'transport',
  'subscriptions',
  'shopping',
  'travel',
  'education',
  'gifts',
  'fees',
  'income',
  'transfer',
  'other',
] as const);

export type SpendCategory = (typeof SPEND_CATEGORIES)[number];

export const SPEND_CATEGORY_LABELS: Readonly<Record<SpendCategory, string>> = Object.freeze({
  groceries: 'Groceries',
  eating_out: 'Eating out',
  supplements: 'Supplements',
  skincare: 'Skincare',
  health: 'Health',
  fitness: 'Fitness',
  rent: 'Rent',
  utilities: 'Utilities',
  transport: 'Transport',
  subscriptions: 'Subscriptions',
  shopping: 'Shopping',
  travel: 'Travel',
  education: 'Education',
  gifts: 'Gifts',
  fees: 'Fees',
  income: 'Income',
  transfer: 'Transfer',
  other: 'Other',
});

export function isSpendCategory(value: string): value is SpendCategory {
  return (SPEND_CATEGORIES as readonly string[]).includes(value);
}

/**
 * Categories that are not spending, and never belong in a budget total.
 *
 * See the module note. `transfer` is the dangerous one: money moved between
 * the operator's own accounts appears twice in an import, once out and once
 * in, and a total that admitted it would double-count the outbound half while
 * the inbound half looked like a refund.
 */
export const NON_SPEND_CATEGORIES: readonly SpendCategory[] = Object.freeze(['income', 'transfer']);

/**
 * A transaction, as the domain reads it.
 *
 * It lives beside the budget because this is the only place in `core` that
 * interprets one: everything else about a transaction — where it came from,
 * how it deduplicates — is the repository's business. The amount is a `bigint`
 * all the way through, per `amount.ts`.
 */
export type MoneyTransaction = {
  readonly id: string;
  readonly accountId: string | null;
  /** Negative is money leaving. The schema fixes this convention once. */
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly occurredAt: string;
  readonly zone: string | null;
  readonly dayKey: string;
  readonly rawDescription: string | null;
  readonly merchant: string | null;
  readonly category: SpendCategory | null;
  readonly isCategoryConfirmed: boolean;
  readonly subscriptionId: string | null;
  readonly importHash: string | null;
  readonly importedAt: string | null;
  readonly note: string | null;
};

export type Budget = {
  readonly id: string;
  readonly category: SpendCategory;
  readonly period: BudgetPeriod;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly note: string | null;
};

export type BudgetInput = {
  readonly id: string;
  readonly category: SpendCategory;
  readonly period: BudgetPeriod;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly effectiveFrom: string;
  readonly effectiveTo?: string | null;
  readonly note?: string | null;
};

const CURRENCY_PATTERN = /^[A-Za-z]{3}$/u;

export function validateBudget(input: BudgetInput): Result<BudgetInput, DomainError> {
  if (!isSpendCategory(input.category)) {
    return err(validationError('budget_category_unknown', `Unknown spend category: ${input.category}.`));
  }
  if (!isBudgetPeriod(input.period)) {
    return err(validationError('budget_period_unknown', `Unknown budget period: ${input.period}.`));
  }
  /*
   * A budget of zero or less is not an allowance.
   *
   * Zero is the tempting one to permit — "I intend to spend nothing here" — but
   * it makes {@link budgetStanding} report a `null` ratio forever, which reads
   * on the page as no data rather than as an intention. The honest way to
   * express that intention is to have no budget for the category.
   */
  if (input.amountMinor <= 0n) {
    return err(validationError('budget_amount_not_positive', 'A budget must be a positive amount.'));
  }
  if (!CURRENCY_PATTERN.test(input.currency.trim())) {
    return err(
      validationError('budget_currency_invalid', 'A budget needs a three-letter ISO-4217 currency.'),
    );
  }
  if (dayKeyIndex(input.effectiveFrom) === null) {
    return err(validationError('budget_from_invalid', 'effectiveFrom must be a YYYY-MM-DD day key.'));
  }
  const to = input.effectiveTo ?? null;
  if (to !== null && dayKeyIndex(to) === null) {
    return err(validationError('budget_to_invalid', 'effectiveTo must be a YYYY-MM-DD day key.'));
  }
  /* Mirrors `budget_dates_ordered`, so a form can name the field. */
  if (to !== null && input.effectiveFrom > to) {
    return err(validationError('budget_dates_disordered', 'A budget cannot end before it begins.'));
  }

  return ok(input);
}

/**
 * Whether a budget is in force on a day.
 *
 * Half-open at neither end: `effectiveTo` is inclusive, matching the `date`
 * column and the way a person reads "in force until the 31st". Day keys are
 * ISO, so the comparisons are string comparisons.
 */
export function isBudgetActive(budget: Budget, dayKey: string): boolean {
  if (dayKeyIndex(dayKey) === null) return false;
  if (dayKey < budget.effectiveFrom) return false;
  return budget.effectiveTo === null || dayKey <= budget.effectiveTo;
}

/* -------------------------------------------------------------------------
 * Spending
 * ---------------------------------------------------------------------- */

export type CategorySpend = {
  readonly category: SpendCategory;
  /** What left, as a positive magnitude. */
  readonly spent: Money;
  readonly transactions: number;
};

/**
 * Sum outflows per category, in one currency.
 *
 * Transactions in another currency are skipped rather than converted — there
 * are no rates here, and a total that quietly folded in a dollar charge at an
 * imagined rate would be a wrong number that looks right (see `amount.ts`).
 *
 * Uncategorised transactions are skipped too. They belong on a review queue
 * rather than in a category total, and assigning them to `other` would bury
 * the fact that nobody has looked at them.
 *
 * The magnitude is reported **positive**: a budget is a positive allowance,
 * and comparing a negative spend against it inverts every ratio on the page.
 */
export function spendByCategory(
  txns: readonly MoneyTransaction[],
  currency: string,
): readonly CategorySpend[] {
  const target = currency.trim().toUpperCase();
  const totals = new Map<SpendCategory, { spent: bigint; transactions: number }>();

  for (const txn of txns) {
    const category = txn.category;
    if (category === null) continue;
    if (NON_SPEND_CATEGORIES.includes(category)) continue;
    if (txn.currency.trim().toUpperCase() !== target) continue;
    /* Outflows only. A positive amount is a refund coming back, and netting it
     * off would make a refunded month read as a frugal one. */
    if (txn.amountMinor >= 0n) continue;

    const held = totals.get(category) ?? { spent: 0n, transactions: 0 };
    totals.set(category, {
      spent: held.spent - txn.amountMinor,
      transactions: held.transactions + 1,
    });
  }

  return [...totals.entries()]
    .map(([category, tally]) => ({
      category,
      spent: { amountMinor: tally.spent, currency: target },
      transactions: tally.transactions,
    }))
    /* Largest first, then alphabetically — a stable order on a page that gets
     * re-read week to week and compared against itself. */
    .sort((a, b) =>
      a.spent.amountMinor === b.spent.amountMinor
        ? a.category.localeCompare(b.category)
        : b.spent.amountMinor > a.spent.amountMinor
          ? 1
          : -1,
    );
}

export type BudgetStanding = {
  readonly budget: Budget;
  readonly spent: Money | null;
  readonly remaining: Money | null;
  /** `spent / budget`, or `null` when there is no denominator or no numerator. */
  readonly ratio: number | null;
  readonly transactions: number;
};

/**
 * Set a category's spending against its budget.
 *
 * `spend` is `null` when the category produced no outflows in the period, and
 * that is reported as `null` rather than as a full allowance remaining. No
 * transactions is not the same fact as no spending: the far likelier
 * explanation is that the statement has not been imported yet, and
 * "₹5,000 remaining" built on a missing import is exactly the confident wrong
 * number §4.9's pillar is arranged to avoid.
 */
export function budgetStanding(budget: Budget, spend: CategorySpend | null): BudgetStanding {
  if (spend === null) {
    return { budget, spent: null, remaining: null, ratio: null, transactions: 0 };
  }

  if (spend.spent.currency.trim().toUpperCase() !== budget.currency.trim().toUpperCase()) {
    /* A total in another currency cannot be set against this budget without a
     * rate this system does not hold. The transaction count is still a fact, so
     * it survives; every figure that would need converting does not. */
    return { budget, spent: null, remaining: null, ratio: null, transactions: spend.transactions };
  }

  const remaining: Money = {
    amountMinor: budget.amountMinor - spend.spent.amountMinor,
    currency: budget.currency,
  };

  /*
   * The ratio is a `number` and that is deliberate — it is a proportion for a
   * progress bar, not an amount, and nothing downstream turns it back into
   * money. Division by a zero budget is `null` rather than `Infinity`: an
   * infinity is not a percentage, and it renders as one on a page.
   */
  const ratio =
    budget.amountMinor <= 0n
      ? null
      : Number(spend.spent.amountMinor) / Number(budget.amountMinor);

  return { budget, spent: spend.spent, remaining, ratio, transactions: spend.transactions };
}
