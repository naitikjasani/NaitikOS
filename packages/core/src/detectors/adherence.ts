/**
 * The adherence detector — §10.6's "deviation from an established routine or
 * medication schedule", and the MVP's only insight family (§2.1).
 *
 * ## It emits two different kinds of thing
 *
 * **A report** is a count over the recent window. It is `descriptive`: no
 * baseline, no test, nothing to be wrong about. It exists because the operator's
 * actual question is usually "have I been taking it?", and answering that needs
 * no statistics at all.
 *
 * **A deviation** is a comparison of the recent window against the established
 * baseline, and it is a genuine inference. It carries a p-value from an exact
 * binomial test, it is subject to Benjamini–Hochberg across the battery, it is
 * held for out-of-sample confirmation, and it is gated behind the sixty-day
 * baseline. All four of §10.6's inferential controls apply to it and none of
 * them apply to the report.
 *
 * ## Why the test rather than a threshold
 *
 * The obvious implementation flags adherence below some percentage. It is wrong
 * in both directions, and predictably so. Fourteen days containing a weekend
 * away puts a 95%-adherent operator under 80% and fires; a slow slide from 98%
 * to 88% over three months never crosses the line and stays silent. The
 * binomial answers the question actually being asked — *is this run of doses
 * surprising for someone whose established rate is what it is* — and it scales
 * correctly with the number of doses, so a bad fortnight on a once-daily
 * medication is not treated as equivalent evidence to a bad fortnight on a
 * four-times-daily one.
 *
 * ## The caveat that appears on every finding
 *
 * A missed dose and an untaken log are indistinguishable in this data, and
 * saying so is not a disclaimer — it is the single most likely explanation for
 * any deviation this detector will ever report. It is in `doesNotProve` on both
 * finding kinds.
 */

import { binomialTailBelow } from '../statistics/binomial';
import type { DetectorOutcome, Finding, FindingEvidence, InsufficientData } from './types';
import { findingId, findingSignature } from './types';

/** Recorded days needed in the recent window before a report is produced. */
export const MIN_RECORDED_DAYS = 7;

/**
 * Scheduled doses needed in the baseline before a deviation may be tested.
 *
 * Thirty, matching §10.6's stated gate for correlation ("at least 30 paired
 * observations"). Below it the baseline rate is itself so uncertain that the
 * test is comparing a noisy fortnight against a noisy month.
 */
export const MIN_BASELINE_UNITS = 30;

/** The recent window a deviation is tested over. */
export const RECENT_WINDOW_DAYS = 14;

export type AdherenceDay = {
  readonly dayKey: string;
  /** Doses or required steps scheduled. */
  readonly expected: number;
  /** Doses taken or steps completed. */
  readonly completed: number;
  readonly recorded: boolean;
};

export type AdherenceSeries = {
  /** `medication:<uuid>` or `routine:<uuid>`. */
  readonly subject: string;
  readonly label: string;
  readonly kind: 'medication' | 'routine';
  /** Oldest first. Unrecorded days are present and are never counted. */
  readonly days: readonly AdherenceDay[];
};

const UNIT_WORD: Readonly<Record<AdherenceSeries['kind'], string>> = Object.freeze({
  medication: 'doses',
  routine: 'steps',
});

const DOES_NOT_PROVE_REPORT =
  'This counts what was logged. A dose taken and not logged is indistinguishable here from one that was not taken, so the figure is a floor rather than a measurement.';

const DOES_NOT_PROVE_DEVIATION =
  'This shows that the recent run of logged doses is unlikely for the established rate. It does not show why. The most likely explanation for any change of this kind is a change in logging rather than in behaviour, and nothing here can separate the two.';

export type AdherenceOptions = {
  /** Whether inferential findings are permitted — the §10.6 day-60 gate. */
  readonly inferentialAllowed: boolean;
  readonly recentWindowDays?: number;
};

export function detectAdherence(
  series: AdherenceSeries,
  dayKey: string,
  options: AdherenceOptions,
): DetectorOutcome {
  const recentDays = options.recentWindowDays ?? RECENT_WINDOW_DAYS;
  const ordered = [...series.days].sort((a, b) => (a.dayKey < b.dayKey ? -1 : a.dayKey > b.dayKey ? 1 : 0));

  const recent = ordered.slice(-recentDays);
  const baseline = ordered.slice(0, Math.max(0, ordered.length - recentDays));

  const recentTotals = totals(recent);
  const baselineTotals = totals(baseline);

  const findings: Finding[] = [];
  const insufficient: InsufficientData[] = [];
  const evidence: readonly FindingEvidence[] = [
    { kind: series.kind, id: series.subject.split(':')[1] ?? series.subject, label: series.label },
  ];
  const unit = UNIT_WORD[series.kind];

  /* --- The report ---------------------------------------------------- */
  if (recentTotals.recordedDays < MIN_RECORDED_DAYS) {
    insufficient.push({
      detector: 'adherence',
      subject: series.subject,
      required: MIN_RECORDED_DAYS,
      available: recentTotals.recordedDays,
      message: `${series.label} needs ${String(MIN_RECORDED_DAYS)} days with a record in the last ${String(recentDays)} to report adherence. There are ${String(recentTotals.recordedDays)}.`,
    });
  } else if (recentTotals.expected > 0) {
    const ratio = recentTotals.completed / recentTotals.expected;
    findings.push({
      id: findingId('adherence', series.subject, dayKey, 'report'),
      signature: findingSignature('adherence', series.subject, 'report'),
      detector: 'adherence',
      subject: series.subject,
      dayKey,
      headline: `${series.label}: ${String(recentTotals.completed)} of ${String(recentTotals.expected)} scheduled ${unit} logged over the last ${String(recentDays)} days.`,
      detail:
        recentTotals.unrecordedDays === 0
          ? 'Every day in the window has a record.'
          : `${String(recentTotals.unrecordedDays)} of those days have no record either way, and are not counted on either side.`,
      n: recentTotals.expected,
      effect: formatRatio(ratio),
      confidence: 'descriptive',
      doesNotProve: DOES_NOT_PROVE_REPORT,
      pValue: null,
      evidence,
    });
  }

  /* --- The deviation ------------------------------------------------- */
  if (!options.inferentialAllowed) return { findings, insufficient };

  if (baselineTotals.expected < MIN_BASELINE_UNITS) {
    insufficient.push({
      detector: 'adherence',
      subject: series.subject,
      required: MIN_BASELINE_UNITS,
      available: baselineTotals.expected,
      message: `Comparing ${series.label} against a baseline needs ${String(MIN_BASELINE_UNITS)} scheduled ${unit} before the recent window. There are ${String(baselineTotals.expected)}.`,
    });
    return { findings, insufficient };
  }

  if (recentTotals.expected === 0) return { findings, insufficient };

  const baselineRate = baselineTotals.completed / baselineTotals.expected;
  const recentRate = recentTotals.completed / recentTotals.expected;

  /*
   * Only a drop is tested. A rise is not a deviation anybody needs told about,
   * and testing it would double the comparison count that everything else in
   * the battery pays for. See `binomialTailBelow`.
   */
  if (recentRate >= baselineRate) return { findings, insufficient };

  const pValue = binomialTailBelow(recentTotals.completed, recentTotals.expected, baselineRate);

  findings.push({
    id: findingId('adherence', series.subject, dayKey, 'deviation'),
    signature: findingSignature('adherence', series.subject, 'deviation'),
    detector: 'adherence',
    subject: series.subject,
    dayKey,
    headline: `${series.label} is at ${formatRatio(recentRate)} over the last ${String(recentDays)} days, against an established ${formatRatio(baselineRate)}.`,
    detail: `${String(recentTotals.completed)} of ${String(recentTotals.expected)} scheduled ${unit} in the recent window; ${String(baselineTotals.completed)} of ${String(baselineTotals.expected)} before it.`,
    n: recentTotals.expected,
    effect: `${formatRatio(recentRate)} against ${formatRatio(baselineRate)}`,
    /*
     * Exploratory on first detection, always. Promotion to `confirmed` is the
     * battery's job (§10.6 control 4) because only the battery can see whether
     * this same finding was held on a previous run.
     */
    confidence: 'exploratory',
    doesNotProve: DOES_NOT_PROVE_DEVIATION,
    pValue,
    evidence,
  });

  return { findings, insufficient };
}

type Totals = {
  readonly expected: number;
  readonly completed: number;
  readonly recordedDays: number;
  readonly unrecordedDays: number;
};

/** Unrecorded days contribute to neither numerator nor denominator. */
function totals(days: readonly AdherenceDay[]): Totals {
  let expected = 0;
  let completed = 0;
  let recordedDays = 0;
  for (const day of days) {
    if (!day.recorded) continue;
    recordedDays += 1;
    expected += day.expected;
    completed += day.completed;
  }
  return { expected, completed, recordedDays, unrecordedDays: days.length - recordedDays };
}

function formatRatio(ratio: number): string {
  return `${String(Math.round(ratio * 100))}%`;
}
