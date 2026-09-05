/**
 * The money primitive — §5.3, in code.
 *
 * §5.3 fixes the representation and gives the reason in one line: "Integer
 * minor units plus an ISO-4217 code — never a float." `columns.ts` makes that
 * true of the database. This file makes it true of everything above the
 * database, which is the half that actually decides whether a total is right.
 *
 * ## Every amount is a bigint, and the argument is the same one §5.3 makes
 *
 * §5.3 rejects floats for measurement because "a rounding artifact in a
 * medication dosage is unacceptable". The identical argument holds for a
 * twenty-year spending record, and it is worse in one respect: a dosage error
 * is visible the moment someone reads the number, whereas an accumulated
 * half-paisa across forty thousand transactions is invisible by construction —
 * it never disagrees with itself, it just quietly stops matching the bank.
 *
 * `number` is not merely discouraged here, it is absent. There is no function
 * in this file that takes or returns an amount as a `number`, so no caller can
 * arrive at a float by accident. The only `number` this module produces is a
 * count of minor units per currency, which is an exponent rather than a
 * quantity of money.
 *
 * ## Two currencies never add
 *
 * There is no exchange rate anywhere in this system and there is not going to
 * be one: a rate is a fact about a moment, sourced from somewhere, revised
 * afterwards, and none of that infrastructure exists here. So adding ₹100 to
 * $100 is an error rather than a coercion. The alternative is a function that
 * returns a confident number that is wrong, which is the single worst thing a
 * finance module can do — a wrong total that announces itself is a bug, and a
 * wrong total that does not is a belief.
 *
 * The consequence is felt upward: {@link sumAmounts} of an empty set is `null`
 * rather than zero, because an empty set has no currency and picking one would
 * be a fabrication rather than a default.
 */

import type { Result } from '@naitikos/shared';
import { err, ok } from '@naitikos/shared';

import type { DomainError } from '../../errors/domain-error';
import { validationError } from '../../errors/domain-error';

/**
 * An amount of money. Minor units and the code they are denominated in.
 *
 * 1250 + 'INR' is ₹12.50. The pair travels together everywhere, because a bare
 * number is not a monetary value — a record that outlives a relocation will
 * hold both, and half of it is unreadable.
 */
export type Money = {
  readonly amountMinor: bigint;
  readonly currency: string;
};

/**
 * How many decimal places each currency's minor unit occupies.
 *
 * Deliberately short. This is the set the operator's record actually uses, and
 * a full ISO-4217 table would be a lookup nobody maintains — the entries that
 * matter are wrong in the same way whether the table has five rows or a
 * hundred and eighty. Add a currency when a transaction in it arrives.
 *
 * The exponents are the ISO-4217 ones and they are not all 2: JPY has no minor
 * unit at all, so ¥1250 is 1250 minor units and "12.50" is not a yen amount.
 */
export const MINOR_UNITS: Readonly<Record<string, number>> = Object.freeze({
  INR: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  JPY: 0,
});

/**
 * What an unlisted currency is assumed to have.
 *
 * Two, because the overwhelming majority of ISO-4217 currencies have two and a
 * wrong guess here is recoverable — the stored minor units are still integers,
 * and correcting the exponent later is a display change rather than a data
 * migration. Guessing zero would not be: it would silently multiply every
 * parsed amount by a hundred.
 */
export const DEFAULT_MINOR_UNITS = 2;

/** Currency symbols, where one is unambiguous enough to be worth using. */
const CURRENCY_SYMBOLS: Readonly<Record<string, string>> = Object.freeze({
  INR: '₹',
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
});

/** ISO-4217 is three letters. Anything else is not a currency code. */
const CURRENCY_PATTERN = /^[A-Za-z]{3}$/u;

/** An optionally signed decimal. No separators, no exponent, no spaces. */
const DECIMAL_PATTERN = /^[+-]?(\d+)(?:\.(\d+))?$/u;

/** Codes are compared and stored upper-cased, so 'inr' and 'INR' are one currency. */
function normaliseCurrency(currency: string): string {
  return currency.trim().toUpperCase();
}

/**
 * The minor-unit exponent for a currency, falling back to
 * {@link DEFAULT_MINOR_UNITS}.
 */
export function minorUnitsFor(currency: string): number {
  return MINOR_UNITS[normaliseCurrency(currency)] ?? DEFAULT_MINOR_UNITS;
}

/**
 * Parse a decimal string in **major** units into minor units.
 *
 * `parseAmount('12.50', 'INR')` is 1250 minor units; `parseAmount('1250',
 * 'INR')` is ₹1250, which is 125000. The input is what a person types or what
 * a statement prints, and both are major units.
 *
 * ## More precision than the currency has is rejected
 *
 * `'12.505'` in INR is refused rather than rounded. There is no third decimal
 * place in a rupee, so the string is a typo, a value in a different currency,
 * or a column the importer misread — and every one of those is better
 * surfaced than absorbed. Rounding it would make the import succeed and the
 * total wrong, which is the failure mode this whole module is arranged
 * against.
 *
 * Note what this means for JPY: it has no minor unit, so `'12.50'` is not a
 * yen amount and is refused on exactly the same rule.
 */
export function parseAmount(input: string, currency: string): Result<Money, DomainError> {
  const code = normaliseCurrency(currency);
  if (!CURRENCY_PATTERN.test(code)) {
    return err(
      validationError('amount_currency_invalid', 'A currency is a three-letter ISO-4217 code.'),
    );
  }

  const text = input.trim();
  const match = DECIMAL_PATTERN.exec(text);
  if (match === null) {
    /* No thousands separators, no currency symbols, no bare '-'. Cleaning the
     * string here would mean guessing whether '1,250' is one thousand two
     * hundred and fifty or one and a quarter — a guess that differs by
     * locale and would be made silently. The importer normalises; this
     * refuses. */
    return err(validationError('amount_not_numeric', 'An amount must be a plain decimal number.'));
  }

  const whole = match[1] ?? '0';
  const fraction = match[2] ?? '';
  const units = minorUnitsFor(code);

  if (fraction.length > units) {
    return err(
      validationError(
        'amount_precision_exceeded',
        `${code} has ${units} minor unit digits; the amount carries ${fraction.length}.`,
      ),
    );
  }

  const scaled = BigInt(whole + fraction.padEnd(units, '0'));
  const negative = text.startsWith('-');
  /* `-0.00` parses to 0n rather than to a negative zero, which bigint does not
   * have. That is the correct outcome and worth stating, because the same
   * expression on a float would not be. */
  return ok({ amountMinor: negative ? -scaled : scaled, currency: code });
}

/**
 * Render an amount for reading. Never a bare number.
 *
 * ₹12.50 where the symbol is known, `AED 12.50` where it is not. A figure with
 * no currency attached is the input to somebody's wrong assumption later, and
 * this system stores enough different currencies over enough years for that to
 * be a real risk rather than a theoretical one.
 *
 * Built by hand rather than through `Intl.NumberFormat`, for two reasons: a
 * bigint cannot be handed to it without a lossy conversion through `number`,
 * which is the exact thing this module exists to avoid; and its output varies
 * with the runtime's ICU build, so the same amount would render differently on
 * the server and in the browser.
 */
export function formatAmount(money: Money): string {
  const code = normaliseCurrency(money.currency);
  const units = minorUnitsFor(code);
  const negative = money.amountMinor < 0n;
  const magnitude = negative ? -money.amountMinor : money.amountMinor;

  const divisor = 10n ** BigInt(units);
  const whole = (magnitude / divisor).toString();
  const digits =
    units === 0 ? whole : `${whole}.${(magnitude % divisor).toString().padStart(units, '0')}`;

  const symbol = CURRENCY_SYMBOLS[code];
  const body = symbol === undefined ? `${code} ${digits}` : `${symbol}${digits}`;
  /* The sign leads, so `-₹12.50` and `-AED 12.50` read the same way round. */
  return negative ? `-${body}` : body;
}

/**
 * Add two amounts of the same currency.
 *
 * A mismatch is an error, not a conversion. See the module note: there is no
 * rate in this system, and inventing one would produce a total that is wrong
 * without ever looking wrong.
 */
export function addAmounts(a: Money, b: Money): Result<Money, DomainError> {
  const left = normaliseCurrency(a.currency);
  const right = normaliseCurrency(b.currency);
  if (left !== right) {
    return err(
      validationError(
        'amount_currency_mismatch',
        `Cannot add ${left} to ${right}. This system holds no exchange rates.`,
      ),
    );
  }
  return ok({ amountMinor: a.amountMinor + b.amountMinor, currency: left });
}

/**
 * Total a set of amounts, or `null` when the set is empty.
 *
 * `null` rather than a zero, because a zero would need a currency and there is
 * none to be had — "₹0.00" from an empty list is a claim about rupees that
 * nothing in the input supports. The caller that wanted a zero knows which
 * currency it wanted it in; this function does not.
 */
export function sumAmounts(values: readonly Money[]): Result<Money | null, DomainError> {
  const first = values[0];
  if (first === undefined) return ok(null);

  const currency = normaliseCurrency(first.currency);
  let total = 0n;
  for (const value of values) {
    if (normaliseCurrency(value.currency) !== currency) {
      return err(
        validationError(
          'amount_currency_mismatch',
          `Cannot total ${currency} with ${normaliseCurrency(value.currency)}. This system holds no exchange rates.`,
        ),
      );
    }
    total += value.amountMinor;
  }
  return ok({ amountMinor: total, currency });
}

/** The same amount, the other way round. Used wherever a liability subtracts. */
export function negate(money: Money): Money {
  return { amountMinor: -money.amountMinor, currency: money.currency };
}

/**
 * Whether this is money leaving.
 *
 * The schema states the convention once — "negative is money leaving" — and
 * this is the only place the application is allowed to know it. Every
 * `< 0` written at a call site is a chance for one of them to be `<=` or to be
 * backwards, and a spending total with the sign inverted is a plausible number.
 */
export function isOutflow(money: Money): boolean {
  return money.amountMinor < 0n;
}
