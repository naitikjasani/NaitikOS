/**
 * The lab-report parser — deterministic, offline, and deliberately narrow.
 *
 * ## Why there is no model here
 *
 * §10.0: "The model never computes, discovers, or asserts. It retrieves,
 * explains, ranks, and drafts." Reading a number off a page and putting it into
 * a medical record is computing, and §12 puts the AI layer in December in any
 * case. This parser is regular expressions over a PDF's embedded text layer —
 * `extraction_method = 'native_text'`, no network, no egress of a document
 * carrying the operator's name, their address and their doctor's.
 *
 * ## It only recognises what the catalogue knows
 *
 * A line becomes a candidate when its *label* — everything before the first
 * bare number — resolves to a catalogued analyte. Everything else is counted
 * in `unmatchedLines` and reported.
 *
 * The alternative, a general "name, number, unit, range" pattern, was written
 * and rejected. It matches the patient's age, the sample id, the page number
 * and the phone number in the footer, and each becomes a plausible-looking
 * candidate. A parser that proposes rubbish trains the operator to tick boxes
 * without reading, which defeats the confirmation step that is the entire
 * safety property of this pipeline.
 *
 * The full text is stored regardless (§9.9), so nothing is lost: an
 * uncatalogued analyte stays searchable, it simply has no trend until six lines
 * are added to `domain/health/analyte.ts`.
 *
 * ## The label match has to be tight, and how
 *
 * `Vitamin D` is an alias, and a lab that reports `Vitamin D Binding Protein`
 * would otherwise hand a completely different molecule to the vitamin D chart.
 * Two rules prevent it: a leading collection-qualifier (`Serum`, `Plasma`) is
 * stripped, and the matched alias must then cover at least
 * {@link MIN_LABEL_COVERAGE} of what remains. `Serum TSH` resolves; `Vitamin D
 * Binding Protein` does not and is reported as unmatched, which is the right
 * failure — a missing candidate is visible, a wrong one is not.
 *
 * ## Ambiguous dates are refused
 *
 * `12/09/2026` is 12 September in Mumbai and 9 December in Boston, and nothing
 * in the text settles it. A collection date anchors an entire panel on a
 * twenty-year timeline, so the parser returns one only when it is unambiguous —
 * ISO, a named month, or a first number past the twelfth. Otherwise the
 * operator types it, once.
 *
 * ## Single-letter flags are not read
 *
 * `L` beside a value might mean "low"; it is also a perfectly good unit. Only
 * spelled-out words are recognised. A missed flag loses nothing — the printed
 * range is still captured and `effectiveFlag` derives one, labelled as derived.
 */

import { ANALYTES, foldAnalyteName } from '../health/analyte';
import type { LabFlag } from '../health/reference-range';
import type { CandidateLabResult, ParsedLabReport } from './extraction';
import { MAX_EXTRACTION_CONFIDENCE } from './extraction';

/** The engine identity written to `document_extraction.engine`. */
export const PARSER_ENGINE = 'naitikos/lab-parser';
export const PARSER_VERSION = '1';

/** How much of a label the matched alias must account for. See the header. */
export const MIN_LABEL_COVERAGE = 0.5;

/** Stripped from the front of a label before matching. Not part of any name. */
const COLLECTION_QUALIFIERS: readonly string[] = ['serum', 'plasma', 'blood', 'whole blood', 'random', 'total serum'];

const NUMBER_TOKEN = /^[<>≤≥]?\d+(?:\.\d+)?$/u;
const NUMBER = String.raw`\d+(?:\.\d+)?`;
const UNIT_AFTER_VALUE = new RegExp(String.raw`^\s*([A-Za-zµμ%][A-Za-zµμ%/\d.]*)`, 'u');
const RANGE_PAIR = new RegExp(String.raw`(${NUMBER})\s*(?:-|–|—|to)\s*(${NUMBER})`, 'u');
const RANGE_UPPER = new RegExp(String.raw`(?:<|<=|≤|less\s+than|upto|up\s+to)\s*(${NUMBER})`, 'iu');
const RANGE_LOWER = new RegExp(String.raw`(?:>|>=|≥|greater\s+than)\s*(${NUMBER})`, 'iu');
const FLAG_WORD = /\b(high|low|normal|abnormal)\b/iu;
const LOOKS_LIKE_RESULT = new RegExp(String.raw`[A-Za-z].*\s${NUMBER}(?:\s|$)`, 'u');

const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/u;
const NAMED_MONTH = /\b(\d{1,2})[\s\-/](jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[\s\-/](\d{4})\b/iu;
const NUMERIC_DATE = /\b(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})\b/u;

const MONTH_NUMBER: Readonly<Record<string, string>> = {
  jan: '01',
  feb: '02',
  mar: '03',
  apr: '04',
  may: '05',
  jun: '06',
  jul: '07',
  aug: '08',
  sep: '09',
  oct: '10',
  nov: '11',
  dec: '12',
};

/** Aliases longest-first, so `hdl cholesterol` is tried before `cholesterol`. */
const ALIAS_INDEX: readonly { readonly folded: string; readonly slug: string }[] = (() => {
  const entries: { folded: string; slug: string }[] = [];
  for (const analyte of ANALYTES) {
    const spellings = new Set<string>([foldAnalyteName(analyte.displayName), ...analyte.aliases.map(foldAnalyteName)]);
    for (const folded of spellings) {
      if (folded !== '') entries.push({ folded, slug: analyte.slug });
    }
  }
  return entries.sort((a, b) => b.folded.length - a.folded.length);
})();

/**
 * Resolve a printed label to a catalogued analyte slug, or `null`.
 *
 * Exported because it is the rule most likely to need adjusting when a new
 * laboratory turns up with a new way of writing "cholesterol", and a rule that
 * can only be exercised through a whole document is a rule that stops being
 * tested.
 */
export function matchAnalyteLabel(label: string): string | null {
  let folded = foldAnalyteName(label);
  if (folded === '') return null;

  for (const qualifier of COLLECTION_QUALIFIERS) {
    if (folded.startsWith(`${qualifier} `)) {
      folded = folded.slice(qualifier.length + 1);
      break;
    }
  }
  if (folded === '') return null;

  for (const entry of ALIAS_INDEX) {
    if (folded === entry.folded) return entry.slug;
    const isPrefix = folded.startsWith(`${entry.folded} `);
    const isSuffix = folded.endsWith(` ${entry.folded}`);
    if (!isPrefix && !isSuffix) continue;
    if (entry.folded.length / folded.length >= MIN_LABEL_COVERAGE) return entry.slug;
  }

  return null;
}

/**
 * Parse the text layer of a lab report.
 *
 * Pure: the same text produces the same candidates, with no clock and no IO.
 */
export function parseLabReport(text: string): ParsedLabReport {
  const lines = text.split(/\r?\n/u);
  const candidates: CandidateLabResult[] = [];
  const claimed = new Set<string>();
  let unmatchedLines = 0;

  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line.length < 3) continue;

    /*
     * Split at the first *bare* number token. `B12` and `25-OH` are not bare,
     * which is the whole reason for tokenising rather than scanning for the
     * first digit: `Vitamin D (25-OH) 14.2` has its first digit inside the
     * analyte's own name, and a digit-scan reads that report as 25 ng/mL.
     */
    const tokens = line.split(/\s+/u);
    const valueIndex = tokens.findIndex((token) => NUMBER_TOKEN.test(token));
    if (valueIndex <= 0) {
      if (LOOKS_LIKE_RESULT.test(line)) unmatchedLines += 1;
      continue;
    }

    const label = tokens.slice(0, valueIndex).join(' ');
    const slug = matchAnalyteLabel(label);
    if (slug === null) {
      if (LOOKS_LIKE_RESULT.test(line)) unmatchedLines += 1;
      continue;
    }

    /*
     * One candidate per analyte per report. Laboratories print the same result
     * in a summary and again in a detail table, and two rows for one draw is
     * the duplicate hardest to notice — because both of them are correct.
     */
    if (claimed.has(slug)) continue;

    const printedValue = (tokens[valueIndex] as string).replace(/^[<>≤≥]/u, '');
    const afterValue = tokens.slice(valueIndex + 1).join(' ');

    const unitMatch = UNIT_AFTER_VALUE.exec(afterValue);
    /* A flag word sits exactly where a unit would. `Ferritin 12 Low 22 - 322`
     * has no unit, and reading `Low` as one would store a unit of "Low". */
    const unitCandidate = unitMatch === null ? null : (unitMatch[1] as string);
    const unitIsFlag = unitCandidate !== null && FLAG_WORD.test(unitCandidate);
    const printedUnit = unitIsFlag ? null : unitCandidate;
    const afterUnit = unitMatch === null || unitIsFlag ? afterValue : afterValue.slice(unitMatch[0].length);

    const pair = RANGE_PAIR.exec(afterUnit);
    const upper = pair === null ? RANGE_UPPER.exec(afterUnit) : null;
    const lower = pair === null && upper === null ? RANGE_LOWER.exec(afterUnit) : null;

    const rangeLow = pair !== null ? (pair[1] as string) : lower !== null ? (lower[1] as string) : null;
    const rangeHigh = pair !== null ? (pair[2] as string) : upper !== null ? (upper[1] as string) : null;
    const rangeText = pair?.[0] ?? upper?.[0] ?? lower?.[0] ?? null;

    const flagMatch = FLAG_WORD.exec(afterValue);
    const printedFlag = flagMatch === null ? null : toFlag(flagMatch[1] as string);

    claimed.add(slug);
    candidates.push({
      key: `line:${String(index + 1)}`,
      analyteSlug: slug,
      printedName: label,
      printedValue,
      printedUnit,
      rangeLow,
      rangeHigh,
      rangeText: rangeText === null ? null : rangeText.trim(),
      printedFlag,
      confidence: scoreCandidate({
        unitFound: printedUnit !== null,
        rangeFound: rangeLow !== null || rangeHigh !== null,
        flagFound: printedFlag !== null,
      }),
      line: index + 1,
      sourceLine: line,
    });
  }

  return { candidates, unmatchedLines, collectedOn: findCollectionDate(text) };
}

/**
 * How much of the expected shape was actually found.
 *
 * The score measures the *parse*, not the number. A line with a unit and a
 * range was understood; a bare `Ferritin 45` might be a result or might be a
 * page reference, and it lands below the review floor so the operator has to
 * look at it before it becomes a fact.
 */
function scoreCandidate(found: {
  readonly unitFound: boolean;
  readonly rangeFound: boolean;
  readonly flagFound: boolean;
}): number {
  let score = 0.5;
  if (found.unitFound) score += 0.2;
  if (found.rangeFound) score += 0.2;
  if (found.flagFound) score += 0.05;
  return Math.min(score, MAX_EXTRACTION_CONFIDENCE);
}

function toFlag(word: string): LabFlag | null {
  switch (word.toLowerCase()) {
    case 'high':
      return 'high';
    case 'low':
      return 'low';
    case 'normal':
      return 'normal';
    case 'abnormal':
      return 'abnormal';
    default:
      return null;
  }
}

/**
 * The collection date, or `null`.
 *
 * ISO and named months are unambiguous. A `dd/mm/yyyy`-shaped date is accepted
 * only when its first number is past twelve, which forces a day-first reading;
 * anything else is refused rather than guessed.
 */
export function findCollectionDate(text: string): string | null {
  const window = text.slice(0, 4000);

  const iso = ISO_DATE.exec(window);
  if (iso !== null) return `${iso[1] as string}-${iso[2] as string}-${iso[3] as string}`;

  const named = NAMED_MONTH.exec(window);
  if (named !== null) {
    const month = MONTH_NUMBER[(named[2] as string).toLowerCase().slice(0, 3)];
    if (month !== undefined) {
      return `${named[3] as string}-${month}-${(named[1] as string).padStart(2, '0')}`;
    }
  }

  const numeric = NUMERIC_DATE.exec(window);
  if (numeric !== null) {
    const first = Number(numeric[1]);
    const second = Number(numeric[2]);
    if (first > 12 && second >= 1 && second <= 12) {
      return `${numeric[3] as string}-${String(second).padStart(2, '0')}-${String(first).padStart(2, '0')}`;
    }
  }

  return null;
}
