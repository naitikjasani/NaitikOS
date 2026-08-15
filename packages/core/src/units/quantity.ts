/**
 * The unit system. `Quantity`, never a bare number.
 *
 * §6.2 does not hedge about why this exists:
 *
 *   "Unit confusion in a medical record is a real, documented category of harm.
 *    Every measured quantity is a `Quantity { value: Decimal, unit: Unit }`,
 *    never a bare number, and conversion is total and tested. There is no path
 *    by which milligrams become micrograms."
 *
 * ## How "no path" is actually achieved
 *
 * Three properties, and all three are needed:
 *
 * 1. **Every unit carries a dimension.** {@link convertQuantity} returns `null`
 *    across dimensions rather than guessing, so `kg → hours` is a handled
 *    absence and not a plausible-looking number.
 * 2. **Every factor is an exact {@link Decimal}.** `lb → g` is 453.59237
 *    exactly, not a float that is 453.59236999999997 on some engines.
 * 3. **Conversion never rounds.** The result carries whatever scale the exact
 *    arithmetic produced. Rounding is a presentation decision, and a converter
 *    that rounds is a converter that loses a microgram somewhere.
 *
 * ## Molar and mass concentration are separate dimensions, on purpose
 *
 * mmol/L and mg/dL both describe "how much of this is in the blood", and the
 * conversion between them depends on the molar mass of the specific analyte —
 * so there is no substance-independent factor to register. Filing them under
 * one dimension would let the generic converter produce a number for
 * `glucose mg/dL → mmol/L` using whatever factor happened to be in the table,
 * which is precisely the class of error §6.2 names.
 *
 * They are therefore different dimensions, the generic converter refuses them,
 * and {@link convertConcentration} exists for the case where the analyte is
 * known. Refusing to answer is the correct behaviour when the question is
 * underspecified.
 */

import {
  type Decimal,
  type RoundingMode,
  compareDecimal,
  divideDecimal,
  formatDecimal,
  multiplyDecimal,
  parseDecimal,
  roundDecimal,
  subtractDecimal,
  addDecimal,
} from './decimal';

/* -------------------------------------------------------------------------
 * Dimensions and units
 * ---------------------------------------------------------------------- */

export type Dimension =
  | 'mass'
  | 'length'
  | 'time'
  | 'volume'
  | 'energy'
  | 'temperature'
  | 'pressure'
  /**
   * Events per unit time. Deliberately holds exactly one unit.
   *
   * Heart rate and respiratory rate are both counts per minute, which makes
   * them look convertible — and `convertQuantity` converts freely inside a
   * dimension. Sixty beats per minute silently becoming sixty breaths per
   * minute is not a rounding error, it is a fabricated vital sign. So this
   * dimension has one member, and a second rate unit requires its own
   * dimension and a deliberate decision rather than another row in the table.
   */
  | 'rate'
  /**
   * International units per volume. One member, like `rate`.
   *
   * An international unit is a substance-specific amount fixed by convention:
   * IU of one analyte never converts into IU of another, and never into mass at
   * all. So there is nothing for a second member of this dimension to convert
   * *to*, and the only reason one looked necessary is `mIU/L` — which is not a
   * second unit. 1 µIU/mL **is** 1 mIU/L, exactly, which makes it a second
   * spelling. It is handled where spellings belong, in
   * `domain/health/analyte.ts`'s `normaliseUnit`, so the registry keeps its
   * "exactly one base unit per dimension" invariant and every stored TSH shares
   * one unit code (§6.2).
   */
  | 'iu_concentration'
  /** A pure proportion — adherence, body-fat percentage. */
  | 'ratio'
  /** Things that are counted, not measured: reps, lesions, doses. */
  | 'count'
  /** Amount of substance per volume, molar. mmol/L, nmol/L. */
  | 'concentration_molar'
  /** Amount of substance per volume, by mass. mg/dL, ng/mL. */
  | 'concentration_mass'
  /**
   * Unitless by construction — the 1–5 scales, RPE.
   *
   * Not the same as `ratio`. A mood of 4 is an ordinal position on a scale
   * somebody invented; 0.8 adherence is a real proportion. Averaging the first
   * is a convention and averaging the second is arithmetic, and keeping them in
   * separate dimensions stops a chart from treating them alike.
   */
  | 'scalar';

/**
 * A registered unit code. These strings are the ones stored in
 * `observation.unit` and `metric.canonicalUnit`, so they are permanent — a
 * renamed code is a data migration, not a refactor.
 */
export type UnitCode =
  | 'mcg' | 'mg' | 'g' | 'kg' | 'lb' | 'oz'
  | 'mm' | 'cm' | 'm' | 'in' | 'ft'
  | 'milliseconds' | 'seconds' | 'minutes' | 'hours' | 'days'
  | 'mL' | 'L' | 'fl_oz'
  | 'kJ' | 'kcal'
  | 'celsius' | 'fahrenheit'
  | 'mmHg'
  | 'bpm'
  | 'uIU/mL'
  | 'ratio' | 'percent'
  | 'count'
  | 'mmol/L' | 'umol/L' | 'nmol/L'
  | 'mg/dL' | 'mg/L' | 'ug/dL' | 'ng/mL'
  /** The empty code. `metric.canonicalUnit` uses `''` for unitless scales. */
  | '';

export type UnitDefinition = {
  readonly code: UnitCode;
  readonly dimension: Dimension;
  /** For a person: "kilograms". */
  readonly displayName: string;
  /** For a chart axis: "kg". Short, and not necessarily unique across dimensions. */
  readonly symbol: string;
  /**
   * The conversion to this dimension's base unit:
   *
   * ```
   * base = (value − zeroOffset) × toBase ÷ toBaseDivisor
   * ```
   *
   * A **ratio**, not a single factor, because 5/9 has no exact decimal form and
   * a ten-digit approximation of it is a lie that compounds. Carrying numerator
   * and denominator separately keeps `212 °F → 100 °C` exact rather than
   * 100.0000000094.
   *
   * `toBaseDivisor` is omitted (implicitly 1) for every unit but Fahrenheit,
   * and {@link convertQuantity} skips the division entirely in that case so
   * ordinary conversions keep their natural scale.
   */
  readonly toBase: Decimal;
  /** Denominator of the factor above. Defaults to 1. */
  readonly toBaseDivisor?: Decimal;
  /**
   * The value *in this unit* that corresponds to zero in the base unit —
   * 32 for Fahrenheit, absent everywhere else.
   *
   * Every other unit here is a ratio scale where zero means none. The
   * distinction is not pedantry: a 2 °C *rise* is not the same kind of quantity
   * as a 2 °C *reading*, and converting the first with the offset applied gives
   * −16.7 °F for what is really 3.6 °F. Differences go through
   * {@link convertTemperatureDelta}.
   */
  readonly zeroOffset?: Decimal;
};

/** Non-null: every literal below is a valid decimal, checked by the test suite. */
function exact(text: string): Decimal {
  const parsed = parseDecimal(text);
  if (parsed === null) throw new Error(`unit factor is not a decimal: ${text}`);
  return parsed;
}

/**
 * The registry.
 *
 * Base unit per dimension, chosen so that every factor in the table is exact:
 * mass → g, length → cm, time → seconds, volume → mL, energy → kJ (because
 * 1 kcal = 4.184 kJ exactly, whereas the inverse is not), temperature → °C,
 * pressure → mmHg, ratio → ratio, count → count, scalar → ''.
 */
export const UNITS: Readonly<Record<UnitCode, UnitDefinition>> = {
  /* --- mass, base gram ------------------------------------------------ */
  mcg: { code: 'mcg', dimension: 'mass', displayName: 'micrograms', symbol: 'µg', toBase: exact('0.000001') },
  mg: { code: 'mg', dimension: 'mass', displayName: 'milligrams', symbol: 'mg', toBase: exact('0.001') },
  g: { code: 'g', dimension: 'mass', displayName: 'grams', symbol: 'g', toBase: exact('1') },
  kg: { code: 'kg', dimension: 'mass', displayName: 'kilograms', symbol: 'kg', toBase: exact('1000') },
  lb: { code: 'lb', dimension: 'mass', displayName: 'pounds', symbol: 'lb', toBase: exact('453.59237') },
  oz: { code: 'oz', dimension: 'mass', displayName: 'ounces', symbol: 'oz', toBase: exact('28.349523125') },

  /* --- length, base centimetre ---------------------------------------- */
  mm: { code: 'mm', dimension: 'length', displayName: 'millimetres', symbol: 'mm', toBase: exact('0.1') },
  cm: { code: 'cm', dimension: 'length', displayName: 'centimetres', symbol: 'cm', toBase: exact('1') },
  m: { code: 'm', dimension: 'length', displayName: 'metres', symbol: 'm', toBase: exact('100') },
  in: { code: 'in', dimension: 'length', displayName: 'inches', symbol: 'in', toBase: exact('2.54') },
  ft: { code: 'ft', dimension: 'length', displayName: 'feet', symbol: 'ft', toBase: exact('30.48') },

  /* --- time, base second ---------------------------------------------- */
  milliseconds: { code: 'milliseconds', dimension: 'time', displayName: 'milliseconds', symbol: 'ms', toBase: exact('0.001') },
  seconds: { code: 'seconds', dimension: 'time', displayName: 'seconds', symbol: 's', toBase: exact('1') },
  minutes: { code: 'minutes', dimension: 'time', displayName: 'minutes', symbol: 'min', toBase: exact('60') },
  hours: { code: 'hours', dimension: 'time', displayName: 'hours', symbol: 'h', toBase: exact('3600') },
  days: { code: 'days', dimension: 'time', displayName: 'days', symbol: 'd', toBase: exact('86400') },

  /* --- volume, base millilitre ---------------------------------------- */
  mL: { code: 'mL', dimension: 'volume', displayName: 'millilitres', symbol: 'mL', toBase: exact('1') },
  L: { code: 'L', dimension: 'volume', displayName: 'litres', symbol: 'L', toBase: exact('1000') },
  fl_oz: { code: 'fl_oz', dimension: 'volume', displayName: 'fluid ounces', symbol: 'fl oz', toBase: exact('29.5735295625') },

  /* --- energy, base kilojoule ----------------------------------------- */
  kJ: { code: 'kJ', dimension: 'energy', displayName: 'kilojoules', symbol: 'kJ', toBase: exact('1') },
  kcal: { code: 'kcal', dimension: 'energy', displayName: 'kilocalories', symbol: 'kcal', toBase: exact('4.184') },

  /* --- temperature, base celsius (affine) ------------------------------ */
  celsius: { code: 'celsius', dimension: 'temperature', displayName: 'degrees Celsius', symbol: '°C', toBase: exact('1') },
  fahrenheit: {
    code: 'fahrenheit',
    dimension: 'temperature',
    displayName: 'degrees Fahrenheit',
    symbol: '°F',
    // °C = (°F − 32) × 5 ÷ 9. Exact, in both directions.
    toBase: exact('5'),
    toBaseDivisor: exact('9'),
    zeroOffset: exact('32'),
  },

  /* --- pressure -------------------------------------------------------- */
  mmHg: { code: 'mmHg', dimension: 'pressure', displayName: 'millimetres of mercury', symbol: 'mmHg', toBase: exact('1') },

  /* --- rate (one member, on purpose — see the `rate` dimension) --------- */
  bpm: { code: 'bpm', dimension: 'rate', displayName: 'beats per minute', symbol: 'bpm', toBase: exact('1') },

  /* --- international units per volume (base µIU/mL) --------------------- */
  'uIU/mL': { code: 'uIU/mL', dimension: 'iu_concentration', displayName: 'micro-international units per millilitre', symbol: 'µIU/mL', toBase: exact('1') },

  /* --- proportion ------------------------------------------------------ */
  ratio: { code: 'ratio', dimension: 'ratio', displayName: 'ratio', symbol: '', toBase: exact('1') },
  percent: { code: 'percent', dimension: 'ratio', displayName: 'percent', symbol: '%', toBase: exact('0.01') },

  /* --- counting -------------------------------------------------------- */
  count: { code: 'count', dimension: 'count', displayName: 'count', symbol: '', toBase: exact('1') },

  /* --- concentration, molar (base mmol/L) ------------------------------ */
  'mmol/L': { code: 'mmol/L', dimension: 'concentration_molar', displayName: 'millimoles per litre', symbol: 'mmol/L', toBase: exact('1') },
  'umol/L': { code: 'umol/L', dimension: 'concentration_molar', displayName: 'micromoles per litre', symbol: 'µmol/L', toBase: exact('0.001') },
  'nmol/L': { code: 'nmol/L', dimension: 'concentration_molar', displayName: 'nanomoles per litre', symbol: 'nmol/L', toBase: exact('0.000001') },

  /* --- concentration, mass (base mg/L) --------------------------------- */
  'mg/L': { code: 'mg/L', dimension: 'concentration_mass', displayName: 'milligrams per litre', symbol: 'mg/L', toBase: exact('1') },
  'mg/dL': { code: 'mg/dL', dimension: 'concentration_mass', displayName: 'milligrams per decilitre', symbol: 'mg/dL', toBase: exact('10') },
  'ug/dL': { code: 'ug/dL', dimension: 'concentration_mass', displayName: 'micrograms per decilitre', symbol: 'µg/dL', toBase: exact('0.01') },
  'ng/mL': { code: 'ng/mL', dimension: 'concentration_mass', displayName: 'nanograms per millilitre', symbol: 'ng/mL', toBase: exact('0.001') },

  /* --- unitless -------------------------------------------------------- */
  '': { code: '', dimension: 'scalar', displayName: 'unitless', symbol: '', toBase: exact('1') },
};

export const UNIT_CODES = Object.keys(UNITS) as readonly UnitCode[];

export function isUnitCode(value: string): value is UnitCode {
  return Object.hasOwn(UNITS, value);
}

/** The registered definition, or `null` for a code this system does not know. */
export function unitDefinition(code: string): UnitDefinition | null {
  return isUnitCode(code) ? UNITS[code] : null;
}

/* -------------------------------------------------------------------------
 * Quantity
 * ---------------------------------------------------------------------- */

export type Quantity = {
  readonly value: Decimal;
  readonly unit: UnitCode;
};

/** Build a quantity from a decimal string. `null` if either half is invalid. */
export function quantity(value: string, unit: string): Quantity | null {
  const parsed = parseDecimal(value);
  if (parsed === null || !isUnitCode(unit)) return null;
  return { value: parsed, unit };
}

export function dimensionOf(q: Quantity): Dimension {
  return UNITS[q.unit].dimension;
}

/** `"74.2 kg"`. Trims trailing zeros — display only, per {@link formatDecimal}. */
export function formatQuantity(q: Quantity): string {
  const symbol = UNITS[q.unit].symbol;
  const number = formatDecimal(q.value, { trim: true });
  return symbol === '' ? number : `${number} ${symbol}`;
}

/* -------------------------------------------------------------------------
 * Conversion
 * ---------------------------------------------------------------------- */

/**
 * Working scale for the divisions inside a conversion.
 *
 * Twelve places, against a column that stores six. The headroom is the point:
 * rounding once at storage is a defensible loss, rounding at every intermediate
 * step compounds, and a dosage that has been through two conversions should not
 * be further from the truth than one that has been through one.
 */
const CONVERSION_SCALE = 12;

const ONE: Decimal = { unscaled: 1n, scale: 0 };

function isOne(value: Decimal): boolean {
  return compareDecimal(value, ONE) === 0;
}

/**
 * The same unit with its affine offset removed.
 *
 * Built by omission rather than by assigning `undefined`, because
 * `exactOptionalPropertyTypes` distinguishes "absent" from "present and
 * undefined" — and here the distinction is the whole mechanism.
 */
function asRatioScale(unit: UnitDefinition): UnitDefinition {
  const { zeroOffset: _dropped, ...rest } = unit;
  return rest;
}

/**
 * Strip trailing zeros introduced by the conversion machinery, but never below
 * the scale the caller supplied.
 *
 * Scale is significant everywhere else in this module, so removing digits needs
 * a justification. It is this: the zeros on `1000.000000000000 g` were produced
 * by {@link divideDecimal}'s fixed working scale, not by a measurement, and
 * presenting them as precision would be the same misstatement in the opposite
 * direction. The input's own scale is the floor, so `1.5 kg → 1500.0 g` keeps
 * the one place the reading actually had.
 */
function settleScale(value: Decimal, minimumScale: number): Decimal {
  let result = value;
  while (result.scale > minimumScale && result.unscaled % 10n === 0n) {
    result = { unscaled: result.unscaled / 10n, scale: result.scale - 1 };
  }
  return result;
}

/** `(value − zeroOffset) × toBase ÷ toBaseDivisor`, skipping the exact steps. */
function toBaseUnit(value: Decimal, unit: UnitDefinition): Decimal | null {
  const shifted = unit.zeroOffset === undefined ? value : subtractDecimal(value, unit.zeroOffset);
  const scaled = isOne(unit.toBase) ? shifted : multiplyDecimal(shifted, unit.toBase);
  if (unit.toBaseDivisor === undefined || isOne(unit.toBaseDivisor)) return scaled;
  return divideDecimal(scaled, unit.toBaseDivisor, CONVERSION_SCALE);
}

/** The inverse: `base × toBaseDivisor ÷ toBase + zeroOffset`. */
function fromBaseUnit(base: Decimal, unit: UnitDefinition): Decimal | null {
  const widened =
    unit.toBaseDivisor === undefined || isOne(unit.toBaseDivisor)
      ? base
      : multiplyDecimal(base, unit.toBaseDivisor);
  const scaled = isOne(unit.toBase) ? widened : divideDecimal(widened, unit.toBase, CONVERSION_SCALE);
  if (scaled === null) return null;
  return unit.zeroOffset === undefined ? scaled : addDecimal(scaled, unit.zeroOffset);
}

/**
 * Convert between units of the same dimension. `null` across dimensions.
 *
 * Exact wherever the ratio permits it — `212 °F → 100 °C` and `1 lb → 453.59237 g`
 * both come back with no residue. Where it does not (`1 g → 0.03527396195 oz`)
 * the result carries {@link CONVERSION_SCALE} places, which is well beyond what
 * the column stores.
 *
 * **Not valid for temperature *differences*.** See {@link convertTemperatureDelta}.
 */
export function convertQuantity(q: Quantity, target: UnitCode): Quantity | null {
  const from = UNITS[q.unit];
  const to = UNITS[target];
  if (from.dimension !== to.dimension) return null;
  if (q.unit === target) return q;

  const base = toBaseUnit(q.value, from);
  if (base === null) return null;

  const converted = fromBaseUnit(base, to);
  if (converted === null) return null;

  return { value: settleScale(converted, q.value.scale), unit: target };
}

/**
 * Convert a temperature *difference* rather than a temperature.
 *
 * A separate function because the zero offset must not be applied. "The fever
 * rose 2 °C" is 3.6 °F, not −25.6 °F, and {@link convertQuantity} would
 * confidently return the second. Splitting them forces the caller to say which
 * one they meant, which is the only way to get this right.
 */
export function convertTemperatureDelta(q: Quantity, target: UnitCode): Quantity | null {
  const from = UNITS[q.unit];
  const to = UNITS[target];
  if (from.dimension !== 'temperature' || to.dimension !== 'temperature') return null;

  const base = toBaseUnit(q.value, asRatioScale(from));
  if (base === null) return null;
  const converted = fromBaseUnit(base, asRatioScale(to));
  if (converted === null) return null;

  return { value: settleScale(converted, q.value.scale), unit: target };
}

/* -------------------------------------------------------------------------
 * Concentration — the analyte-dependent case
 * ---------------------------------------------------------------------- */

/**
 * Molar masses, g/mol, for the analytes this record actually carries.
 *
 * Deliberately short. Each entry is a claim about chemistry that has to be
 * right, so the list grows one verified analyte at a time rather than by
 * importing a table nobody has checked.
 *
 * Vitamin D is first because it is the operator's actual open clinical
 * question, and because it is the §12 example of "the first end-to-end clinical
 * loop, from lab PDF to trend to consultation question".
 */
export const MOLAR_MASSES: Readonly<Record<string, string>> = {
  /** 25-hydroxyvitamin D3 (calcifediol), C27H44O2. ng/mL × 2.496 = nmol/L. */
  'vitamin_d_25oh': '400.64',
  /** Glucose, C6H12O6. mg/dL ÷ 18.016 = mmol/L. */
  glucose: '180.156',
  /** Total cholesterol, C27H46O. mg/dL ÷ 38.67 = mmol/L. */
  cholesterol: '386.654',
  /** Creatinine, C4H7N3O. */
  creatinine: '113.118',
};

export type Analyte = keyof typeof MOLAR_MASSES;

/**
 * Convert between mass and molar concentration for a known analyte.
 *
 * `mg/L ÷ (g/mol) = mmol/L`, which falls out of the units once both sides are
 * on their base: milligrams per litre divided by grams per mole gives
 * millimoles per litre directly, with no stray factor of 1000 to get wrong.
 *
 * Returns `null` for an unregistered analyte rather than assuming a molar mass.
 * Guessing here would produce a plausible number for a lab value, which is the
 * single worst failure mode available to this module.
 */
export function convertConcentration(q: Quantity, target: UnitCode, analyte: string): Quantity | null {
  /*
   * `Object.hasOwn`, not a truthiness check on the lookup.
   *
   * `MOLAR_MASSES['toString']` resolves to `Object.prototype.toString` — a
   * function, not `undefined` — so a bare lookup would sail past the null guard
   * and hand a function to `parseDecimal`. The analyte name can originate in a
   * lab-document extraction (§9.9), which is untrusted input by definition.
   */
  if (!Object.hasOwn(MOLAR_MASSES, analyte)) return null;
  const molarMassText = MOLAR_MASSES[analyte];
  if (molarMassText === undefined) return null;
  const molarMass = parseDecimal(molarMassText);
  if (molarMass === null) return null;

  const from = UNITS[q.unit];
  const to = UNITS[target];
  if (from.dimension === to.dimension) return convertQuantity(q, target);

  if (from.dimension === 'concentration_mass' && to.dimension === 'concentration_molar') {
    const mgPerL = multiplyDecimal(q.value, from.toBase);
    const mmolPerL = divideDecimal(mgPerL, molarMass, CONVERSION_SCALE);
    if (mmolPerL === null) return null;
    const scaled = divideDecimal(mmolPerL, to.toBase, CONVERSION_SCALE);
    return scaled === null ? null : { value: scaled, unit: target };
  }

  if (from.dimension === 'concentration_molar' && to.dimension === 'concentration_mass') {
    const mmolPerL = multiplyDecimal(q.value, from.toBase);
    const mgPerL = multiplyDecimal(mmolPerL, molarMass);
    const scaled = divideDecimal(mgPerL, to.toBase, CONVERSION_SCALE);
    return scaled === null ? null : { value: scaled, unit: target };
  }

  return null;
}

/* -------------------------------------------------------------------------
 * Comparison
 * ---------------------------------------------------------------------- */

/**
 * Compare two quantities, converting the second into the first's unit.
 *
 * `null` when the dimensions differ — the comparison has no answer, and
 * returning `0` or a boolean would let `a < b` silently mean "these are
 * incomparable".
 */
export function compareQuantity(a: Quantity, b: Quantity): -1 | 0 | 1 | null {
  const converted = convertQuantity(b, a.unit);
  return converted === null ? null : compareDecimal(a.value, converted.value);
}

/** Round a quantity for display. Never for storage — see {@link toQuantityString}. */
export function roundQuantity(q: Quantity, scale: number, mode: RoundingMode = 'half-even'): Quantity {
  return { value: roundDecimal(q.value, scale, mode), unit: q.unit };
}
