/**
 * The analyte catalogue — §4.4's "unit and reference-range registry", the half
 * of it that is about units.
 *
 * ## Why an analyte is a metric and not a row of free text
 *
 * §9.2 makes the metric registry the vocabulary that lets domains talk to each
 * other, and aggregation-per-metric is what stops a chart summing bodyweight.
 * A lab analyte needs exactly that: its own unit, its own plausible bounds, and
 * `last` aggregation, because the mean of two ferritin draws in a month is not
 * a number anybody wants.
 *
 * So each catalogued analyte gets a metric key, `health.lab.<slug>`, and its
 * results become ordinary observations. That is what makes §4.4's promise — the
 * medical record reading from every Body module — a join rather than a special
 * case.
 *
 * ## An uncatalogued analyte is still stored, and still has no trend
 *
 * A lab report carries thirty lines and this catalogue knows fifteen. The
 * `lab_result` row is written for all thirty, exactly as printed: the record is
 * the record. But only catalogued analytes produce observations, because an
 * observation needs a metric, a metric needs a unit and an aggregation, and
 * inventing those from a PDF is precisely the move P5 forbids.
 *
 * The consequence is visible rather than silent: an uncatalogued result renders
 * with its value and no chart, and adding it to this file is the one-line
 * change that gives it one.
 *
 * ## Aliases exist because laboratories do not agree on names
 *
 * The same test is "25-OH Vitamin D", "Vitamin D (25-Hydroxy)", "25(OH)D" and
 * "VITAMIN D TOTAL" depending on who printed it. The aliases are what let the
 * document parser (`domain/document/lab-parser.ts`) recognise a line without a
 * model, and they are deliberately generous: a false match produces a candidate
 * the operator rejects, whereas a miss produces a number nobody ever sees.
 */

import type { UnitCode } from '../../units/quantity';
import { UNITS, convertConcentration, convertQuantity, isUnitCode } from '../../units/quantity';
import type { Quantity } from '../../units/quantity';

/** The metric-key prefix. Permanent — a rename here is a data migration. */
export const LAB_METRIC_PREFIX = 'health.lab.';

export type AnalyteDefinition = {
  /** Stable slug. Appears in the metric key, so it never changes. */
  readonly slug: string;
  readonly displayName: string;
  /**
   * The unit this analyte's observations are stored in. Results printed in
   * another registered unit are converted; results in an unregistered unit are
   * stored structurally and produce no observation.
   */
  readonly canonicalUnit: UnitCode;
  /**
   * The key into `MOLAR_MASSES` when this analyte is reported in both mass and
   * molar concentration. `null` when it is not — and a `null` here means a
   * cross-dimension conversion returns `null` rather than guessing.
   */
  readonly molarKey: string | null;
  /** Lower-cased, punctuation-stripped spellings seen on real reports. */
  readonly aliases: readonly string[];
  /** Display precision. Ferritin is an integer; TSH is not. */
  readonly decimals: number;
  /**
   * A fat-finger and mis-parse guard, in the canonical unit. Not a clinical
   * bound — a value outside it is rejected as *unreadable*, not as *abnormal*.
   */
  readonly plausible: { readonly min: number; readonly max: number };
};

function analyte(definition: AnalyteDefinition): AnalyteDefinition {
  return Object.freeze(definition);
}

/**
 * The catalogue.
 *
 * Vitamin D is first because §12 names it as "the first end-to-end clinical
 * loop, from lab PDF to trend to consultation question", and because it is the
 * operator's actual open question. The rest are the analytes that appear on a
 * routine Indian full-body panel, which is the document this system will
 * actually be fed.
 */
export const ANALYTES: readonly AnalyteDefinition[] = Object.freeze([
  analyte({
    slug: 'vitamin_d_25oh',
    displayName: '25-hydroxyvitamin D',
    canonicalUnit: 'ng/mL',
    molarKey: 'vitamin_d_25oh',
    aliases: [
      '25 oh vitamin d',
      '25 hydroxy vitamin d',
      '25 hydroxyvitamin d',
      '25 oh d',
      '25 oh d3',
      'vitamin d 25 hydroxy',
      'vitamin d total',
      'vitamin d',
      'calcifediol',
    ],
    decimals: 1,
    plausible: { min: 0, max: 200 },
  }),
  analyte({
    slug: 'ferritin',
    displayName: 'Ferritin',
    canonicalUnit: 'ng/mL',
    molarKey: null,
    aliases: ['ferritin', 'serum ferritin'],
    decimals: 0,
    plausible: { min: 0, max: 5000 },
  }),
  analyte({
    slug: 'vitamin_b12',
    displayName: 'Vitamin B12',
    canonicalUnit: 'ng/mL',
    molarKey: null,
    aliases: ['vitamin b12', 'vitamin b 12', 'b12', 'cobalamin', 'cyanocobalamin'],
    decimals: 0,
    plausible: { min: 0, max: 5000 },
  }),
  analyte({
    slug: 'tsh',
    displayName: 'TSH',
    /* `mIU/L` on a European report is the same number as `µIU/mL` on an Indian
       one. The unit registry knows that, so both forms trend on one axis. */
    canonicalUnit: 'uIU/mL',
    molarKey: null,
    aliases: ['tsh', 'thyroid stimulating hormone', 'thyrotropin'],
    decimals: 2,
    plausible: { min: 0, max: 150 },
  }),
  analyte({
    slug: 'hba1c',
    displayName: 'HbA1c',
    canonicalUnit: 'percent',
    molarKey: null,
    aliases: ['hba1c', 'hb a1c', 'glycated hemoglobin', 'glycosylated hemoglobin', 'a1c'],
    decimals: 1,
    plausible: { min: 2, max: 20 },
  }),
  analyte({
    slug: 'hemoglobin',
    displayName: 'Haemoglobin',
    canonicalUnit: 'mg/dL',
    molarKey: null,
    aliases: ['hemoglobin', 'haemoglobin', 'hb', 'hgb'],
    decimals: 1,
    plausible: { min: 0, max: 30 },
  }),
  analyte({
    slug: 'glucose_fasting',
    displayName: 'Fasting glucose',
    canonicalUnit: 'mg/dL',
    molarKey: 'glucose',
    aliases: ['fasting blood sugar', 'fasting glucose', 'glucose fasting', 'fbs', 'blood sugar fasting'],
    decimals: 0,
    plausible: { min: 0, max: 900 },
  }),
  analyte({
    slug: 'cholesterol_total',
    displayName: 'Total cholesterol',
    canonicalUnit: 'mg/dL',
    molarKey: 'cholesterol',
    aliases: ['total cholesterol', 'cholesterol total', 'cholesterol'],
    decimals: 0,
    plausible: { min: 0, max: 800 },
  }),
  analyte({
    slug: 'ldl_cholesterol',
    displayName: 'LDL cholesterol',
    canonicalUnit: 'mg/dL',
    molarKey: 'cholesterol',
    aliases: ['ldl cholesterol', 'ldl', 'ldl c', 'low density lipoprotein'],
    decimals: 0,
    plausible: { min: 0, max: 600 },
  }),
  analyte({
    slug: 'hdl_cholesterol',
    displayName: 'HDL cholesterol',
    canonicalUnit: 'mg/dL',
    molarKey: 'cholesterol',
    aliases: ['hdl cholesterol', 'hdl', 'hdl c', 'high density lipoprotein'],
    decimals: 0,
    plausible: { min: 0, max: 200 },
  }),
  analyte({
    slug: 'triglycerides',
    displayName: 'Triglycerides',
    canonicalUnit: 'mg/dL',
    molarKey: null,
    aliases: ['triglycerides', 'triglyceride', 'tg'],
    decimals: 0,
    plausible: { min: 0, max: 2000 },
  }),
  analyte({
    slug: 'creatinine',
    displayName: 'Creatinine',
    canonicalUnit: 'mg/dL',
    molarKey: 'creatinine',
    aliases: ['creatinine', 'serum creatinine', 'creat'],
    decimals: 2,
    plausible: { min: 0, max: 30 },
  }),
  analyte({
    slug: 'alt',
    displayName: 'ALT (SGPT)',
    canonicalUnit: '',
    molarKey: null,
    aliases: ['alt', 'sgpt', 'alanine aminotransferase', 'alt sgpt', 'sgpt alt'],
    decimals: 0,
    plausible: { min: 0, max: 5000 },
  }),
  analyte({
    slug: 'ast',
    displayName: 'AST (SGOT)',
    canonicalUnit: '',
    molarKey: null,
    aliases: ['ast', 'sgot', 'aspartate aminotransferase', 'ast sgot', 'sgot ast'],
    decimals: 0,
    plausible: { min: 0, max: 5000 },
  }),
  analyte({
    slug: 'crp',
    displayName: 'C-reactive protein',
    canonicalUnit: 'mg/L',
    molarKey: null,
    aliases: ['crp', 'c reactive protein', 'hs crp', 'high sensitivity crp'],
    decimals: 1,
    plausible: { min: 0, max: 600 },
  }),
]);

/**
 * Fold a printed analyte name into a comparison key.
 *
 * Everything that is not a letter or a digit becomes a single space, because
 * `25(OH)D`, `25-OH-D` and `25 OH D` are the same test printed by three
 * laboratories. The digits are kept — dropping them would merge B12 with B6.
 */
export function foldAnalyteName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim();
}

const BY_KEY: ReadonlyMap<string, AnalyteDefinition> = (() => {
  const map = new Map<string, AnalyteDefinition>();
  for (const definition of ANALYTES) {
    map.set(definition.slug, definition);
    map.set(foldAnalyteName(definition.displayName), definition);
    for (const alias of definition.aliases) {
      const folded = foldAnalyteName(alias);
      /*
       * First spelling wins. `vitamin d` is an alias of 25-OH-D and nothing
       * else, but if a later entry ever claimed it too, silently rebinding the
       * earlier one would move a chart's data to a different analyte. Losing
       * the duplicate loudly is not possible in a frozen literal, so it loses
       * quietly in the direction that changes nothing.
       */
      if (!map.has(folded)) map.set(folded, definition);
    }
  }
  return map;
})();

/** The catalogued analyte for a printed name, or `null` — never a guess. */
export function analyteFor(name: string): AnalyteDefinition | null {
  return BY_KEY.get(foldAnalyteName(name)) ?? null;
}

export function analyteBySlug(slug: string): AnalyteDefinition | null {
  const found = BY_KEY.get(slug);
  return found !== undefined && found.slug === slug ? found : null;
}

/** `health.lab.vitamin_d_25oh`. */
export function labMetricKey(slug: string): string {
  return `${LAB_METRIC_PREFIX}${slug}`;
}

/** The inverse, for a chart that has a metric key and wants the analyte. */
export function analyteForMetricKey(key: string): AnalyteDefinition | null {
  if (!key.startsWith(LAB_METRIC_PREFIX)) return null;
  return analyteBySlug(key.slice(LAB_METRIC_PREFIX.length));
}

/* -------------------------------------------------------------------------
 * Canonicalisation — the reason a trend line is allowed to exist
 * ---------------------------------------------------------------------- */

export type CanonicalFailure =
  /** The unit string on the report is not one this system registers. */
  | 'unknown_unit'
  /** Registered, but there is no conversion into the canonical unit. */
  | 'incomparable'
  /** Converted, and the result is outside the analyte's plausible bounds. */
  | 'implausible';

export type CanonicalValue = {
  readonly quantity: Quantity;
  /** True when the printed unit differed and a conversion was applied. */
  readonly converted: boolean;
};

/**
 * Put a printed result into the analyte's canonical unit.
 *
 * This is the single most important function in the lab pipeline and the
 * failure it prevents is concrete: an Indian laboratory prints 25-OH-D in
 * ng/mL, a European one in nmol/L, and the same person's level of 30 ng/mL and
 * 75 nmol/L are *identical*. Plotting them on one axis without conversion draws
 * a spectacular deficiency correction that never happened.
 *
 * `convertConcentration` is used ahead of `convertQuantity` because the mass
 * and molar concentrations are different dimensions, and it returns `null` for
 * an analyte with no registered molar mass rather than assuming one.
 */
export function toCanonical(
  definition: AnalyteDefinition,
  value: Quantity,
): { readonly ok: true; readonly value: CanonicalValue } | { readonly ok: false; readonly reason: CanonicalFailure } {
  if (value.unit === definition.canonicalUnit) {
    return plausibility(definition, { quantity: value, converted: false });
  }

  const from = UNITS[value.unit];
  const to = UNITS[definition.canonicalUnit];

  const converted =
    from.dimension === to.dimension
      ? convertQuantity(value, definition.canonicalUnit)
      : definition.molarKey === null
        ? null
        : convertConcentration(value, definition.canonicalUnit, definition.molarKey);

  if (converted === null) return { ok: false, reason: 'incomparable' };
  return plausibility(definition, { quantity: converted, converted: true });
}

function plausibility(
  definition: AnalyteDefinition,
  candidate: CanonicalValue,
): { readonly ok: true; readonly value: CanonicalValue } | { readonly ok: false; readonly reason: CanonicalFailure } {
  const asNumber = Number(
    (Number(candidate.quantity.value.unscaled) / 10 ** candidate.quantity.value.scale).toFixed(6),
  );
  if (!Number.isFinite(asNumber)) return { ok: false, reason: 'implausible' };
  if (asNumber < definition.plausible.min || asNumber > definition.plausible.max) {
    return { ok: false, reason: 'implausible' };
  }
  return { ok: true, value: candidate };
}

/**
 * Parse a printed unit string into a registered code.
 *
 * Laboratories print `µg/dL`, `ug/dL` and `mcg/dL` for one unit, and `%` for
 * percent. Anything still unrecognised returns `null`, which the caller turns
 * into `unknown_unit` — the honest outcome, because a result whose unit this
 * system cannot name is a result it cannot compare.
 */
export function normaliseUnit(printed: string): UnitCode | null {
  const trimmed = printed.trim();
  if (trimmed === '') return '';
  if (trimmed === '%') return 'percent';

  /*
   * `mIU/L` is not another unit; it is another spelling. 1 µIU/mL is exactly
   * 1 mIU/L, so folding it here — rather than registering a second unit with a
   * factor of one — keeps the registry's "one base unit per dimension"
   * invariant intact and keeps every stored TSH under one unit code (§6.2).
   */
  if (/^m\s*IU\s*\/\s*L$/iu.test(trimmed)) return 'uIU/mL';

  const cleaned = trimmed
    .replace(/µ|μ/gu, 'u')
    .replace(/\s+/gu, '')
    .replace(/^mcg\//u, 'ug/');

  if (isUnitCode(cleaned)) return cleaned;

  const lowered = cleaned.toLowerCase();
  for (const code of Object.keys(UNITS)) {
    if (code !== '' && code.toLowerCase() === lowered) return code as UnitCode;
  }
  return null;
}
