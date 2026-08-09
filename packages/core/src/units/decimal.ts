/**
 * Exact decimal arithmetic.
 *
 * §5.3: "No floats for weight, dosage, or lab values. A rounding artifact in a
 * medication dosage is unacceptable." The database honours that with `numeric`
 * columns read and written as strings ({@link file://../../../db/src/schema/columns.ts}).
 * This file is the other half — the part that lets the application *compute*
 * with those strings without ever passing them through a JS `number`.
 *
 * ## The representation
 *
 * A decimal is an arbitrary-precision integer plus a scale: `1.250` is
 * `{ unscaled: 1250n, scale: 3 }`. Two consequences worth stating up front.
 *
 * **Scale is significant and preserved.** `1.250` and `1.25` are *equal*
 * (`compareDecimal` returns 0) but not *identical* — the first records a
 * measurement to three places and the second to two. A scale that renormalised
 * would silently claim a precision the instrument did not have, which in a lab
 * value is a real misstatement.
 *
 * **`bigint`, not `number`.** A double holds 15–16 significant digits. That is
 * enough for a bodyweight and not enough for the twenty-digit `numeric(20,6)`
 * the schema declares, so the boundary would leak exactly at the values that
 * matter least often and are hardest to notice.
 *
 * ## What this deliberately is not
 *
 * Not a general-purpose decimal library. There is no `pow`, no `sqrt`, no
 * transcendental anything, and division is not closed — {@link divideDecimal}
 * demands an explicit result scale because `1/3` has no exact decimal form and
 * silently picking a precision for the caller is how rounding bugs start.
 *
 * A dependency was the obvious alternative (`decimal.js`, `big.js`). Rejected on
 * C2: this is roughly 200 lines of arithmetic that must still work in 2046, and
 * a package that must still install in 2046 is the larger liability.
 */

/* -------------------------------------------------------------------------
 * The type
 * ---------------------------------------------------------------------- */

export type Decimal = {
  /** The value with the decimal point removed. `1.25` → `125n`. */
  readonly unscaled: bigint;
  /** Digits after the point. Always `>= 0`. `1.25` → `2`. */
  readonly scale: number;
};

/** How a value that does not fit the target scale is resolved. */
export type RoundingMode =
  /** Ties to the nearest even digit. The default, and why is at {@link roundDecimal}. */
  | 'half-even'
  /** Ties away from zero — what a person means by "round it". */
  | 'half-up'
  /** Truncate toward zero. Never a default; discards magnitude silently. */
  | 'down';

/**
 * The scale of the `quantity()` column — `numeric(20, 6)`.
 *
 * Exported because the write path checks against it. A value the application
 * accepts and Postgres then rounds is a value the record does not actually
 * hold, and finding that out from a chart three years later is not a fair
 * outcome.
 */
export const QUANTITY_SCALE = 6;

/** Total significant digits of the `quantity()` column. */
export const QUANTITY_PRECISION = 20;

/**
 * Input limits, applied during parsing.
 *
 * These are a denial-of-service guard, not a modelling decision. `parseDecimal`
 * runs on request bodies (§5.14 treats every input as hostile), and
 * `1e2000000000` is four bytes of JSON that asks for a two-gigabyte `bigint`.
 * The ceilings sit far above any real measurement — 1000 digits is more than
 * enough for `numeric(20,6)` with room for intermediate products.
 */
const MAX_INPUT_DIGITS = 1000;
const MAX_INPUT_SCALE = 1000;

export const DECIMAL_ZERO: Decimal = { unscaled: 0n, scale: 0 };
export const DECIMAL_ONE: Decimal = { unscaled: 1n, scale: 0 };

/* -------------------------------------------------------------------------
 * Powers of ten
 * ---------------------------------------------------------------------- */

const POW10_CACHE: bigint[] = [1n];

/** `10n ** n`, memoised. Called on every scale alignment, so it is worth it. */
function pow10(n: number): bigint {
  if (n < 0) throw new RangeError(`pow10 requires a non-negative exponent, got ${String(n)}`);

  const cached = POW10_CACHE[n];
  if (cached !== undefined) return cached;

  // Carried in a local rather than read back out of the array each iteration,
  // which is both faster and avoids an index access the compiler cannot prove
  // is populated (`noUncheckedIndexedAccess`).
  let value = POW10_CACHE[POW10_CACHE.length - 1] ?? 1n;
  for (let i = POW10_CACHE.length; i <= n; i += 1) {
    value *= 10n;
    POW10_CACHE[i] = value;
  }
  return value;
}

/* -------------------------------------------------------------------------
 * Construction
 * ---------------------------------------------------------------------- */

/**
 * Parse a decimal string. Returns `null` rather than throwing, because the
 * overwhelmingly common caller is validating untrusted input and a `null` it
 * must handle is safer than an exception it might not.
 *
 * Accepts what Postgres `numeric` accepts, minus the special values: an
 * optional sign, digits, an optional fraction, an optional exponent. `NaN` and
 * `Infinity` are rejected on purpose — a measurement is never either, and
 * admitting them would put a non-comparable value into a column the timeline
 * sorts on.
 */
export function parseDecimal(text: string): Decimal | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;

  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(trimmed);
  if (match === null) return null;

  const [, sign = '', integerPart = '', fractionPart = '', exponentPart] = match;

  // `.` alone matches the regex above but is not a number.
  if (integerPart === '' && fractionPart === '') return null;
  if (integerPart.length + fractionPart.length > MAX_INPUT_DIGITS) return null;

  let scale = fractionPart.length;
  let unscaled = BigInt(`${integerPart}${fractionPart}` === '' ? '0' : `${integerPart}${fractionPart}`);

  if (exponentPart !== undefined) {
    const exponent = Number(exponentPart);
    // `Number` on a bounded digit string cannot be NaN; the range check is the
    // point. An exponent outside this window is the DoS case above.
    if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > MAX_INPUT_SCALE) return null;
    scale -= exponent;
    if (scale < 0) {
      unscaled *= pow10(-scale);
      scale = 0;
    }
    if (scale > MAX_INPUT_SCALE) return null;
  }

  return { unscaled: sign === '-' ? -unscaled : unscaled, scale };
}

/**
 * Build a decimal from a safe integer.
 *
 * The only sanctioned entry point from `number`, and it is narrow deliberately:
 * a 1–5 tap in the Daily Close and a repetition count are genuinely integers,
 * and forcing those through string formatting would be ceremony. Anything
 * fractional must arrive as a string, because by the time a fraction is a
 * `number` the rounding has already happened.
 */
export function decimalFromInteger(value: number): Decimal | null {
  if (!Number.isSafeInteger(value)) return null;
  return { unscaled: BigInt(value), scale: 0 };
}

/** Build a decimal from an unscaled integer and an explicit scale. */
export function decimalFromUnscaled(unscaled: bigint, scale: number): Decimal | null {
  if (!Number.isSafeInteger(scale) || scale < 0 || scale > MAX_INPUT_SCALE) return null;
  return { unscaled, scale };
}

/* -------------------------------------------------------------------------
 * Formatting
 * ---------------------------------------------------------------------- */

export type FormatOptions = {
  /**
   * Drop trailing fractional zeros. **Display only.**
   *
   * `74.200000` reads as noise on a dashboard, so the UI trims it. Nothing that
   * writes to the database or to an export may trim, because the zeros are the
   * record of how precisely the value was known (§9.10's self-describing
   * requirement is about exactly this kind of detail).
   */
  readonly trim?: boolean;
};

/** Canonical string form. Round-trips through {@link parseDecimal} unchanged. */
export function formatDecimal(value: Decimal, options: FormatOptions = {}): string {
  const negative = value.unscaled < 0n;
  const digits = (negative ? -value.unscaled : value.unscaled).toString();

  let result: string;
  if (value.scale === 0) {
    result = digits;
  } else {
    const padded = digits.padStart(value.scale + 1, '0');
    const cut = padded.length - value.scale;
    result = `${padded.slice(0, cut)}.${padded.slice(cut)}`;
  }

  if (options.trim === true && result.includes('.')) {
    result = result.replace(/\.?0+$/, '');
    if (result === '' || result === '-') result = '0';
  }

  // `-0` is a float concept. It has no place in an exact decimal, and letting it
  // through would make two equal values format differently.
  return negative && result !== '0' ? `-${result}` : result;
}

/* -------------------------------------------------------------------------
 * Comparison
 * ---------------------------------------------------------------------- */

/** Align two decimals to a common scale without losing information. */
function align(a: Decimal, b: Decimal): { readonly a: bigint; readonly b: bigint; readonly scale: number } {
  const scale = Math.max(a.scale, b.scale);
  return {
    a: a.unscaled * pow10(scale - a.scale),
    b: b.unscaled * pow10(scale - b.scale),
    scale,
  };
}

/**
 * Three-way comparison by *value*, ignoring scale: `1.50` compares equal to
 * `1.5`.
 *
 * Note that this is not the same relation as structural equality, which is why
 * there is no `equalsDecimal` that a caller might reach for by reflex. Use
 * `compareDecimal(a, b) === 0`.
 */
export function compareDecimal(a: Decimal, b: Decimal): -1 | 0 | 1 {
  const { a: left, b: right } = align(a, b);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function isZero(value: Decimal): boolean {
  return value.unscaled === 0n;
}

/** `-1`, `0`, or `1`. */
export function signOf(value: Decimal): -1 | 0 | 1 {
  if (value.unscaled < 0n) return -1;
  if (value.unscaled > 0n) return 1;
  return 0;
}

export function minDecimal(a: Decimal, b: Decimal): Decimal {
  return compareDecimal(a, b) <= 0 ? a : b;
}

export function maxDecimal(a: Decimal, b: Decimal): Decimal {
  return compareDecimal(a, b) >= 0 ? a : b;
}

/* -------------------------------------------------------------------------
 * Arithmetic
 *
 * Addition, subtraction and multiplication are exact and therefore total: the
 * result scale is determined by the operands, never chosen. Division is not,
 * and says so in its signature.
 * ---------------------------------------------------------------------- */

export function addDecimal(a: Decimal, b: Decimal): Decimal {
  const { a: left, b: right, scale } = align(a, b);
  return { unscaled: left + right, scale };
}

export function subtractDecimal(a: Decimal, b: Decimal): Decimal {
  const { a: left, b: right, scale } = align(a, b);
  return { unscaled: left - right, scale };
}

export function multiplyDecimal(a: Decimal, b: Decimal): Decimal {
  return { unscaled: a.unscaled * b.unscaled, scale: a.scale + b.scale };
}

export function negateDecimal(value: Decimal): Decimal {
  return { unscaled: -value.unscaled, scale: value.scale };
}

export function absDecimal(value: Decimal): Decimal {
  return value.unscaled < 0n ? negateDecimal(value) : value;
}

/**
 * Divide, to an explicit scale.
 *
 * The scale parameter is not a convenience — it is the signature refusing to
 * hide a decision. `1 ÷ 3` has no exact decimal form, so *somebody* chooses how
 * many places survive, and the caller is the only one who knows whether this is
 * an adherence ratio (3 places is generous) or a unit conversion feeding a
 * dosage (where the answer is: do not round here at all, carry it further).
 *
 * Returns `null` on division by zero. Adherence with zero scheduled doses is a
 * real case — §9.2 is emphatic that a day with nothing scheduled is not a day
 * with perfect adherence — so this returns an absence rather than throwing.
 */
export function divideDecimal(
  a: Decimal,
  b: Decimal,
  scale: number,
  mode: RoundingMode = 'half-even',
): Decimal | null {
  if (b.unscaled === 0n) return null;
  if (!Number.isSafeInteger(scale) || scale < 0 || scale > MAX_INPUT_SCALE) return null;

  /*
   * Compute one extra digit, then round it away. Dividing straight to `scale`
   * truncates, and truncation is not a rounding mode anybody asked for — it
   * would make `half-even` and `half-up` behave identically and wrongly.
   */
  const shift = scale + 1 + b.scale - a.scale;
  const numerator = shift >= 0 ? a.unscaled * pow10(shift) : a.unscaled;
  const denominator = shift >= 0 ? b.unscaled : b.unscaled * pow10(-shift);

  const guarded: Decimal = { unscaled: numerator / denominator, scale: scale + 1 };

  /*
   * `bigint` division truncates toward zero, which discards the "is there
   * anything left over?" bit that separates *exactly* half from *just above*
   * half — and those two round differently under `half-even`.
   *
   * Appending a single non-zero digit past the guard restores it. The digit's
   * sign must follow the **quotient**, not the remainder: `%` takes the sign of
   * the dividend, so with a negative divisor the remainder points the opposite
   * way from the true fractional part and the nudge would round the wrong way.
   */
  const remainder = numerator % denominator;
  const fractionIsNegative = remainder < 0n !== denominator < 0n; // signs differ
  const nudged: Decimal =
    remainder === 0n
      ? guarded
      : { unscaled: guarded.unscaled * 10n + (fractionIsNegative ? -1n : 1n), scale: scale + 2 };

  return roundDecimal(nudged, scale, mode);
}

/* -------------------------------------------------------------------------
 * Rescaling
 * ---------------------------------------------------------------------- */

/**
 * Change the scale, rounding if digits must be discarded.
 *
 * `half-even` is the default because these values are summed. Half-up biases
 * every tie in the same direction, so a year of rounded daily figures drifts
 * upward by a predictable amount; half-even splits ties and the bias cancels.
 * That is the reason it is the IEEE default and the reason it belongs on a
 * record meant to be aggregated over decades (C2).
 */
export function roundDecimal(value: Decimal, scale: number, mode: RoundingMode = 'half-even'): Decimal {
  if (scale === value.scale) return value;
  if (scale > value.scale) {
    // Widening is exact: append zeros.
    return { unscaled: value.unscaled * pow10(scale - value.scale), scale };
  }

  const divisor = pow10(value.scale - scale);
  const quotient = value.unscaled / divisor;
  const remainder = value.unscaled % divisor;
  if (remainder === 0n) return { unscaled: quotient, scale };

  const negative = value.unscaled < 0n;
  const twice = (remainder < 0n ? -remainder : remainder) * 2n;

  let away: boolean;
  if (mode === 'down') {
    away = false;
  } else if (twice > divisor) {
    away = true;
  } else if (twice < divisor) {
    away = false;
  } else {
    // Exactly half.
    away = mode === 'half-up' || (mode === 'half-even' && quotient % 2n !== 0n);
  }

  return { unscaled: away ? quotient + (negative ? -1n : 1n) : quotient, scale };
}

/* -------------------------------------------------------------------------
 * The column contract
 * ---------------------------------------------------------------------- */

/** Why a value cannot be stored in a `quantity()` column. */
export type QuantityFitFailure = 'scale_exceeded' | 'precision_exceeded';

/**
 * Whether this value survives a round trip through `numeric(20, 6)` unchanged.
 *
 * Called on the write path, and the failure it prevents is specific: Postgres
 * *rounds* an over-scaled numeric silently and only *errors* on over-precision.
 * So without this check, a seven-decimal-place dosage would be accepted, stored
 * rounded, and read back as a different number than the one submitted — with no
 * error anywhere. That is the exact failure §5.3 is written to prevent.
 */
export function checkQuantityFit(value: Decimal): QuantityFitFailure | null {
  if (value.scale > QUANTITY_SCALE) {
    // Trailing zeros beyond the column's scale are not information; only a
    // non-zero digit out there is an actual loss.
    const rounded = roundDecimal(value, QUANTITY_SCALE, 'down');
    if (compareDecimal(rounded, value) !== 0) return 'scale_exceeded';
  }

  const digits = absDecimal(value).unscaled.toString().length;
  const integerDigits = Math.max(digits - value.scale, 0);
  if (integerDigits + QUANTITY_SCALE > QUANTITY_PRECISION) return 'precision_exceeded';

  return null;
}

/**
 * The exact string to send to a `quantity()` column.
 *
 * Normalised to the column's scale so that what the application holds and what
 * Postgres holds are the same number of digits. Without this, an in-memory
 * `1.5` and a read-back `1.500000` differ under string comparison, and string
 * comparison of numerics is a mistake somebody makes eventually.
 */
export function toQuantityString(value: Decimal): string {
  return formatDecimal(roundDecimal(value, QUANTITY_SCALE, 'half-even'));
}
