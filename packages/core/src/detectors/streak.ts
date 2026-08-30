/**
 * The streak detector — §2.1's "streak-break detection".
 *
 * ## Purely descriptive, and deliberately so
 *
 * A streak is a count of consecutive days. There is no baseline, no test, and
 * no inference, so every finding here is `descriptive` and none carries a
 * p-value. That is not a shortcut — it is what a streak *is*, and dressing one
 * up with a significance figure would be the over-claiming §10.6 exists to
 * prevent.
 *
 * ## How a break is reported, and how it is not
 *
 * §4.7's first design principle governs the wording of everything in this file:
 * "No negative framing, ever. No red. No 'you missed.'" §14.1's second finding
 * goes further and applies it to the whole system — "after a gap of three or
 * more days the system offers optional backfill and says nothing about the gap.
 * No guilt copy, no 'you missed 4 days,' no recovery streak."
 *
 * So a break is reported as a *fact about a run that ended*: "A 21-day run of
 * the evening routine ended on 14 August." Not as a loss, not with a count of
 * days since, and never with an invitation to start again. The operator can see
 * that the run ended; they do not need it characterised.
 *
 * And a break is only reported **once**, within {@link BREAK_REPORT_WINDOW_DAYS}
 * of the day it happened. A finding that keeps reappearing for a fortnight is
 * the guilt copy §14.1 forbids, arriving by repetition instead of by wording.
 */

import { dayKeyIndex } from '../temporal/instant';
import type { DetectorOutcome, Finding, InsufficientData } from './types';
import { findingId, findingSignature } from './types';

/**
 * The shortest run worth mentioning.
 *
 * Seven. A three-day run is a Tuesday, a Wednesday and a Thursday; calling it a
 * streak trains the operator to discount the word, which costs the twenty-day
 * run its meaning.
 */
export const MIN_STREAK_DAYS = 7;

/** How soon after a run ends the ending is still news. */
export const BREAK_REPORT_WINDOW_DAYS = 3;

export type StreakDay = {
  readonly dayKey: string;
  /** Whether the day counts towards the run. */
  readonly complete: boolean;
};

export type StreakSeries = {
  readonly subject: string;
  readonly label: string;
  /** Oldest first, one entry per day in the window, gaps included as `false`. */
  readonly days: readonly StreakDay[];
};

const DOES_NOT_PROVE =
  'This counts consecutive days with a complete log. A day with no log ends the run whether or not the thing was done, so a run ending is as much a statement about logging as about behaviour.';

export function detectStreak(series: StreakSeries, dayKey: string): DetectorOutcome {
  const ordered = [...series.days].sort((a, b) => (a.dayKey < b.dayKey ? -1 : a.dayKey > b.dayKey ? 1 : 0));

  const findings: Finding[] = [];
  const insufficient: InsufficientData[] = [];

  if (ordered.length < MIN_STREAK_DAYS) {
    insufficient.push({
      detector: 'streak',
      subject: series.subject,
      required: MIN_STREAK_DAYS,
      available: ordered.length,
      message: `${series.label} needs ${String(MIN_STREAK_DAYS)} days of history before a run can be reported. There are ${String(ordered.length)}.`,
    });
    return { findings, insufficient };
  }

  const current = trailingRun(ordered);

  if (current.length >= MIN_STREAK_DAYS) {
    findings.push({
      id: findingId('streak', series.subject, dayKey, 'current'),
      signature: findingSignature('streak', series.subject, 'current'),
      detector: 'streak',
      subject: series.subject,
      dayKey,
      headline: `${series.label} has a complete log on ${String(current.length)} consecutive days.`,
      detail: `The run starts on ${current.startDayKey ?? dayKey}.`,
      n: current.length,
      effect: `${String(current.length)} days`,
      confidence: 'descriptive',
      doesNotProve: DOES_NOT_PROVE,
      pValue: null,
      evidence: [{ kind: 'streak', id: series.subject, label: series.label }],
    });
    return { findings, insufficient };
  }

  /*
   * No current run. Was there one that ended recently? `endedRun` looks only at
   * the most recent completed run, so an old streak from March never resurfaces.
   */
  const ended = mostRecentEndedRun(ordered);
  if (ended === null || ended.length < MIN_STREAK_DAYS) return { findings, insufficient };

  const daysSince = daysBetween(ended.endDayKey, dayKey);
  if (daysSince === null || daysSince > BREAK_REPORT_WINDOW_DAYS) return { findings, insufficient };

  findings.push({
    id: findingId('streak', series.subject, ended.endDayKey, 'ended'),
    signature: findingSignature('streak', series.subject, 'ended'),
    detector: 'streak',
    subject: series.subject,
    dayKey,
    /* Stated, not characterised. See the header. */
    headline: `${capitalise(indefiniteArticle(ended.length))} ${String(ended.length)}-day run of ${series.label} ended on ${ended.endDayKey}.`,
    detail: `The run started on ${ended.startDayKey}.`,
    n: ended.length,
    effect: `${String(ended.length)} days`,
    confidence: 'descriptive',
    doesNotProve: DOES_NOT_PROVE,
    pValue: null,
    evidence: [{ kind: 'streak', id: series.subject, label: series.label }],
  });

  return { findings, insufficient };
}

type Run = { readonly length: number; readonly startDayKey: string | null; readonly endDayKey: string };

function trailingRun(days: readonly StreakDay[]): { readonly length: number; readonly startDayKey: string | null } {
  let length = 0;
  let startDayKey: string | null = null;
  for (let index = days.length - 1; index >= 0; index -= 1) {
    const day = days[index];
    if (day === undefined || !day.complete) break;
    length += 1;
    startDayKey = day.dayKey;
  }
  return { length, startDayKey };
}

/** The most recent completed run — one that has an incomplete day after it. */
function mostRecentEndedRun(days: readonly StreakDay[]): Run | null {
  let end: number | null = null;
  for (let index = days.length - 1; index >= 0; index -= 1) {
    const day = days[index];
    if (day === undefined) continue;
    if (day.complete) {
      end = index;
      break;
    }
  }
  if (end === null) return null;

  let start = end;
  while (start > 0) {
    const previous = days[start - 1];
    if (previous === undefined || !previous.complete) break;
    start -= 1;
  }

  const endDay = days[end];
  const startDay = days[start];
  if (endDay === undefined || startDay === undefined) return null;

  return { length: end - start + 1, startDayKey: startDay.dayKey, endDayKey: endDay.dayKey };
}

/**
 * "an 8-day run", "an 18-day run", "a 21-day run".
 *
 * Petty, and worth the six lines. This string is the only thing the operator
 * sees of this detector, and "A 8-day run" reads as a bug in a way that quietly
 * undermines every other number on the screen.
 *
 * Covers the cases a day count can actually reach: anything starting with an 8
 * (eight, eighty, eight hundred), and exactly eleven and eighteen. 1100 reads as
 * "one thousand one hundred", so the leading-digit rule correctly leaves it.
 */
function indefiniteArticle(count: number): string {
  if (String(count).startsWith('8')) return 'an';
  return count === 11 || count === 18 ? 'an' : 'a';
}

function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function daysBetween(from: string, to: string): number | null {
  const start = dayKeyIndex(from);
  const end = dayKeyIndex(to);
  if (start === null || end === null) return null;
  return end - start;
}
