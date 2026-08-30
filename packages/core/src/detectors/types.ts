/**
 * The shape of a finding, and the five controls it has to survive (§10.6).
 *
 * ## `doesNotProve` is a required field
 *
 * §10.6: "Every insight displays its n, its effect size, its confidence, and —
 * as a required field in the output schema — **an explicit statement of what it
 * does not prove.** An insight the user cannot audit is an insight they should
 * not act on."
 *
 * It is required in the TypeScript sense, not in the documentation sense. A
 * detector cannot construct a {@link Finding} without writing that sentence,
 * which means the sentence exists before the finding does, which is the only
 * ordering that reliably produces an honest one.
 *
 * ## Confidence is a kind, not a number
 *
 * Three values, and the distinction between the first and the rest is the most
 * consequential thing in this file.
 *
 * - `descriptive` — a count. "You logged the evening routine on 24 of the last
 *   30 days." There is no inference, no baseline, no test, and nothing to be
 *   wrong about beyond the data itself.
 * - `exploratory` — an inference that has been detected once. §10.6 control 4
 *   holds these back: "A correlation is not surfaced on first detection. It is
 *   held, and re-tested against subsequent data."
 * - `confirmed` — an inference that survived a second independent window.
 *
 * Only `exploratory` and `confirmed` findings carry a p-value, are subject to
 * Benjamini–Hochberg, and are gated behind the sixty-day baseline. Descriptive
 * findings are not, and the reasoning is recorded in `battery.ts` rather than
 * here because it is a decision about the battery, not about the type.
 */

export type DetectorId = 'adherence' | 'streak' | 'correlation';

export type FindingConfidence = 'descriptive' | 'exploratory' | 'confirmed';

export type FindingEvidence = {
  /** `medication`, `routine`, `observation`. */
  readonly kind: string;
  readonly id: string;
  readonly label: string;
};

export type Finding = {
  /**
   * Deterministic in the detector, subject, and window.
   *
   * A nightly job that re-ran would otherwise produce a second copy of every
   * finding, and out-of-sample confirmation (control 4) needs to recognise the
   * *same* finding across two runs — which it does by this id.
   */
  readonly id: string;
  readonly detector: DetectorId;
  /** `medication:<uuid>` or `routine:<uuid>`. */
  readonly subject: string;
  readonly dayKey: string;

  /** One neutral sentence. §4.7's register applies to every domain here. */
  readonly headline: string;
  /** Supporting detail. Still neutral, still factual. */
  readonly detail: string;

  /** §10.6's required display fields. */
  readonly n: number;
  readonly effect: string;
  readonly confidence: FindingConfidence;
  readonly doesNotProve: string;

  /** Present only on inferential findings. */
  readonly pValue: number | null;
  readonly evidence: readonly FindingEvidence[];
};

/**
 * A detector that could not run, reported rather than swallowed.
 *
 * §10.6 control 1: "Below the gate, the detector reports *insufficient data* —
 * which is itself displayed, because 'not enough data yet' is honest and builds
 * trust."
 *
 * The temptation is to filter these out at the API boundary because they are
 * not findings. Resist it: an insight surface that shows nothing is
 * indistinguishable from one that is broken, and a surface that says "adherence
 * needs 30 recorded doses; there are 11" tells the operator both that the
 * system works and what to do about it.
 */
export type InsufficientData = {
  readonly detector: DetectorId;
  readonly subject: string;
  readonly required: number;
  readonly available: number;
  readonly message: string;
};

export type DetectorOutcome = {
  readonly findings: readonly Finding[];
  readonly insufficient: readonly InsufficientData[];
};

export const EMPTY_OUTCOME: DetectorOutcome = Object.freeze({
  findings: Object.freeze([]),
  insufficient: Object.freeze([]),
});

/** Stable finding id. Same detector, same subject, same window, same id. */
export function findingId(detector: DetectorId, subject: string, dayKey: string, variant: string): string {
  return `${detector}:${subject}:${variant}:${dayKey}`;
}
