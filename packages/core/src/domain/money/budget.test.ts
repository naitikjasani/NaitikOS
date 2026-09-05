import { describe, expect, it } from 'vitest';

import {
  BUDGET_PERIODS,
  BUDGET_PERIOD_LABELS,
  SPEND_CATEGORIES,
  SPEND_CATEGORY_LABELS,
  budgetStanding,
  isBudgetActive,
  spendByCategory,
  validateBudget,
  type Budget,
  type CategorySpend,
  type MoneyTransaction,
} from './budget';

const budget = (overrides: Partial<Budget> = {}): Budget => ({
  id: 'b',
  category: 'groceries',
  period: 'monthly',
  amountMinor: 500_000n,
  currency: 'INR',
  effectiveFrom: '2026-01-01',
  effectiveTo: null,
  note: null,
  ...overrides,
});

const txn = (overrides: Partial<MoneyTransaction> & { id: string }): MoneyTransaction => ({
  accountId: null,
  amountMinor: -100n,
  currency: 'INR',
  occurredAt: '2026-08-15T09:00:00.000Z',
  zone: 'Asia/Kolkata',
  dayKey: '2026-08-15',
  rawDescription: null,
  merchant: null,
  category: 'groceries',
  isCategoryConfirmed: false,
  subscriptionId: null,
  importHash: null,
  importedAt: null,
  note: null,
  ...overrides,
});

describe('the vocabularies', () => {
  it('mirrors the spend_category enum in full', () => {
    expect(SPEND_CATEGORIES).toHaveLength(18);
    for (const category of SPEND_CATEGORIES) {
      expect(SPEND_CATEGORY_LABELS[category]).toBeTruthy();
    }
  });

  it('labels every period', () => {
    for (const period of BUDGET_PERIODS) {
      expect(BUDGET_PERIOD_LABELS[period]).toBeTruthy();
    }
  });
});

describe('validateBudget', () => {
  const base = {
    id: 'b',
    category: 'groceries',
    period: 'monthly',
    amountMinor: 500_000n,
    currency: 'INR',
    effectiveFrom: '2026-01-01',
  } as const;

  it('accepts a whole budget', () => {
    expect(validateBudget(base).ok).toBe(true);
  });

  it('refuses an allowance of nothing', () => {
    const result = validateBudget({ ...base, amountMinor: 0n });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('budget_amount_not_positive');
  });

  it('refuses an end before a beginning', () => {
    const result = validateBudget({ ...base, effectiveTo: '2025-12-31' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('budget_dates_disordered');
  });
});

describe('isBudgetActive', () => {
  it('is inclusive at both ends', () => {
    const b = budget({ effectiveFrom: '2026-01-01', effectiveTo: '2026-06-30' });
    expect(isBudgetActive(b, '2026-01-01')).toBe(true);
    expect(isBudgetActive(b, '2026-06-30')).toBe(true);
    expect(isBudgetActive(b, '2025-12-31')).toBe(false);
    expect(isBudgetActive(b, '2026-07-01')).toBe(false);
  });

  it('runs indefinitely with no end', () => {
    expect(isBudgetActive(budget(), '2099-01-01')).toBe(true);
  });

  it('refuses to answer for a key that is not a day key', () => {
    expect(isBudgetActive(budget(), '31-08-2026')).toBe(false);
  });
});

describe('spendByCategory', () => {
  it('sums outflows as a positive magnitude', () => {
    const spend = spendByCategory(
      [txn({ id: '1', amountMinor: -30_000n }), txn({ id: '2', amountMinor: -12_050n })],
      'INR',
    );
    expect(spend).toHaveLength(1);
    expect(spend[0]?.spent.amountMinor).toBe(42_050n);
    expect(spend[0]?.transactions).toBe(2);
  });

  it('ignores a refund rather than netting it off', () => {
    const spend = spendByCategory(
      [txn({ id: '1', amountMinor: -30_000n }), txn({ id: '2', amountMinor: 30_000n })],
      'INR',
    );
    expect(spend[0]?.spent.amountMinor).toBe(30_000n);
    expect(spend[0]?.transactions).toBe(1);
  });

  it('excludes transfers and income entirely', () => {
    const spend = spendByCategory(
      [
        txn({ id: '1', category: 'transfer', amountMinor: -100_000n }),
        txn({ id: '2', category: 'income', amountMinor: 900_000n }),
      ],
      'INR',
    );
    /* A transfer between the operator's own accounts is not spending, and
     * counting it would inflate every total it touched. */
    expect(spend).toEqual([]);
  });

  it('skips an uncategorised transaction rather than filing it under other', () => {
    const spend = spendByCategory([txn({ id: '1', category: null })], 'INR');
    expect(spend).toEqual([]);
  });

  it('skips a foreign-currency transaction rather than converting it', () => {
    const spend = spendByCategory(
      [txn({ id: '1', amountMinor: -100n }), txn({ id: '2', currency: 'USD', amountMinor: -100n })],
      'INR',
    );
    expect(spend[0]?.transactions).toBe(1);
  });

  it('orders by spend, largest first', () => {
    const spend = spendByCategory(
      [
        txn({ id: '1', category: 'groceries', amountMinor: -100n }),
        txn({ id: '2', category: 'rent', amountMinor: -5_000n }),
      ],
      'INR',
    );
    expect(spend.map((row) => row.category)).toEqual(['rent', 'groceries']);
  });
});

describe('budgetStanding', () => {
  const spend = (amountMinor: bigint, currency = 'INR'): CategorySpend => ({
    category: 'groceries',
    spent: { amountMinor, currency },
    transactions: 3,
  });

  it('reports what is left', () => {
    const standing = budgetStanding(budget({ amountMinor: 500_000n }), spend(200_000n));
    expect(standing.spent?.amountMinor).toBe(200_000n);
    expect(standing.remaining?.amountMinor).toBe(300_000n);
    expect(standing.ratio).toBeCloseTo(0.4);
  });

  it('lets remaining go negative rather than clamping it', () => {
    const standing = budgetStanding(budget({ amountMinor: 100_000n }), spend(150_000n));
    expect(standing.remaining?.amountMinor).toBe(-50_000n);
    expect(standing.ratio).toBeCloseTo(1.5);
  });

  it('says nothing when no transaction has been seen', () => {
    const standing = budgetStanding(budget(), null);
    /* No transactions is not no spending — most likely the import has not run,
     * and a full allowance remaining would be a confident wrong number. */
    expect(standing.spent).toBeNull();
    expect(standing.remaining).toBeNull();
    expect(standing.ratio).toBeNull();
    expect(standing.transactions).toBe(0);
  });

  it('refuses to set a foreign total against the budget', () => {
    const standing = budgetStanding(budget(), spend(200_000n, 'USD'));
    expect(standing.spent).toBeNull();
    expect(standing.remaining).toBeNull();
    /* The count is still a fact even when nothing can be totalled. */
    expect(standing.transactions).toBe(3);
  });

  it('returns no ratio for a budget of zero', () => {
    const standing = budgetStanding(budget({ amountMinor: 0n }), spend(200_000n));
    expect(standing.ratio).toBeNull();
    expect(standing.remaining?.amountMinor).toBe(-200_000n);
  });
});
