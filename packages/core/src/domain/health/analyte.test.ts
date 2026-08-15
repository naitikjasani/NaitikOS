import { describe, expect, it } from 'vitest';

import { formatDecimal } from '../../units/decimal';
import { quantity } from '../../units/quantity';
import { ANALYTES, analyteFor, analyteForMetricKey, labMetricKey, normaliseUnit, toCanonical } from './analyte';
import { HEALTH_METRICS } from './metrics';

describe('the analyte catalogue', () => {
  it('resolves the spellings real laboratories print', () => {
    for (const printed of [
      '25-OH Vitamin D',
      '25(OH)D',
      'Vitamin D (25-Hydroxy)',
      'VITAMIN D TOTAL',
      '  vitamin   d  ',
    ]) {
      expect(analyteFor(printed)?.slug, printed).toBe('vitamin_d_25oh');
    }
  });

  it('keeps analytes apart whose names differ only in a digit', () => {
    expect(analyteFor('Vitamin B12')?.slug).toBe('vitamin_b12');
    expect(analyteFor('Vitamin D')?.slug).toBe('vitamin_d_25oh');
  });

  it('returns null rather than guessing at an unknown name', () => {
    expect(analyteFor('Homocysteine')).toBeNull();
    expect(analyteFor('')).toBeNull();
    // A prototype key must not resolve as an analyte.
    expect(analyteFor('toString')).toBeNull();
    expect(analyteFor('constructor')).toBeNull();
  });

  it('round-trips through the metric key', () => {
    for (const analyte of ANALYTES) {
      expect(analyteForMetricKey(labMetricKey(analyte.slug))?.slug).toBe(analyte.slug);
    }
    expect(analyteForMetricKey('body.weight')).toBeNull();
    expect(analyteForMetricKey('health.lab.unregistered')).toBeNull();
  });

  it('has a registered metric for every catalogued analyte, with matching units', () => {
    for (const analyte of ANALYTES) {
      const registered = HEALTH_METRICS.find((entry) => entry.key === labMetricKey(analyte.slug));
      expect(registered, analyte.slug).toBeDefined();
      expect(registered?.canonicalUnit, analyte.slug).toBe(analyte.canonicalUnit);
      // §9.2: a lab value is never averaged over a period.
      expect(registered?.aggregation, analyte.slug).toBe('last');
    }
  });
});

describe('unit normalisation', () => {
  it('accepts the micro sign in both of its Unicode spellings', () => {
    expect(normaliseUnit('µg/dL')).toBe('ug/dL');
    expect(normaliseUnit('μg/dL')).toBe('ug/dL');
    expect(normaliseUnit('mcg/dL')).toBe('ug/dL');
  });

  it('maps the percent sign and tolerates spacing', () => {
    expect(normaliseUnit('%')).toBe('percent');
    expect(normaliseUnit(' ng / mL ')).toBe('ng/mL');
    expect(normaliseUnit('NG/ML')).toBe('ng/mL');
  });

  /**
   * `mIU/L` and `µIU/mL` are the same quantity under two names, so this is a
   * spelling rule rather than a conversion — see the `iu_concentration`
   * dimension for why registering a second unit would have been wrong.
   */
  it('folds the two spellings of the TSH unit onto one code', () => {
    expect(normaliseUnit('uIU/mL')).toBe('uIU/mL');
    expect(normaliseUnit('µIU/mL')).toBe('uIU/mL');
    expect(normaliseUnit('mIU/L')).toBe('uIU/mL');
    expect(normaliseUnit('mIU / L')).toBe('uIU/mL');
  });

  it('refuses a unit it does not register', () => {
    expect(normaliseUnit('IU/L')).toBeNull();
    expect(normaliseUnit('furlongs')).toBeNull();
  });
});

describe('canonicalisation', () => {
  /**
   * The failure this exists to prevent: 30 ng/mL and 75 nmol/L are the *same*
   * vitamin D level. Plotted on one axis unconverted they draw a spectacular
   * correction that never happened.
   */
  it('converts vitamin D between mass and molar concentration', () => {
    const definition = analyteFor('Vitamin D');
    const molar = quantity('75', 'nmol/L');
    expect(definition).not.toBeNull();
    expect(molar).not.toBeNull();

    const result = toCanonical(definition as NonNullable<typeof definition>, molar as NonNullable<typeof molar>);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.converted).toBe(true);
    // 75 nmol/L ÷ 2.496 ≈ 30.04 ng/mL.
    expect(Number(formatDecimal(result.value.quantity.value))).toBeCloseTo(30.04, 1);
  });

  it('leaves a value already in the canonical unit alone', () => {
    const definition = analyteFor('Ferritin');
    const value = quantity('45', 'ng/mL');
    const result = toCanonical(definition as NonNullable<typeof definition>, value as NonNullable<typeof value>);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.converted).toBe(false);
  });

  it('refuses a cross-dimension conversion with no registered molar mass', () => {
    const definition = analyteFor('Ferritin');
    const molar = quantity('100', 'nmol/L');
    const result = toCanonical(definition as NonNullable<typeof definition>, molar as NonNullable<typeof molar>);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('incomparable');
  });

  it('rejects an implausible value rather than storing it', () => {
    const definition = analyteFor('Vitamin D');
    const absurd = quantity('4000', 'ng/mL');
    const result = toCanonical(definition as NonNullable<typeof definition>, absurd as NonNullable<typeof absurd>);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('implausible');
  });
});
