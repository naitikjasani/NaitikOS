/**
 * Document extraction — §9.9, and the rule that governs everything in it.
 *
 * ## An extraction is a proposal, never an observation
 *
 * §4.11's design goal is that "a lab PDF dropped into the vault becomes
 * structured lab observations with the source document permanently attached as
 * evidence". The word doing the work is *becomes*, and the question is what
 * sits between the two.
 *
 * The answer here is: the operator. Nothing extracted from a document enters
 * the observation log until it has been looked at and confirmed. The reasons
 * are P4 and P5, and they are not abstract — the failure being prevented is a
 * misread decimal point putting a vitamin D of 142 ng/mL into a twenty-year
 * medical record, where it will be indistinguishable from a measurement for as
 * long as the record exists. §9.1 makes observations append-only precisely so
 * that numbers cannot be quietly fixed later, which means the moment to be
 * careful is *before* the write.
 *
 * The confirmation step is therefore not a UX nicety that could be skipped for
 * convenience later. It is the boundary between a document and the record.
 *
 * ## Confidence is retained, not consumed
 *
 * §9.9: "A number pulled from a blurry scan at 0.6 confidence is usable, but
 * only if the system remembers it was 0.6." So confidence travels onto the
 * observation, and a candidate below {@link REVIEW_FLOOR} arrives at the review
 * screen unchecked — present, visible, and requiring a deliberate act to
 * accept.
 *
 * A parsed value never reaches confidence 1. {@link MAX_EXTRACTION_CONFIDENCE}
 * caps it below certainty because the thing being measured is *how well the
 * text matched a pattern*, not how right the number is, and those two are only
 * correlated.
 */

import type { Result } from '@naitikos/shared';
import { err, ok } from '@naitikos/shared';

import type { DomainError } from '../../errors/domain-error';
import { validationError } from '../../errors/domain-error';
import type { LabFlag } from '../health/reference-range';

/** Mirrors the `extraction_method` pgEnum. */
export const EXTRACTION_METHODS = Object.freeze(['ocr', 'model', 'manual', 'native_text'] as const);

export type ExtractionMethod = (typeof EXTRACTION_METHODS)[number];

/**
 * The only method implemented.
 *
 * `native_text` is a PDF's embedded text layer, read deterministically with no
 * model and no network. `ocr` and `model` are in the enum because the schema
 * anticipated them; neither has an implementation, and neither is stubbed —
 * a stub that returns nothing looks exactly like a document with no text.
 */
export const IMPLEMENTED_METHODS: readonly ExtractionMethod[] = Object.freeze(['native_text', 'manual']);

/** Below this, a candidate arrives unchecked and has to be accepted deliberately. */
export const REVIEW_FLOOR = 0.7;

/** No parse is certain. See the header. */
export const MAX_EXTRACTION_CONFIDENCE = 0.95;

export type ExtractedField = {
  readonly field: string;
  readonly value: string;
  /** 0–1. */
  readonly confidence: number;
  /** 1-based line number in the extracted text, for "show me where". */
  readonly line: number | null;
};

export type DocumentExtraction = {
  readonly id: string;
  readonly documentId: string;
  readonly method: ExtractionMethod;
  readonly engine: string | null;
  readonly engineVersion: string | null;
  readonly extractedText: string | null;
  readonly structuredFields: readonly ExtractedField[];
  readonly overallConfidence: string | null;
};

/**
 * One proposed lab result, before anybody has agreed to it.
 *
 * Everything is stored as printed. The value is a string because §5.3 bans
 * floats on this path, and the range is kept exactly as it appeared because
 * §9.2 forbids looking one up.
 */
export type CandidateLabResult = {
  /**
   * Stable within one extraction: `line:<n>`. The review screen keys decisions
   * on this, so re-parsing the same text produces the same keys and a partly
   * reviewed document does not shuffle under the operator.
   */
  readonly key: string;
  /** Catalogued analyte slug. Never `null` — an unmatched line is not a candidate. */
  readonly analyteSlug: string;
  /** The name exactly as the report printed it. */
  readonly printedName: string;
  readonly printedValue: string;
  readonly printedUnit: string | null;
  readonly rangeLow: string | null;
  readonly rangeHigh: string | null;
  readonly rangeText: string | null;
  readonly printedFlag: LabFlag | null;
  readonly confidence: number;
  readonly line: number;
  /** The source line verbatim, shown beside the candidate during review. */
  readonly sourceLine: string;
};

export type ParsedLabReport = {
  readonly candidates: readonly CandidateLabResult[];
  /**
   * Lines that looked like results and matched no catalogued analyte.
   *
   * Reported rather than dropped silently. A report with thirty lines and
   * eleven candidates is a partial extraction, and the operator should be told
   * that rather than left to assume the panel had eleven analytes.
   */
  readonly unmatchedLines: number;
  /**
   * The collection date, only when the report stated it unambiguously.
   *
   * See `lab-parser.ts` — `12/09/2026` is two different days depending on who
   * printed it, and guessing wrong misplaces an entire panel on the timeline.
   */
  readonly collectedOn: string | null;
};

/* -------------------------------------------------------------------------
 * Confirmation
 * ---------------------------------------------------------------------- */

export type ConfirmationDecision = {
  readonly key: string;
  readonly accept: boolean;
  /** An operator correction of a mis-parsed value. Overrides the extraction. */
  readonly correctedValue?: string | null;
  readonly correctedUnit?: string | null;
};

export type ConfirmedResult = {
  readonly candidate: CandidateLabResult;
  readonly value: string;
  readonly unit: string | null;
  /**
   * `1` when the operator retyped the value, the parse confidence when they
   * accepted it as read.
   *
   * A corrected value is a *typed* value that happens to have arrived beside a
   * document — it has the provenance of a manual entry and deserves the
   * confidence of one. Keeping the extraction's confidence on it would
   * permanently understate a number the operator read off the page themselves.
   */
  readonly confidence: number;
  readonly wasCorrected: boolean;
};

/**
 * Apply the operator's decisions to a parsed report.
 *
 * A decision for an unknown key is an error rather than a no-op: it means the
 * document was re-parsed between rendering the review and submitting it, and
 * silently dropping the decision would write a *different* set of results from
 * the one the operator looked at.
 */
export function confirmCandidates(
  parsed: ParsedLabReport,
  decisions: readonly ConfirmationDecision[],
): Result<readonly ConfirmedResult[], DomainError> {
  const byKey = new Map(parsed.candidates.map((candidate) => [candidate.key, candidate]));

  const confirmed: ConfirmedResult[] = [];
  for (const decision of decisions) {
    const candidate = byKey.get(decision.key);
    if (candidate === undefined) {
      return err(
        validationError(
          'extraction_decision_stale',
          `No candidate ${decision.key} in this extraction — the document was re-read since this list was shown.`,
        ),
      );
    }
    if (!decision.accept) continue;

    const corrected = decision.correctedValue ?? null;
    const wasCorrected = corrected !== null && corrected.trim() !== '' && corrected.trim() !== candidate.printedValue;

    confirmed.push({
      candidate,
      value: wasCorrected ? (corrected as string).trim() : candidate.printedValue,
      unit: decision.correctedUnit ?? candidate.printedUnit,
      confidence: wasCorrected ? 1 : candidate.confidence,
      wasCorrected,
    });
  }

  return ok(confirmed);
}

/** True when a candidate should arrive at review already ticked. */
export function isPreAccepted(candidate: CandidateLabResult): boolean {
  return candidate.confidence >= REVIEW_FLOOR;
}

/**
 * The extraction's overall confidence: the *lowest* of its candidates.
 *
 * Not the mean. A document containing one line the parser barely understood is
 * a document worth reviewing carefully, and an average would let nineteen clean
 * lines bury it.
 */
export function overallConfidence(candidates: readonly CandidateLabResult[]): number | null {
  if (candidates.length === 0) return null;
  return candidates.reduce((lowest, candidate) => Math.min(lowest, candidate.confidence), 1);
}
