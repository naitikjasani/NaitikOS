import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_KIND_LABELS,
  ACCOUNT_KINDS,
  STALE_BALANCE_DAYS,
  netWorthOn,
  validateAccount,
  type AccountBalance,
  type FinancialAccount,
} from './account';

const account = (overrides: Partial<FinancialAccount> & { id: string }): FinancialAccount => ({
  name: 'Account',
  kind: 'savings',
  institution: null,
  currency: 'INR',
  isLiability: false,
  openedOn: null,
  closedOn: null,
  note: null,
  ...overrides,
});

const balance = (
  accountId: string,
  asOfDayKey: string,
  amountMinor: bigint,
  currency = 'INR',
): AccountBalance => ({ id: `${accountId}-${asOfDayKey}`, accountId, asOfDayKey, amountMinor, currency });

describe('the kind vocabulary', () => {
  it('labels every kind', () => {
    for (const kind of ACCOUNT_KINDS) {
      expect(ACCOUNT_KIND_LABELS[kind]).toBeTruthy();
    }
  });
});

describe('validateAccount', () => {
  const base = { id: 'a', name: 'HDFC savings', kind: 'savings', currency: 'INR' } as const;

  it('accepts a whole account', () => {
    expect(validateAccount(base).ok).toBe(true);
  });

  it('refuses an empty name', () => {
    const result = validateAccount({ ...base, name: '  ' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('account_name_empty');
  });

  it('refuses a currency that is not a code', () => {
    const result = validateAccount({ ...base, currency: 'rupees' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('account_currency_invalid');
  });

  it('refuses a close before an open', () => {
    const result = validateAccount({ ...base, openedOn: '2026-01-10', closedOn: '2026-01-01' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('account_dates_disordered');
  });
});

describe('netWorthOn', () => {
  it('subtracts a liability rather than adding it', () => {
    const savings = account({ id: 's', isLiability: false });
    const card = account({ id: 'c', kind: 'credit_card', isLiability: true });

    const worth = netWorthOn(
      [savings, card],
      [balance('s', '2026-08-31', 10_000_00n), balance('c', '2026-08-31', 40_000n)],
      '2026-08-31',
      'INR',
    );

    expect(worth.assets?.amountMinor).toBe(1_000_000n);
    expect(worth.liabilities?.amountMinor).toBe(40_000n);
    /* Off by twice the balance is the failure the schema comment names. */
    expect(worth.net?.amountMinor).toBe(960_000n);
    expect(worth.accountsCounted).toBe(2);
  });

  it('reads the flag, not the account kind', () => {
    /* A loan mislabelled `other` still subtracts, because `is_liability` is the
     * only thing that decides. */
    const loan = account({ id: 'l', kind: 'other', isLiability: true });
    const worth = netWorthOn([loan], [balance('l', '2026-08-31', 500n)], '2026-08-31', 'INR');
    expect(worth.net?.amountMinor).toBe(-500n);
    expect(worth.assets).toBeNull();
  });

  it('takes the most recent reading at or before the day', () => {
    const worth = netWorthOn(
      [account({ id: 's' })],
      [
        balance('s', '2026-07-01', 100n),
        balance('s', '2026-08-15', 300n),
        balance('s', '2026-09-30', 999n),
      ],
      '2026-08-31',
      'INR',
    );
    expect(worth.assets?.amountMinor).toBe(300n);
  });

  it('counts a reading older than the staleness horizon', () => {
    const fresh = account({ id: 'f' });
    const old = account({ id: 'o' });
    const worth = netWorthOn(
      [fresh, old],
      [balance('f', '2026-08-30', 100n), balance('o', '2026-06-01', 100n)],
      '2026-08-31',
      'INR',
    );
    expect(worth.accountsCounted).toBe(2);
    expect(worth.accountsStale).toBe(1);
    expect(STALE_BALANCE_DAYS).toBe(45);
  });

  it('excludes a foreign-currency account and says so', () => {
    const rupees = account({ id: 'r', currency: 'INR' });
    const dollars = account({ id: 'd', currency: 'USD' });
    const worth = netWorthOn(
      [rupees, dollars],
      [balance('r', '2026-08-31', 100n), balance('d', '2026-08-31', 100n, 'USD')],
      '2026-08-31',
      'INR',
    );
    expect(worth.assets?.amountMinor).toBe(100n);
    expect(worth.accountsCounted).toBe(1);
    /* Never converted. Reported instead, so the figure is visibly partial. */
    expect(worth.accountsExcluded).toBe(1);
  });

  it('says nothing rather than zero when there is no reading', () => {
    const worth = netWorthOn([account({ id: 's' })], [], '2026-08-31', 'INR');
    expect(worth.assets).toBeNull();
    expect(worth.liabilities).toBeNull();
    expect(worth.net).toBeNull();
    expect(worth.currency).toBeNull();
    expect(worth.accountsCounted).toBe(0);
  });

  it('drops an account that had closed by the day', () => {
    const settled = account({ id: 'l', isLiability: true, closedOn: '2026-06-30' });
    const worth = netWorthOn([settled], [balance('l', '2026-06-01', 5_000n)], '2026-08-31', 'INR');
    /* A settled loan must not keep subtracting for the life of the record. */
    expect(worth.net).toBeNull();
    expect(worth.accountsCounted).toBe(0);
  });

  it('ignores an account that did not exist yet', () => {
    const later = account({ id: 'n', openedOn: '2026-09-15' });
    const worth = netWorthOn([later], [balance('n', '2026-09-20', 100n)], '2026-08-31', 'INR');
    expect(worth.accountsCounted).toBe(0);
  });

  it('holds an amount a float would round', () => {
    const worth = netWorthOn(
      [account({ id: 's' })],
      [balance('s', '2026-08-31', 999999999999n)],
      '2026-08-31',
      'INR',
    );
    expect(worth.net?.amountMinor).toBe(999999999999n);
  });
});
