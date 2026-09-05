import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MINOR_UNITS,
  MINOR_UNITS,
  addAmounts,
  formatAmount,
  isOutflow,
  minorUnitsFor,
  negate,
  parseAmount,
  sumAmounts,
  type Money,
} from './amount';

const money = (amountMinor: bigint, currency = 'INR'): Money => ({ amountMinor, currency });

function value<T>(result: { ok: true; value: T } | { ok: false; error: { code: string } }): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}`);
  return result.value;
}

describe('minorUnitsFor', () => {
  it('knows the currencies the record actually uses', () => {
    expect(minorUnitsFor('INR')).toBe(2);
    expect(minorUnitsFor('JPY')).toBe(0);
    expect(MINOR_UNITS['JPY']).toBe(0);
  });

  it('is case insensitive, because a code is a code', () => {
    expect(minorUnitsFor('jpy')).toBe(0);
  });

  it('falls back to two for a currency it has not met', () => {
    expect(minorUnitsFor('AED')).toBe(DEFAULT_MINOR_UNITS);
  });
});

describe('parseAmount', () => {
  it('reads major units into minor units', () => {
    expect(value(parseAmount('12.50', 'INR'))).toEqual({ amountMinor: 1250n, currency: 'INR' });
    expect(value(parseAmount('-12.5', 'INR'))).toEqual({ amountMinor: -1250n, currency: 'INR' });
    /* A whole number is major units too: ₹1250, not ₹12.50. */
    expect(value(parseAmount('1250', 'INR'))).toEqual({ amountMinor: 125000n, currency: 'INR' });
  });

  it('refuses more precision than the currency has', () => {
    const result = parseAmount('12.505', 'INR');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('amount_precision_exceeded');
  });

  it('treats a yen amount as having no minor unit at all', () => {
    expect(value(parseAmount('1250', 'JPY'))).toEqual({ amountMinor: 1250n, currency: 'JPY' });
    const refused = parseAmount('12.50', 'JPY');
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('amount_precision_exceeded');
  });

  it('refuses anything that is not a plain decimal', () => {
    for (const input of ['', '  ', 'twelve', '1,250.00', '₹12.50', '1e3', '12.', '-', '12.5.0']) {
      expect(parseAmount(input, 'INR').ok).toBe(false);
    }
  });

  it('refuses a currency that is not a three-letter code', () => {
    const result = parseAmount('12.50', 'RUPEES');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('amount_currency_invalid');
  });

  it('carries no negative zero, because bigint has none', () => {
    expect(value(parseAmount('-0.00', 'INR')).amountMinor).toBe(0n);
  });

  it('is exact at a magnitude a float would round', () => {
    /* 9,999,999,999.99 in minor units. A double loses the last digit here, and
     * this assertion is the whole reason the type is `bigint`. */
    expect(value(parseAmount('9999999999.99', 'INR')).amountMinor).toBe(999999999999n);
  });
});

describe('formatAmount', () => {
  it('uses a symbol where one is known', () => {
    expect(formatAmount(money(1250n))).toBe('₹12.50');
    expect(formatAmount(money(1250n, 'USD'))).toBe('$12.50');
  });

  it('falls back to the code, never to a bare number', () => {
    expect(formatAmount(money(1250n, 'AED'))).toBe('AED 12.50');
  });

  it('omits the fractional part for a currency that has none', () => {
    expect(formatAmount(money(1250n, 'JPY'))).toBe('¥1250');
  });

  it('leads with the sign so both forms read the same way round', () => {
    expect(formatAmount(money(-1250n))).toBe('-₹12.50');
    expect(formatAmount(money(-1250n, 'AED'))).toBe('-AED 12.50');
  });

  it('pads the minor units rather than dropping them', () => {
    expect(formatAmount(money(5n))).toBe('₹0.05');
    expect(formatAmount(money(0n))).toBe('₹0.00');
  });
});

describe('addAmounts', () => {
  it('adds within a currency', () => {
    expect(value(addAmounts(money(1250n), money(750n)))).toEqual({
      amountMinor: 2000n,
      currency: 'INR',
    });
  });

  it('refuses to add across currencies rather than inventing a rate', () => {
    const result = addAmounts(money(1250n, 'INR'), money(1250n, 'USD'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('amount_currency_mismatch');
  });
});

describe('sumAmounts', () => {
  it('returns null for an empty set rather than a zero in some currency', () => {
    expect(value(sumAmounts([]))).toBeNull();
  });

  it('totals a set', () => {
    expect(value(sumAmounts([money(100n), money(200n), money(-50n)]))).toEqual({
      amountMinor: 250n,
      currency: 'INR',
    });
  });

  it('fails the whole total on one foreign member', () => {
    const result = sumAmounts([money(100n), money(200n, 'USD')]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('amount_currency_mismatch');
  });
});

describe('negate and isOutflow', () => {
  it('flips the sign and keeps the currency', () => {
    expect(negate(money(1250n))).toEqual({ amountMinor: -1250n, currency: 'INR' });
  });

  it('calls only a negative amount an outflow', () => {
    expect(isOutflow(money(-1n))).toBe(true);
    expect(isOutflow(money(0n))).toBe(false);
    expect(isOutflow(money(1n))).toBe(false);
  });
});
