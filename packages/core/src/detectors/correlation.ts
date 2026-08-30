/**
 * The correlation detector — §10.6, and the one the whole statistical-honesty
 * argument was written about.
 *
 *   "Running nine detector families across dozens of metric pairs, nightly,
 *    over a single subject, will generate spurious findings continuously. With
 *    enough metrics, *something* always correlates."
 *
 * So this file's job is at least as much refusal as detection. It declines to
 * test unregistered pairs, declines to test below n=30, declines to report a
 * lag search at its raw p-value, and hands everything that survives to the
 * battery for Benjamini–Hochberg and out-of-sample confirmation.
 *
 * ## Every finding here is `exploratory` at best
 *
 * A correlation is never `confirmed` on first detection — §10.6 control 4 makes
 * that the battery's decision, made by recognising the same finding id across
 * two independent windows. This detector cannot promote its own finding, and
 * that is structural rather than a convention: `confidence` is set to
 * `exploratory` here unconditionally.
 *
 * ## The direction of the lag is reported, and the word "causes" is not
 *
 * §10.2: "**No edge is ever labelled causal.** The graph contains temporal
 * precedence, statistical association, and clinical relationships from the
 * medical record. Causation is a claim only a clinician makes."
 *
 * A finding with a positive lag says *"training volume on a day and skin state
 * two days later moved together"*. It does not say the first caused the second,
 * and `doesNotProve` says so in words rather than leaving it to the reader.
 */

import type { DailyPair } from '../statistics/correlation';
import { MIN_CORRELATION_N, bestLaggedCorrelation } from '../statistics/correlation';
import type { DetectorOutcome, Finding, InsufficientData } from './types';
import { findingId, findingSignature } from './types';

/**
 * The most days a lag search will look ahead.
 *
 * Seven. §4.9's motivating case is "skin flares typically lag a trigger by
 * 48–72 hours", and a week comfortably contains it. Every extra lag is another
 * comparison paid for by the Šidák adjustment, so the window is set by the
 * mechanism being looked for rather than by how far the data reaches.
 */
export const MAX_LAG_DAYS = 7;

/** §10.6 control 1: "Correlation requires at least 30 paired observations." */
export const MIN_PAIRED_OBSERVATIONS = MIN_CORRELATION_N;

/**
 * Below this |rho|, a finding is not produced even when it is significant.
 *
 * With n in the hundreds a rho of 0.15 will clear any p-value threshold, and it
 * describes an association that explains about two percent of the variation —
 * true, uninteresting, and indistinguishable to a reader from something that
 * matters. §10.6's controls handle false positives; this handles the different
 * problem of *trivial* positives, which no amount of FDR control addresses.
 */
export const MIN_REPORTABLE_RHO = 0.3;

export type MetricSeries = {
  readonly metricKey: string;
  readonly label: string;
  readonly points: readonly DailyPair[];
};

/**
 * A pair the registry has declared, with its mechanism.
 *
 * §10.6 control 3: "Metric pairs eligible for correlation testing are declared
 * in advance, in a registry, **based on plausible mechanism**." The mechanism is
 * a required field for the same reason `doesNotProve` is: writing it is what
 * forces the declaration to be a hypothesis rather than a pairing that happened
 * to be available.
 */
export type CorrelationPair = {
  readonly id: string;
  readonly x: string;
  readonly y: string;
  readonly mechanism: string;
  /**
   * `pre_registered` pairs test at α; `exploratory` all-pairs testing runs "at a
   * much stricter threshold and its output is labelled exploratory wherever it
   * appears" (§10.6 control 3). The label travels on the finding.
   */
  readonly provenance: 'pre_registered' | 'exploratory';
};

export type CorrelationInput = {
  readonly pair: CorrelationPair;
  readonly x: MetricSeries;
  readonly y: MetricSeries;
  readonly dayKey: string;
  /** §10.6 control 5. False suppresses everything here — all of it is inference. */
  readonly inferentialAllowed: boolean;
};

export function detectCorrelation(input: CorrelationInput): DetectorOutcome {
  const findings: Finding[] = [];
  const insufficient: InsufficientData[] = [];

  const subject = `pair:${input.pair.id}`;

  /*
   * Control 5 first. Unlike adherence, there is nothing descriptive to fall
   * back on — a correlation is an inference by construction, so before day 60
   * this detector produces nothing at all and says why.
   */
  if (!input.inferentialAllowed) {
    return {
      findings: [],
      insufficient: [
        {
          detector: 'correlation',
          subject,
          required: 60,
          available: 0,
          message:
            'Correlations are not tested until there are sixty days of history. An early wrong association costs more trust than sixty days of silence.',
        },
      ],
    };
  }

  const best = bestLaggedCorrelation(input.x.points, input.y.points, MAX_LAG_DAYS);

  if (best === null || best.n < MIN_PAIRED_OBSERVATIONS) {
    insufficient.push({
      detector: 'correlation',
      subject,
      required: MIN_PAIRED_OBSERVATIONS,
      available: best?.n ?? 0,
      message: `${input.x.label} and ${input.y.label} need ${String(MIN_PAIRED_OBSERVATIONS)} days where both were recorded. There are ${String(best?.n ?? 0)}.`,
    });
    return { findings, insufficient };
  }

  /*
   * Trivial-effect gate. Deliberately *before* the p-value is considered, so a
   * large-n trickle of rho ≈ 0.15 findings never reaches the battery and never
   * inflates its comparison count — which would make Benjamini–Hochberg harsher
   * on the findings that do matter.
   */
  if (Math.abs(best.rho) < MIN_REPORTABLE_RHO || best.pValue === null) {
    return { findings, insufficient };
  }

  findings.push({
    id: findingId('correlation', subject, input.dayKey, `lag${String(best.lagDays)}`),
    /* The lag is part of the identity: a relationship at two days and the same
     * relationship at five days are different claims, and confirming one with
     * the other would be the confirmation control confirming nothing. */
    signature: findingSignature('correlation', subject, `lag${String(best.lagDays)}`),
    detector: 'correlation',
    subject,
    dayKey: input.dayKey,

    headline: headlineFor(input, best.lagDays, best.rho),
    detail: `Spearman's rho ${best.rho.toFixed(2)} over ${String(best.n)} days where both were recorded${best.lagDays === 0 ? '' : `, with ${input.y.label} read ${String(best.lagDays)} ${best.lagDays === 1 ? 'day' : 'days'} later`}. ${String(best.lagsSearched)} lags were searched and the p-value is adjusted for that.`,

    n: best.n,
    effect: `rho ${best.rho.toFixed(2)}`,
    /* Never `confirmed` here. Control 4 is the battery's call, made across two
     * independent windows, and a detector that could promote its own finding
     * would defeat it. */
    confidence: 'exploratory',
    doesNotProve: DOES_NOT_PROVE,

    pValue: best.pValue,
    evidence: [
      { kind: 'metric', id: input.x.metricKey, label: input.x.label },
      { kind: 'metric', id: input.y.metricKey, label: input.y.label },
      { kind: 'hypothesis', id: input.pair.id, label: input.pair.mechanism },
    ],
  });

  return { findings, insufficient };
}

/**
 * The caveat, on every correlation finding, forever.
 *
 * Three separate limitations, because they fail differently. Association is not
 * causation; a single person's data has no control group; and both metrics are
 * self-reported by the same person on the same day, so a bad day colours both
 * taps at once. The third is the one a reader is least likely to think of and
 * the most likely to be the actual explanation.
 */
export const DOES_NOT_PROVE =
  'This is an association, not a cause. It is drawn from one person’s records with nothing held constant, and both figures were recorded by the same person on the same day — a day that felt bad can move both readings without either affecting the other.';

function headlineFor(input: CorrelationInput, lagDays: number, rho: number): string {
  const direction = rho > 0 ? 'moved together' : 'moved in opposite directions';
  const when =
    lagDays === 0
      ? 'on the same day'
      : `with ${input.y.label.toLowerCase()} read ${String(lagDays)} ${lagDays === 1 ? 'day' : 'days'} later`;

  return `${input.x.label} and ${input.y.label.toLowerCase()} ${direction} ${when}.`;
}
