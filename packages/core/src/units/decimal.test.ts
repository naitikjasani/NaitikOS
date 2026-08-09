import { describe, expect, it } from 'vitest';

import {
  type Decimal,
  DECIMAL_ONE,
  DECIMAL_ZERO,
  QUANTITY_SCALE,
  absDecimal,
  addDecimal,
  checkQuantityFit,
  compareDecimal,
  decimalFromInteger,
  decimalFromUnscaled,
  divideDecimal,
  formatDecimal,
  isZero,
  maxDecimal,
  minDecimal,
  multiplyDecimal,
  negateDecimal,
  parseDecimal,
  roundDecimal,
  signOf,
  subtractDecimal,
  toQuantityString,
} from './decimal';

/** Parse-or-fail, for tests where an unparseable literal is a test bug. */
function d(text: string): Decimal {
  const parsed = parseDecimal(text);
  expect(parsed, `test literal is not a decimal: ${text}`).not.toBeNull();
  return parsed as Decimal;
}

describe('parseDecimal', () => {
  it('preserves scale, because scale is a claim about precision', () => {
    expect(parseDecimal('1.250')).toEqual({ unscaled: 1250n, scale: 3 });
    expect(parseDecimal('1.25')).toEqual({ unscaled: 125n, scale: 2 });
  });

  it('accepts the forms Postgres numeric accepts', () => {
    expect(formatDecimal(d('0'))).toBe('0');
    expect(formatDecimal(d('-0'))).toBe('0');
    expect(formatDecimal(d('.5'))).toBe('0.5');
    expect(formatDecimal(d('5.'))).toBe('5');
    expect(formatDecimal(d('+12'))).toBe('12');
    expect(formatDecimal(d('  74.2  '))).toBe('74.2');
  });

  it('applies exponents', () => {
    expect(formatDecimal(d('1e3'))).toBe('1000');
    expect(formatDecimal(d('1.5e2'))).toBe('150');
    expect(formatDecimal(d('1e-3'))).toBe('0.001');
    expect(formatDecimal(d('1.5E-2'))).toBe('0.015');
  });

  it('rejects everything that is not a finite decimal', () => {
    for (const bad of ['', '   ', '.', 'abc', 'NaN', 'Infinity', '1.2.3', '1,5', '0x10', '1e', '--1']) {
      expect(parseDecimal(bad), bad).toBeNull();
    }
  });

  /**
   * The DoS guard. `1e999999999` is eleven bytes of request body asking for a
   * bigint with a billion digits; without the ceiling this call would hang the
   * route handler rather than return a validation error.
   */
  it('refuses input that would allocate an enormous bigint', () => {
    expect(parseDecimal('1e2000')).toBeNull();
    expect(parseDecimal('1e-2000')).toBeNull();
    expect(parseDecimal(`1${'0'.repeat(1500)}`)).toBeNull();
  });

  it('round-trips through formatDecimal', () => {
    for (const text of ['0', '1', '-1', '0.5', '-0.5', '74.200', '1000000000000.000001']) {
      expect(formatDecimal(d(text))).toBe(text === '-0' ? '0' : text);
    }
  });
});

describe('decimalFromInteger', () => {
  it('accepts safe integers only — a fraction that is already a number has already been rounded', () => {
    expect(decimalFromInteger(4)).toEqual({ unscaled: 4n, scale: 0 });
    expect(decimalFromInteger(-4)).toEqual({ unscaled: -4n, scale: 0 });
    expect(decimalFromInteger(1.5)).toBeNull();
    expect(decimalFromInteger(Number.NaN)).toBeNull();
    expect(decimalFromInteger(Number.MAX_SAFE_INTEGER + 2)).toBeNull();
  });
});

describe('decimalFromUnscaled', () => {
  it('rejects a negative or non-integer scale', () => {
    expect(decimalFromUnscaled(125n, 2)).toEqual({ unscaled: 125n, scale: 2 });
    expect(decimalFromUnscaled(125n, -1)).toBeNull();
    expect(decimalFromUnscaled(125n, 1.5)).toBeNull();
  });
});

describe('formatDecimal', () => {
  it('never emits negative zero', () => {
    expect(formatDecimal({ unscaled: -0n, scale: 2 })).toBe('0.00');
    expect(formatDecimal(d('-0.00'))).toBe('0.00');
  });

  it('trims only when asked, and never to nothing', () => {
    expect(formatDecimal(d('74.200000'), { trim: true })).toBe('74.2');
    expect(formatDecimal(d('74.000000'), { trim: true })).toBe('74');
    expect(formatDecimal(d('0.000000'), { trim: true })).toBe('0');
    expect(formatDecimal(d('-0.500'), { trim: true })).toBe('-0.5');
    // Without the flag the zeros stay: they are the record of precision.
    expect(formatDecimal(d('74.200000'))).toBe('74.200000');
  });
});

describe('compareDecimal', () => {
  it('compares by value, ignoring scale', () => {
    expect(compareDecimal(d('1.50'), d('1.5'))).toBe(0);
    expect(compareDecimal(d('1.5'), d('1.50'))).toBe(0);
    expect(compareDecimal(d('1.5'), d('1.51'))).toBe(-1);
    expect(compareDecimal(d('-1.5'), d('-1.51'))).toBe(1);
    expect(compareDecimal(d('0'), d('-0'))).toBe(0);
  });

  /**
   * The reason `compareDecimal` exists at all rather than string comparison:
   * lexical order is wrong for numbers, and it is wrong quietly.
   */
  it('disagrees with string comparison where string comparison is wrong', () => {
    expect('10'.localeCompare('9')).toBeLessThan(0);
    expect(compareDecimal(d('10'), d('9'))).toBe(1);
  });

  it('supports min, max and sign', () => {
    expect(formatDecimal(minDecimal(d('1.5'), d('2')))).toBe('1.5');
    expect(formatDecimal(maxDecimal(d('1.5'), d('2')))).toBe('2');
    expect(signOf(d('-3'))).toBe(-1);
    expect(signOf(DECIMAL_ZERO)).toBe(0);
    expect(signOf(DECIMAL_ONE)).toBe(1);
    expect(isZero(d('0.000'))).toBe(true);
  });
});

describe('exact arithmetic', () => {
  it('adds and subtracts at the wider scale', () => {
    expect(formatDecimal(addDecimal(d('1.5'), d('2.25')))).toBe('3.75');
    expect(formatDecimal(subtractDecimal(d('1.5'), d('2.25')))).toBe('-0.75');
    expect(formatDecimal(addDecimal(d('0.1'), d('0.2')))).toBe('0.3');
  });

  /**
   * The headline claim of the module, stated as a test: the arithmetic that
   * embarrasses floating point is exact here.
   */
  it('does not reproduce binary floating-point error', () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(compareDecimal(addDecimal(d('0.1'), d('0.2')), d('0.3'))).toBe(0);
  });

  it('multiplies by summing scales', () => {
    expect(formatDecimal(multiplyDecimal(d('1.5'), d('2.25')))).toBe('3.375');
    expect(formatDecimal(multiplyDecimal(d('-1.5'), d('2')))).toBe('-3.0');
  });

  it('negates and takes absolute value', () => {
    expect(formatDecimal(negateDecimal(d('1.5')))).toBe('-1.5');
    expect(formatDecimal(absDecimal(d('-1.5')))).toBe('1.5');
    expect(formatDecimal(absDecimal(d('1.5')))).toBe('1.5');
  });
});

describe('divideDecimal', () => {
  it('divides to the requested scale', () => {
    expect(formatDecimal(divideDecimal(d('1'), d('3'), 4) as Decimal)).toBe('0.3333');
    expect(formatDecimal(divideDecimal(d('2'), d('3'), 4) as Decimal)).toBe('0.6667');
    expect(formatDecimal(divideDecimal(d('10'), d('4'), 2) as Decimal)).toBe('2.50');
  });

  it('returns null on division by zero — a day with no scheduled doses is not perfect adherence', () => {
    expect(divideDecimal(d('1'), d('0'), 4)).toBeNull();
    expect(divideDecimal(d('0'), d('0.000'), 4)).toBeNull();
  });

  it('rounds correctly at the boundary rather than truncating', () => {
    // 0.125 → 2 places. Exactly half, and half-even goes to the even digit.
    expect(formatDecimal(divideDecimal(d('1'), d('8'), 2) as Decimal)).toBe('0.12');
    expect(formatDecimal(divideDecimal(d('1'), d('8'), 2, 'half-up') as Decimal)).toBe('0.13');
    expect(formatDecimal(divideDecimal(d('1'), d('8'), 2, 'down') as Decimal)).toBe('0.12');
    // 0.375 → 2 places: the digit before the tie is odd, so half-even rounds up.
    expect(formatDecimal(divideDecimal(d('3'), d('8'), 2) as Decimal)).toBe('0.38');
  });

  /**
   * `%` takes the sign of the dividend, so a negative *divisor* points the
   * remainder the opposite way from the true fractional part. Getting this
   * wrong rounds the wrong direction and nothing errors.
   */
  it('rounds negative quotients away from zero, whichever operand carries the sign', () => {
    expect(formatDecimal(divideDecimal(d('-2'), d('3'), 4) as Decimal)).toBe('-0.6667');
    expect(formatDecimal(divideDecimal(d('2'), d('-3'), 4) as Decimal)).toBe('-0.6667');
    expect(formatDecimal(divideDecimal(d('-2'), d('-3'), 4) as Decimal)).toBe('0.6667');
  });

  it('rejects an unusable scale', () => {
    expect(divideDecimal(d('1'), d('3'), -1)).toBeNull();
    expect(divideDecimal(d('1'), d('3'), 5000)).toBeNull();
  });
});

describe('roundDecimal', () => {
  it('widens exactly', () => {
    expect(formatDecimal(roundDecimal(d('1.5'), 4))).toBe('1.5000');
  });

  it('implements half-even, half-up and down', () => {
    expect(formatDecimal(roundDecimal(d('2.5'), 0))).toBe('2');
    expect(formatDecimal(roundDecimal(d('3.5'), 0))).toBe('4');
    expect(formatDecimal(roundDecimal(d('2.5'), 0, 'half-up'))).toBe('3');
    expect(formatDecimal(roundDecimal(d('2.9'), 0, 'down'))).toBe('2');
    expect(formatDecimal(roundDecimal(d('-2.5'), 0))).toBe('-2');
    expect(formatDecimal(roundDecimal(d('-3.5'), 0))).toBe('-4');
    expect(formatDecimal(roundDecimal(d('-2.5'), 0, 'half-up'))).toBe('-3');
    expect(formatDecimal(roundDecimal(d('-2.9'), 0, 'down'))).toBe('-2');
  });

  /**
   * The reason half-even is the default. Rounding a year of half-cent ties the
   * same direction accumulates a visible bias; splitting them does not.
   */
  it('does not accumulate bias across many ties', () => {
    const ties = ['0.5', '1.5', '2.5', '3.5', '4.5', '5.5', '6.5', '7.5', '8.5', '9.5'];
    const even = ties.reduce((sum, t) => addDecimal(sum, roundDecimal(d(t), 0)), DECIMAL_ZERO);
    const up = ties.reduce((sum, t) => addDecimal(sum, roundDecimal(d(t), 0, 'half-up')), DECIMAL_ZERO);
    const exact = ties.reduce((sum, t) => addDecimal(sum, d(t)), DECIMAL_ZERO);

    expect(formatDecimal(exact)).toBe('50.0');
    expect(compareDecimal(even, exact)).toBe(0);
    expect(compareDecimal(up, exact)).toBe(1);
  });
});

describe('the numeric(20, 6) contract', () => {
  it('accepts values the column stores exactly', () => {
    expect(checkQuantityFit(d('74.2'))).toBeNull();
    expect(checkQuantityFit(d('0.000001'))).toBeNull();
    // Trailing zeros past the column's scale are not a loss.
    expect(checkQuantityFit(d('1.2000000000'))).toBeNull();
  });

  /**
   * Postgres *rounds* an over-scaled numeric silently and only errors on
   * over-precision. So without this check a seven-place dosage is accepted,
   * stored rounded, and read back as a different number, with no error anywhere.
   */
  it('rejects a value the column would silently round', () => {
    expect(checkQuantityFit(d('0.0000001'))).toBe('scale_exceeded');
    expect(checkQuantityFit(d('1.2345678'))).toBe('scale_exceeded');
  });

  it('rejects a value the column would reject', () => {
    expect(checkQuantityFit(d('1'.repeat(14)))).toBeNull();
    expect(checkQuantityFit(d('1'.repeat(15)))).toBe('precision_exceeded');
  });

  it('normalises to the column scale on the way out', () => {
    expect(toQuantityString(d('74.2'))).toBe('74.200000');
    expect(toQuantityString(d('0'))).toBe('0.000000');
    expect(toQuantityString(d('-1.5'))).toBe('-1.500000');
    expect(QUANTITY_SCALE).toBe(6);
  });
});
