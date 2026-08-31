/**
 * The review draft — §4.12.
 *
 *   "Model-drafted from the record, human-edited, permanently archived as
 *    first-class documents. The draft is the labour-saving part; the editing is
 *    the value. A review the user did not edit is a review they did not do, and
 *    the system should treat an unedited draft as incomplete rather than as a
 *    completed review."
 *
 * ## The draft is assembled here, deterministically, and that is not a downgrade
 *
 * Exactly like the Consultation Pack (§10.7): **every figure in the draft comes
 * from this file**, out of counts and means the repositories computed in SQL.
 * §10.0 is the governing constraint — "the model never computes, discovers, or
 * asserts. It retrieves, explains, ranks, and drafts." A model may later
 * rephrase the connective prose between these lines. It may not produce one
 * number, one date, one title, or one of the questions' claims.
 *
 * The consequence is the useful one: {@link assembleDraft} works with no model
 * available, no API key configured, and no budget remaining. A Sunday-evening
 * review that degraded to a blank page when the month's token cap was hit would
 * fail on the one evening the habit is most fragile.
 *
 * ## Two rules the whole file exists to hold
 *
 * **Coverage leads.** A review drafted from eleven of thirty days is a review of
 * eleven days. §8.9(3) — "missing data is shown as missing" — is a rule about
 * charts, and this is the same rule applied to prose.
 *
 * **Absent figures are omitted, never zeroed.** A section with nothing in it is
 * dropped rather than rendered as "0 sessions", because the operator knows
 * perfectly well whether they trained and a zero is the system asserting
 * something it did not observe. §4.7's rule that an unlogged day is not a
 * missed one, in a different surface.
 */

import { CAREER_KIND_LABELS, isCareerEntryKind } from '../work/career';
import { REVIEW_KIND_LABELS } from './period';
import type { ReviewKind, ReviewPeriod, ReviewState } from './period';

/**
 * Everything the draft is allowed to know.
 *
 * Deliberately flat and pre-aggregated. The repositories run the queries; this
 * file arranges the answers. Nothing here is an entity the drafter could be
 * tempted to re-derive a figure from, which is what keeps §10.0's boundary
 * visible in the type rather than only in the prose.
 */
export type ReviewInputs = {
  readonly period: ReviewPeriod;
  /** Daily Closes completed in the period. The denominator of the record. */
  readonly closedDays: number;
  readonly totalDays: number;
  readonly sleep: {
    readonly nights: number;
    readonly meanDurationHours: number | null;
    readonly meanQuality: number | null;
  };
  readonly training: { readonly sessions: number; readonly totalVolume: string | null };
  readonly mood: {
    readonly mean: number | null;
    readonly low: number | null;
    readonly high: number | null;
    readonly observations: number;
  };
  readonly tasksClosed: number;
  readonly careerEntries: readonly {
    readonly kind: string;
    readonly title: string;
    readonly occurredAt: string;
  }[];
  readonly learningFinished: readonly string[];
  readonly insightsActedOn: number;
  readonly goalsAchieved: readonly string[];
};

export type DraftSection = { readonly heading: string; readonly lines: readonly string[] };

export type ReviewDraft = {
  readonly period: ReviewPeriod;
  readonly sections: readonly DraftSection[];
  /** How much of the period was actually recorded. Rendered before anything else. */
  readonly coverage: string;
  readonly prompts: readonly string[];
};

/* -------------------------------------------------------------------------
 * The questions
 * ---------------------------------------------------------------------- */

/**
 * The prompts, per kind. **Every one is a question.**
 *
 * Not one of these is a conclusion, a summary, or an observation phrased with a
 * question mark on the end. §10.0 puts the model outside the business of
 * asserting, and a prompt list is the easiest place in the whole system for an
 * assertion to arrive disguised as helpfulness — "you slept badly in the second
 * half of the month; what happened?" is a finding, not a question, and the
 * system did not run the test that would let it say so.
 *
 * §4.7's reason applies too: the prompts are read on an evening when the
 * operator is tired, and a system that tells a tired person what their month
 * meant will be believed.
 */
export const REVIEW_PROMPTS: Readonly<Record<ReviewKind, readonly string[]>> = Object.freeze({
  weekly: Object.freeze([
    'What went differently from the week you intended?',
    'Which day this week would you take back, and what happened on it?',
    'What is carrying into next week that you have not written down anywhere?',
  ]),
  monthly: Object.freeze([
    'What changed between the first half of the month and the second?',
    "Which of this month's entries will still matter in a year?",
    'What did you stop doing, and was that a decision or a drift?',
  ]),
  quarterly: Object.freeze([
    'What is different about you at the end of this quarter than at the start?',
    'Which goal did the record actually serve, and which one only had your attention?',
    'What would have to change for the next quarter not to look like this one?',
  ]),
  annual: Object.freeze([
    'What happened this year that you would not have predicted in January?',
    'Which habit held for the whole year, and which one did not survive contact with it?',
    'What would you tell yourself twelve months ago, in one sentence?',
  ]),
});

/* -------------------------------------------------------------------------
 * Assembly
 * ---------------------------------------------------------------------- */

/**
 * A figure, or nothing.
 *
 * `null` for a non-finite value as well as for an absent one. A mean over zero
 * nights is `NaN`, and `NaN` rendered into a permanently archived document
 * reads as a bug forever; §8.9(3) says a missing figure is shown as missing, and
 * the honest rendering of a mean with no denominator is no line at all.
 *
 * One decimal, with a bare `.0` trimmed, so `7` and `7.2` both read as numbers a
 * person wrote rather than as float output.
 */
function figure(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  const fixed = value.toFixed(1);
  return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed;
}

function plural(count: number, singular: string, pluralForm: string): string {
  return `${String(count)} ${count === 1 ? singular : pluralForm}`;
}

/** A section, or nothing if it has no lines. Never a section of zeroes. */
function section(heading: string, lines: readonly (string | null)[]): DraftSection | null {
  const kept = lines.filter((line): line is string => line !== null);
  return kept.length === 0 ? null : { heading, lines: kept };
}

/**
 * The sentence that leads every draft.
 *
 * Written as a count of days rather than a percentage. "37%" invites the reader
 * to treat the review as approximately complete; "11 of 30 days were closed"
 * says what actually happened, and the two readings produce different amounts of
 * trust in the figures underneath.
 */
function coverageSentence(closedDays: number, totalDays: number, kindLabel: string): string {
  const lower = kindLabel.toLowerCase();

  /* A period of no days is not a real period. Said rather than divided by. */
  if (totalDays <= 0) {
    return `This ${lower} period contains no days, so there is nothing to review.`;
  }

  if (closedDays <= 0) {
    return `No day in this ${String(totalDays)}-day period was closed. Everything below was captured in passing, and most of the period is simply unrecorded — read it as a fragment, not as a summary.`;
  }

  if (closedDays >= totalDays) {
    return `Every one of the ${String(totalDays)} days in this period was closed. The figures below cover the whole period.`;
  }

  const missing = totalDays - closedDays;
  return `${String(closedDays)} of ${String(totalDays)} days in this period were closed. ${plural(missing, 'day has', 'days have')} no Daily Close, so this is a review of ${String(closedDays)} days, not of the whole period.`;
}

/**
 * What the draft says when the record is empty.
 *
 * An empty period still produces a document, and the document says the period
 * is empty. A blank page would be indistinguishable from a drafting failure,
 * and the operator would have to go and check — which is the small friction that
 * ends a review habit.
 */
export const EMPTY_RECORD_HEADING = 'Nothing on record';

const EMPTY_RECORD_LINE =
  'No sleep, training, mood, work, learning or goal activity was recorded in this period. That is a fact about the record rather than about the period, and the questions below are still worth answering from memory.';

/**
 * Assemble the draft.
 *
 * Every line below is a rearrangement of a number the caller already computed.
 * Nothing is inferred, ranked, or explained. See the file header.
 */
export function assembleDraft(inputs: ReviewInputs): ReviewDraft {
  const sections: DraftSection[] = [];

  const sleep = section('Sleep', [
    inputs.sleep.nights > 0 ? `${plural(inputs.sleep.nights, 'night', 'nights')} recorded.` : null,
    mapFigure(inputs.sleep.meanDurationHours, (value) => `Mean duration ${value} hours.`),
    mapFigure(inputs.sleep.meanQuality, (value) => `Mean quality ${value} of 5.`),
  ]);
  if (sleep !== null) sections.push(sleep);

  const training = section('Training', [
    inputs.training.sessions > 0
      ? `${plural(inputs.training.sessions, 'session', 'sessions')} completed.`
      : null,
    /* The unit is not appended. `totalVolume` arrives as a decimal string
     * (§5.3 — no floats for weight), and the caller owns what it is measured
     * in; adding "kg" here would be this file asserting a unit it never saw. */
    inputs.training.totalVolume === null ? null : `Total volume ${inputs.training.totalVolume}.`,
  ]);
  if (training !== null) sections.push(training);

  const mood = section('Mood', [
    inputs.mood.observations > 0
      ? `${plural(inputs.mood.observations, 'observation', 'observations')} recorded.`
      : null,
    mapFigure(inputs.mood.mean, (value) => `Mean ${value} of 5.`),
    /* Range only when both ends are known. A "low of 2" with no high is not a
     * range, and printing half of one invites the reader to supply the other. */
    figure(inputs.mood.low) !== null && figure(inputs.mood.high) !== null
      ? `Range ${String(figure(inputs.mood.low))} to ${String(figure(inputs.mood.high))}.`
      : null,
  ]);
  if (mood !== null) sections.push(mood);

  const work = section('Work', [
    inputs.tasksClosed > 0 ? `${plural(inputs.tasksClosed, 'task', 'tasks')} closed.` : null,
    ...careerLines(inputs.careerEntries),
  ]);
  if (work !== null) sections.push(work);

  const learning = section(
    'Learning',
    inputs.learningFinished.map((title) => `Finished ${title}.`),
  );
  if (learning !== null) sections.push(learning);

  const goals = section(
    'Goals',
    inputs.goalsAchieved.map((title) => `Achieved ${title}.`),
  );
  if (goals !== null) sections.push(goals);

  const insights = section('Insights', [
    inputs.insightsActedOn > 0
      ? `${plural(inputs.insightsActedOn, 'insight', 'insights')} acted on.`
      : null,
  ]);
  if (insights !== null) sections.push(insights);

  return {
    period: inputs.period,
    sections:
      sections.length === 0 ? [{ heading: EMPTY_RECORD_HEADING, lines: [EMPTY_RECORD_LINE] }] : sections,
    coverage: coverageSentence(
      inputs.closedDays,
      inputs.totalDays,
      REVIEW_KIND_LABELS[inputs.period.kind],
    ),
    prompts: REVIEW_PROMPTS[inputs.period.kind],
  };
}

/** Apply a template to a figure, or produce nothing. Keeps the omit rule in one place. */
function mapFigure(value: number | null, template: (formatted: string) => string): string | null {
  const formatted = figure(value);
  return formatted === null ? null : template(formatted);
}

/**
 * The career log's contribution, oldest first.
 *
 * Re-sorted rather than taken as given, because a review reads the period
 * forward — the order the rows happened to come back in is not an order anybody
 * chose. Ties break on title so the same set always renders identically, which
 * is what {@link draftToMarkdown}'s diffability depends on.
 */
function careerLines(
  entries: readonly { readonly kind: string; readonly title: string; readonly occurredAt: string }[],
): readonly string[] {
  return [...entries]
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.title.localeCompare(b.title))
    .map((entry) => {
      /* The raw enum value if it is not one this build knows. A future
       * `career_entry_kind` must render as itself rather than disappear. */
      const label = isCareerEntryKind(entry.kind) ? CAREER_KIND_LABELS[entry.kind] : entry.kind;
      return `${label}: ${entry.title} (${entry.occurredAt.slice(0, 10)}).`;
    });
}

/* -------------------------------------------------------------------------
 * Rendering
 * ---------------------------------------------------------------------- */

/**
 * The draft as Markdown.
 *
 * **Deterministic and stable: the same inputs produce byte-identical output.**
 * That is a requirement rather than a nicety. §4.12 makes the operator's edit
 * the valuable artefact, so a re-draft has to be diffable against what they
 * edited — and a diff is useless if re-running the drafter reorders a list or
 * stamps a generation time into the header. Nothing here reads a clock.
 *
 * Trailing newline, LF only, no trailing spaces: the file is stored, exported
 * (§9.10) and read by tools that care.
 */
export function draftToMarkdown(draft: ReviewDraft): string {
  const lines: string[] = [
    `# ${REVIEW_KIND_LABELS[draft.period.kind]} review — ${draft.period.label}`,
    '',
    `${draft.period.fromDayKey} to ${draft.period.toDayKey}`,
    '',
    /* Coverage before any figure, so it cannot be read past. */
    draft.coverage,
  ];

  for (const part of draft.sections) {
    lines.push('', `## ${part.heading}`, '');
    for (const line of part.lines) lines.push(`- ${line}`);
  }

  if (draft.prompts.length > 0) {
    lines.push('', '## Questions', '');
    for (const prompt of draft.prompts) lines.push(`- ${prompt}`);
  }

  return `${lines.join('\n')}\n`;
}

/* -------------------------------------------------------------------------
 * Completion
 * ---------------------------------------------------------------------- */

/**
 * Whether a review counts as done.
 *
 * §4.12: "a review the user did not edit is a review they did not do, and the
 * system should treat an unedited draft as incomplete rather than as a completed
 * review."
 *
 * So `state === 'complete'` is necessary and **not sufficient**. Whitespace is
 * not an edit either — a review completed by clicking into the box and out again
 * is the same non-event as one never opened, and the whole feature is worthless
 * the moment the completion count can be raised without doing the work.
 *
 * Enforced here as well as by the `review_complete_requires_edit` CHECK. The
 * constraint stops a null reaching the archive; this stops a space.
 */
export function isReviewComplete(state: ReviewState, editedContent: string | null): boolean {
  if (editedContent === null || editedContent.trim() === '') return false;
  return state === 'complete';
}
