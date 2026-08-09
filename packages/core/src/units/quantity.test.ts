import { describe, expect, it } from 'vitest';

import { compareDecimal, formatDecimal, parseDecimal } from './decimal';
import {
  type Quantity,
  type UnitCode,
  MOLAR_MASSES,
  UNIT_CODES,
  UNITS,
  compareQuantity,
  convertConcentration,
  convertQuantity,
  convertTemperatureDelta,
  dimensionOf,
  formatQuantity,
  isUnitCode,
  quantity,
  roundQuantity,
  unitDefinition,
} from './quantity';

function q(value: string, unit: UnitCode): Quantity {
  const built = quantity(value, unit);
  expect(built, `test literal is not a quantity: ${value} ${unit}`).not.toBeNull();
  return built as Quantity;
}

/** The converted value as a plain string, for readable assertions. */
function converted(from: Quantity, to: UnitCode): string | null {
  const result = convertQuantity(from, to);
  return result === null ? null : formatDecimal(result.value);
}

describe('the registry', () => {
  it('is internally consistent — every factor parses and every code is its own key', () => {
    for (const code of UNIT_CODES) {
      const definition = UNITS[code];
      expect(definition.code, `key/code mismatch for ${code}`).toBe(code);
      expect(parseDecimal(formatDecimal(definition.toBase))).not.toBeNull();
    }
  });

  /**
   * Every dimension needs exactly one base unit — a factor of 1 with no offset
   * — or `convertQuantity` has no fixed point and conversions stop being
   * associative. This is the kind of table error that produces a wrong number
   * rather than a crash, so it is asserted rather than assumed.
   */
  it('has exactly one base unit per dimension', () => {
    const bases = new Map<string, UnitCode[]>();
    for (const code of UNIT_CODES) {
      const definition = UNITS[code];
      const isBase =
        compareDecimal(definition.toBase, { unscaled: 1n, scale: 0 }) === 0 &&
        definition.toBaseDivisor === undefined &&
        definition.zeroOffset === undefined;
      if (isBase) bases.set(definition.dimension, [...(bases.get(definition.dimension) ?? []), code]);
    }

    const dimensions = new Set(UNIT_CODES.map((c) => UNITS[c].dimension));
    for (const dimension of dimensions) {
      expect(bases.get(dimension), `dimension ${dimension}`).toHaveLength(1);
    }
  });

  it('recognises registered codes and rejects invented ones', () => {
    expect(isUnitCode('kg')).toBe(true);
    expect(isUnitCode('')).toBe(true);
    expect(isUnitCode('stone')).toBe(false);
    expect(unitDefinition('kg')?.dimension).toBe('mass');
    expect(unitDefinition('stone')).toBeNull();
    // A prototype key must not resolve as a unit.
    expect(isUnitCode('toString')).toBe(false);
    expect(unitDefinition('constructor')).toBeNull();
  });

  it('builds quantities only from a valid pair', () => {
    expect(quantity('74.2', 'kg')).not.toBeNull();
    expect(quantity('74.2', 'stone')).toBeNull();
    expect(quantity('heavy', 'kg')).toBeNull();
  });
});

describe('convertQuantity', () => {
  it('converts mass exactly', () => {
    expect(converted(q('1', 'kg'), 'g')).toBe('1000');
    expect(converted(q('1000', 'g'), 'kg')).toBe('1');
    expect(converted(q('1', 'lb'), 'g')).toBe('453.59237');
    expect(converted(q('1', 'g'), 'mg')).toBe('1000');
    expect(converted(q('1', 'mg'), 'mcg')).toBe('1000');
  });

  /**
   * §6.2: "There is no path by which milligrams become micrograms." The
   * thousand-fold error is the one that kills people, so it gets its own test
   * in both directions.
   */
  it('never confuses milligrams with micrograms', () => {
    expect(converted(q('20', 'mg'), 'mcg')).toBe('20000');
    expect(converted(q('20', 'mcg'), 'mg')).toBe('0.02');
    expect(compareQuantity(q('1', 'mg'), q('1', 'mcg'))).toBe(1);
  });

  it('keeps the input scale as a floor and drops machinery zeros above it', () => {
    // Scale 0 in, so no invented precision out.
    expect(converted(q('1', 'kg'), 'g')).toBe('1000');
    // Scale 1 in, so one place survives.
    expect(converted(q('1.5', 'kg'), 'g')).toBe('1500.0');
  });

  it('carries full working precision when the ratio is not exact', () => {
    expect(converted(q('1', 'g'), 'oz')).toBe('0.03527396195');
  });

  it('converts time, volume, length and energy', () => {
    expect(converted(q('1', 'hours'), 'minutes')).toBe('60');
    expect(converted(q('90', 'minutes'), 'hours')).toBe('1.5');
    expect(converted(q('1', 'L'), 'mL')).toBe('1000');
    expect(converted(q('1', 'ft'), 'in')).toBe('12');
    expect(converted(q('1', 'kcal'), 'kJ')).toBe('4.184');
    expect(converted(q('1', 'percent'), 'ratio')).toBe('0.01');
  });

  it('is the identity on the same unit', () => {
    const original = q('74.200', 'kg');
    expect(convertQuantity(original, 'kg')).toBe(original);
  });

  /**
   * The dimension guard. Returning `null` rather than a number is the whole
   * safety property — a plausible-looking answer to a meaningless question is
   * worse than no answer.
   */
  it('refuses to cross dimensions', () => {
    expect(convertQuantity(q('1', 'kg'), 'hours')).toBeNull();
    expect(convertQuantity(q('1', 'count'), 'ratio')).toBeNull();
    expect(convertQuantity(q('4', ''), 'ratio')).toBeNull();
    expect(compareQuantity(q('1', 'kg'), q('1', 'hours'))).toBeNull();
  });

  /**
   * A mood of 4 and an adherence of 0.8 are both "unitless" in the loose sense,
   * and treating them as interchangeable is how an ordinal scale ends up being
   * averaged as if it were a proportion.
   */
  it('keeps ordinal scales apart from proportions', () => {
    expect(dimensionOf(q('4', ''))).toBe('scalar');
    expect(dimensionOf(q('0.8', 'ratio'))).toBe('ratio');
  });
});

describe('temperature', () => {
  it('converts readings exactly, in both directions', () => {
    expect(converted(q('212', 'fahrenheit'), 'celsius')).toBe('100');
    expect(converted(q('32', 'fahrenheit'), 'celsius')).toBe('0');
    expect(converted(q('-40', 'fahrenheit'), 'celsius')).toBe('-40');
    expect(converted(q('100', 'celsius'), 'fahrenheit')).toBe('212');
    expect(converted(q('37', 'celsius'), 'fahrenheit')).toBe('98.6');
  });

  /**
   * The affine trap, as a test. A 2 °C rise is 3.6 °F; applying the zero offset
   * to a difference gives −25.6 °F, which is a confident wrong answer.
   */
  it('converts differences without the zero offset', () => {
    const delta = convertTemperatureDelta(q('2', 'celsius'), 'fahrenheit');
    expect(delta).not.toBeNull();
    expect(formatDecimal((delta as Quantity).value)).toBe('3.6');

    const asReading = convertQuantity(q('2', 'celsius'), 'fahrenheit');
    expect(formatDecimal((asReading as Quantity).value)).toBe('35.6');
  });

  it('refuses a delta conversion outside the temperature dimension', () => {
    expect(convertTemperatureDelta(q('2', 'kg'), 'g')).toBeNull();
  });
});

describe('concentration', () => {
  /**
   * The operator's actual open clinical question (§12: "Vitamin D tracking as
   * the first end-to-end clinical loop"). Indian labs report ng/mL; the
   * literature is mostly nmol/L. 1 ng/mL = 2.496 nmol/L.
   */
  it('converts 25-OH vitamin D between the units two labs will report', () => {
    const result = convertConcentration(q('30', 'ng/mL'), 'nmol/L', 'vitamin_d_25oh');
    expect(result).not.toBeNull();
    // 30 ng/mL × 2.496 = 74.88 nmol/L.
    expect(formatDecimal(roundQuantity(result as Quantity, 2).value)).toBe('74.88');
  });

  it('converts glucose mg/dL to mmol/L', () => {
    const result = convertConcentration(q('90', 'mg/dL'), 'mmol/L', 'glucose');
    expect(formatDecimal(roundQuantity(result as Quantity, 1).value)).toBe('5.0');
  });

  it('round-trips within the working precision', () => {
    const forward = convertConcentration(q('30', 'ng/mL'), 'nmol/L', 'vitamin_d_25oh');
    const back = convertConcentration(forward as Quantity, 'ng/mL', 'vitamin_d_25oh');
    expect(formatDecimal(roundQuantity(back as Quantity, 4).value)).toBe('30.0000');
  });

  it('delegates same-dimension pairs to the ordinary converter', () => {
    const result = convertConcentration(q('1', 'mg/dL'), 'mg/L', 'glucose');
    expect(formatDecimal((result as Quantity).value)).toBe('10');
  });

  /**
   * The refusal that matters. Without a molar mass there is no conversion, and
   * inventing one would produce a plausible number for a lab value — the single
   * worst failure available to this module.
   */
  it('returns null for an analyte whose molar mass is not registered', () => {
    expect(convertConcentration(q('30', 'ng/mL'), 'nmol/L', 'ferritin')).toBeNull();
    /*
     * A prototype key is not an analyte. This one was a live bug: a bare
     * lookup returns `Object.prototype.toString` rather than `undefined`, and
     * the analyte name can come from a lab-document extraction.
     */
    expect(convertConcentration(q('30', 'ng/mL'), 'nmol/L', 'toString')).toBeNull();
    expect(convertConcentration(q('30', 'ng/mL'), 'nmol/L', '__proto__')).toBeNull();
  });

  it('refuses a target that is neither concentration dimension', () => {
    expect(convertConcentration(q('30', 'ng/mL'), 'kg', 'glucose')).toBeNull();
  });

  it('registers a parseable molar mass for every analyte', () => {
    for (const [analyte, mass] of Object.entries(MOLAR_MASSES)) {
      expect(parseDecimal(mass), analyte).not.toBeNull();
    }
  });
});

describe('formatQuantity', () => {
  it('renders symbol-bearing and unitless quantities differently', () => {
    expect(formatQuantity(q('74.200', 'kg'))).toBe('74.2 kg');
    expect(formatQuantity(q('4', ''))).toBe('4');
    expect(formatQuantity(q('0.80', 'ratio'))).toBe('0.8');
    expect(formatQuantity(q('12', 'count'))).toBe('12');
  });
});
