/**
 * Appointments, and the pre-visit question list.
 *
 * This is P5's deliverable, stated as plainly as the blueprint states it:
 *
 *   "The deliverable of a medical insight is *a better question for your next
 *    appointment*, printed and ready."
 *
 * Everything the system knows converges here. A lab result outside its printed
 * range, a medication taken on 22 of 30 days, a side effect never mentioned to
 * the person who prescribed it — none of those are conclusions this system is
 * entitled to draw, and all of them are things worth saying out loud in a
 * fifteen-minute consultation that would otherwise be spent remembering.
 *
 * ## Every question is a question
 *
 * Not a recommendation, not a finding, not a suggestion with a question mark
 * bolted on. `"Should I increase my dose?"` is a treatment proposal wearing a
 * disguise; `"This was 14 ng/mL on 12 September, below the printed range — what
 * should be done about it?"` is a fact and an open question. The difference is
 * the whole of P5 and it is enforced here by construction: each question is
 * built from a template that states an observation and then asks.
 *
 * ## Derivation is deterministic and the id is stable
 *
 * No model, no ranking model, no learning. The same inputs produce the same
 * list, and each question's id is derived from its source row — so re-deriving
 * after a new lab result does not duplicate the questions already on the list,
 * and a question the operator deleted stays deleted.
 *
 * ## The list is capped
 *
 * At {@link MAX_QUESTIONS}. An appointment is minutes long, and a list of
 * thirty questions is a list that gets folded up in a pocket. What was left off
 * is reported rather than hidden, because a silently truncated list is worse
 * than a long one.
 */

import { parseInstant } from '../../temporal/instant';
import type { LabFlag } from './reference-range';
import { isCritical, isOutOfRange } from './reference-range';

/** How many questions a person can actually ask in one visit. */
export const MAX_QUESTIONS = 8;

/** Adherence at or below this is stated as a fact, never as a failure. */
export const ADHERENCE_MENTION_THRESHOLD = 0.85;

/** A `suspected` diagnosis older than this is worth resolving one way or another. */
export const SUSPECTED_STALE_DAYS = 90;

/** A symptom recurring this often since the last visit is worth naming. */
export const SYMPTOM_RECURRENCE_THRESHOLD = 3;

export type QuestionSource = 'lab' | 'adherence' | 'side_effect' | 'symptom' | 'condition' | 'manual';

export type AppointmentQuestion = {
  /** Deterministic. Re-deriving does not duplicate; deleting is durable. */
  readonly id: string;
  readonly question: string;
  /** The fact it rests on, in one line. Rendered under the question. */
  readonly evidence: string;
  readonly source: QuestionSource;
  readonly sourceId: string | null;
};

export type Appointment = {
  readonly id: string;
  readonly medicalEventId: string;
  readonly title: string;
  readonly provider: string | null;
  readonly specialty: string | null;
  readonly location: string | null;
  readonly scheduledFor: string | null;
  readonly zone: string | null;
  readonly attendedAt: string | null;
  readonly preVisitQuestions: readonly AppointmentQuestion[];
  readonly postVisitNotes: string | null;
  readonly outcome: string | null;
  readonly followUpDue: string | null;
};

/* -------------------------------------------------------------------------
 * Derivation inputs
 *
 * Deliberately flat and pre-fetched. `core` does no IO, and a derivation that
 * took a repository would be a derivation that could not be tested without a
 * database — which is how a rule this important stops being exercised.
 * ---------------------------------------------------------------------- */

export type LabHighlight = {
  readonly resultId: string;
  readonly analyte: string;
  readonly value: string;
  readonly unit: string | null;
  readonly flag: LabFlag | null;
  readonly flagSource: 'printed' | 'derived' | 'none';
  readonly rangeText: string;
  readonly collectedAt: string | null;
  /** The previous result for the same analyte, when there is one. */
  readonly previous: { readonly value: string; readonly collectedAt: string | null } | null;
};

export type AdherenceHighlight = {
  readonly medicationId: string;
  readonly label: string;
  readonly daysTaken: number;
  readonly daysExpected: number;
  readonly windowDays: number;
};

export type SideEffectHighlight = {
  readonly sideEffectId: string;
  readonly effect: string;
  readonly medicationLabel: string | null;
  readonly onsetAt: string | null;
  readonly reportedToPrescriber: boolean;
};

export type SymptomHighlight = {
  readonly name: string;
  readonly count: number;
  readonly since: string | null;
};

export type ConditionHighlight = {
  readonly conditionId: string;
  readonly name: string;
  readonly status: string;
  readonly recordedFrom: string;
};

export type QuestionInput = {
  readonly labs: readonly LabHighlight[];
  readonly adherence: readonly AdherenceHighlight[];
  readonly sideEffects: readonly SideEffectHighlight[];
  readonly symptoms: readonly SymptomHighlight[];
  readonly conditions: readonly ConditionHighlight[];
  /** For the staleness check on suspected diagnoses. */
  readonly nowIso: string;
};

export type DerivedQuestions = {
  readonly questions: readonly AppointmentQuestion[];
  /** How many were derived and then cut by the cap. Shown, not hidden. */
  readonly omitted: number;
};

type Ranked = { readonly rank: number; readonly question: AppointmentQuestion };

/**
 * Build the question list.
 *
 * Ordering is by *what is hardest to raise later*, not by how interesting the
 * finding is. A critical lab value and an unmentioned side effect come first
 * because they are the two things a person is most likely to leave the room
 * without saying; a recurring symptom comes last because it will still be
 * there next month.
 */
export function deriveQuestions(input: QuestionInput): DerivedQuestions {
  const ranked: Ranked[] = [];

  for (const lab of input.labs) {
    if (!isOutOfRange(lab.flag)) continue;

    const unit = lab.unit === null || lab.unit === '' ? '' : ` ${lab.unit}`;
    const when = lab.collectedAt === null ? null : formatDay(lab.collectedAt);
    const on = when === null ? '' : ` on ${when}`;
    const direction = lab.flag === 'low' || lab.flag === 'critical_low' ? 'below' : 'outside';

    /*
     * The derived-flag caveat travels into the evidence line rather than being
     * dropped. A flag this system computed because the report printed none is
     * a weaker fact than one the laboratory printed, and carrying it into a
     * consultation without saying so would be presenting arithmetic as a
     * laboratory's judgement.
     */
    const caveat =
      lab.flagSource === 'derived'
        ? ' The report printed no flag for this line; the comparison is against the range printed beside it.'
        : '';

    const movement =
      lab.previous === null
        ? ''
        : ` It was ${lab.previous.value}${unit}${lab.previous.collectedAt === null ? '' : ` on ${formatDay(lab.previous.collectedAt) ?? lab.previous.collectedAt}`}.`;

    ranked.push({
      rank: isCritical(lab.flag) ? 0 : 2,
      question: {
        id: `lab:${lab.resultId}`,
        question: `${lab.analyte} was ${lab.value}${unit}${on}, ${direction} the range printed on that report (${lab.rangeText}). What, if anything, should be done about it?`,
        evidence: `Recorded from a lab report.${movement}${caveat}`,
        source: 'lab',
        sourceId: lab.resultId,
      },
    });
  }

  for (const effect of input.sideEffects) {
    if (effect.reportedToPrescriber) continue;
    const taking = effect.medicationLabel === null ? '' : ` while taking ${effect.medicationLabel}`;
    const started = effect.onsetAt === null ? '' : ` since ${formatDay(effect.onsetAt) ?? effect.onsetAt}`;
    ranked.push({
      rank: 1,
      question: {
        id: `side_effect:${effect.sideEffectId}`,
        question: `I have had ${effect.effect}${started}${taking}, and I have not mentioned it before. Is it related, and does anything need to change?`,
        evidence: 'Recorded in the side-effect log and not yet marked as reported.',
        source: 'side_effect',
        sourceId: effect.sideEffectId,
      },
    });
  }

  for (const entry of input.adherence) {
    if (entry.daysExpected <= 0) continue;
    const ratio = entry.daysTaken / entry.daysExpected;
    if (ratio > ADHERENCE_MENTION_THRESHOLD) continue;
    ranked.push({
      rank: 3,
      question: {
        id: `adherence:${entry.medicationId}`,
        question: `I recorded taking ${entry.label} on ${String(entry.daysTaken)} of the last ${String(entry.windowDays)} days. Does that change how it should be judged?`,
        evidence:
          'Counted from the medication log. Days with no record are counted as unknown, not as missed — the real figure is this or better.',
        source: 'adherence',
        sourceId: entry.medicationId,
      },
    });
  }

  for (const condition of input.conditions) {
    if (condition.status !== 'suspected') continue;
    const days = daysSince(condition.recordedFrom, input.nowIso);
    if (days === null || days < SUSPECTED_STALE_DAYS) continue;
    ranked.push({
      rank: 4,
      question: {
        id: `condition:${condition.conditionId}`,
        question: `${condition.name} has been on my record as suspected since ${formatDay(condition.recordedFrom) ?? condition.recordedFrom}. Is it confirmed, or should it come off?`,
        evidence: `Suspected for ${String(days)} days with no change of status.`,
        source: 'condition',
        sourceId: condition.conditionId,
      },
    });
  }

  for (const symptom of input.symptoms) {
    if (symptom.count < SYMPTOM_RECURRENCE_THRESHOLD) continue;
    const since = symptom.since === null ? '' : ` since ${formatDay(symptom.since) ?? symptom.since}`;
    ranked.push({
      rank: 5,
      question: {
        id: `symptom:${symptom.name.trim().toLowerCase()}`,
        question: `${symptom.name} has come up ${String(symptom.count)} times${since}. Is there anything worth looking into?`,
        evidence: 'Counted from the symptom log.',
        source: 'symptom',
        sourceId: null,
      },
    });
  }

  /*
   * Stable sort within a rank: the array order is preserved by `Array.sort` in
   * every engine this runs on, and the inputs arrive in a deterministic order
   * from SQL. A tie broken by chance would reorder the printed list between two
   * views of the same appointment, which reads as the system changing its mind.
   */
  const sorted = [...ranked].sort((a, b) => a.rank - b.rank);
  const kept = sorted.slice(0, MAX_QUESTIONS).map((entry) => entry.question);

  return { questions: kept, omitted: Math.max(0, sorted.length - kept.length) };
}

/**
 * Fold a freshly derived list into the one already saved.
 *
 * Saved questions win on identity, so an edit survives a re-derivation, and
 * manually written questions — which have no derived counterpart — always
 * survive. New derivations are appended rather than interleaved: the operator
 * has read the top of this list already, and reordering it under them is how a
 * prepared list stops being trusted.
 */
export function mergeQuestions(
  saved: readonly AppointmentQuestion[],
  derived: readonly AppointmentQuestion[],
): readonly AppointmentQuestion[] {
  const seen = new Set(saved.map((question) => question.id));
  return [...saved, ...derived.filter((question) => !seen.has(question.id))];
}

/* -------------------------------------------------------------------------
 * Reads
 * ---------------------------------------------------------------------- */

/** The next appointment not yet attended, or `null`. */
export function nextAppointment(appointments: readonly Appointment[], nowIso: string): Appointment | null {
  const upcoming = appointments
    .filter((a) => a.attendedAt === null && a.scheduledFor !== null && a.scheduledFor >= nowIso)
    .sort((a, b) => ((a.scheduledFor ?? '') < (b.scheduledFor ?? '') ? -1 : 1));
  return upcoming[0] ?? null;
}

/**
 * An appointment that has been and gone without notes.
 *
 * §4.4 wants "post-visit notes", and the moment they are worth capturing is
 * the day of the visit. This is what puts the prompt on the overview — and it
 * is a prompt, not a nag: there is no badge, no count, and no escalation if it
 * is ignored (§14.1 forbids guilt copy about gaps).
 */
export function awaitingNotes(appointments: readonly Appointment[], nowIso: string): readonly Appointment[] {
  return appointments.filter(
    (a) =>
      a.scheduledFor !== null &&
      a.scheduledFor < nowIso &&
      (a.postVisitNotes === null || a.postVisitNotes.trim() === ''),
  );
}

/** "in 3 days", "today", "6 days ago", or `null` when unscheduled. */
export function describeWhen(appointment: Appointment, nowIso: string): string | null {
  if (appointment.scheduledFor === null) return null;
  const days = daysSince(nowIso, appointment.scheduledFor);
  if (days === null) return null;
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  return days > 0 ? `in ${String(days)} days` : `${String(-days)} days ago`;
}

/* -------------------------------------------------------------------------
 * Formatting
 * ---------------------------------------------------------------------- */

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/**
 * `12 September 2026`, in UTC.
 *
 * These strings are read aloud in a consulting room, so they are unabbreviated
 * and unambiguous — `09/12/2026` means two different days on two continents,
 * and this is the one context where that error has a cost.
 */
export function formatDay(iso: string): string | null {
  const parsed = parseInstant(iso);
  if (parsed === null) return null;
  const month = MONTHS[parsed.getUTCMonth()];
  if (month === undefined) return null;
  return `${String(parsed.getUTCDate())} ${month} ${String(parsed.getUTCFullYear())}`;
}

function daysSince(from: string, to: string): number | null {
  const start = parseInstant(from);
  const end = parseInstant(to);
  if (start === null || end === null) return null;
  return Math.round((end.getTime() - start.getTime()) / 86_400_000);
}
