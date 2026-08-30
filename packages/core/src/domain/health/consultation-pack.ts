/**
 * The Consultation Pack — §10.7, and V2's stated highest-value deliverable.
 *
 *   "For a given specialty and date range it produces a printable, paginated
 *    document: relevant history, current medications with adherence, pertinent
 *    recent labs with trends, symptom timeline, treatments already attempted
 *    with outcomes, and a page of questions."
 *
 * ## The whole pack is deterministic, and that is not a limitation
 *
 * Every fact on the page comes from a SQL query and this file's selection
 * logic. §10.11 routes "Consultation Pack synthesis" to Opus at `xhigh`, and
 * what the model contributes is the connective prose and the phrasing of the
 * questions — **not one number, not one medication, not one date**. §10.0:
 * the model retrieves, explains, ranks and drafts.
 *
 * So the pack works with no model available at all, which is also the honest
 * design: a document taken into a consultation must not depend on an API being
 * up, and a pack that degraded to nothing when the budget cap was hit would be
 * useless on the one morning it mattered.
 *
 * ## "Relevant to the specialty" is the hard part
 *
 * A pack that contained everything would be forty pages and read in none of the
 * ten minutes available. A pack that filtered too hard would omit the
 * interaction the clinician needed. The rule taken here: **filter what to lead
 * with, never what to include.** Everything in the window is in the pack;
 * relevance decides the *order*, and anything judged irrelevant is demoted to a
 * final "also on record" section rather than dropped.
 *
 * That asymmetry is deliberate. The cost of burying something is a clinician
 * reading one more line; the cost of omitting it is a drug interaction nobody
 * mentioned. Those are not comparable, so the design does not trade between
 * them.
 */

import type { AppointmentQuestion } from './appointment';
import type { Condition } from './condition';
import type { FlagSource, LabFlag } from './reference-range';
import type { SideEffect } from './side-effect';
import type { Symptom } from './symptom';

/**
 * Specialties the pack knows how to prioritise for.
 *
 * `general` is not a fallback for "unrecognised" — it is a real choice that
 * leads with everything active and orders by recency. An unrecognised specialty
 * string resolves to it, which produces a complete, chronologically sensible
 * pack rather than an empty one.
 */
export const PACK_SPECIALTIES = Object.freeze([
  'general',
  'psychiatry',
  'dermatology',
  'dentistry',
  'endocrinology',
] as const);

export type PackSpecialty = (typeof PACK_SPECIALTIES)[number];

/**
 * Words that make a record relevant to a specialty.
 *
 * Hand-written, and short. This is the same technique the Teeth module uses to
 * filter dental appointments, and it has the same honest limitation: it is a
 * keyword match over free text, it will miss things, and that is *why*
 * everything still appears in the pack. A classifier that dropped records would
 * need to be right; one that only reorders them needs to be useful.
 */
const SPECIALTY_WORDS: Readonly<Record<PackSpecialty, readonly string[]>> = Object.freeze({
  general: Object.freeze([]),
  psychiatry: Object.freeze([
    'anxiety',
    'depress',
    'mood',
    'panic',
    'sleep',
    'insomnia',
    'venlafaxine',
    'escitalopram',
    'ssri',
    'snri',
    'psychiatr',
    'therapy',
  ]),
  dermatology: Object.freeze([
    'skin',
    'acne',
    'eczema',
    'derm',
    'rash',
    'isotretinoin',
    'retinoid',
    'sebum',
    'pigment',
    'scar',
  ]),
  dentistry: Object.freeze([
    'tooth',
    'teeth',
    'dental',
    'gum',
    'gingiv',
    'root canal',
    'endodont',
    'crown',
    'filling',
    'molar',
  ]),
  endocrinology: Object.freeze([
    'thyroid',
    'tsh',
    'vitamin d',
    'b12',
    'insulin',
    'glucose',
    'hba1c',
    'testosterone',
    'endocrin',
    'deficien',
  ]),
});

export function specialtyFor(value: string): PackSpecialty {
  const folded = value.trim().toLowerCase();
  return (PACK_SPECIALTIES as readonly string[]).includes(folded) ? (folded as PackSpecialty) : 'general';
}

/**
 * Whether a piece of text reads as relevant to a specialty.
 *
 * `general` returns true for everything, which is what makes it a real choice
 * rather than a filter that happens to pass. Exported because the pack's
 * sections each apply it to a different field and the rule should be one rule.
 */
export function isRelevantTo(specialty: PackSpecialty, ...texts: readonly (string | null)[]): boolean {
  const words = SPECIALTY_WORDS[specialty];
  if (words.length === 0) return true;

  const haystack = texts
    .filter((text): text is string => text !== null)
    .join(' ')
    .toLowerCase();

  return words.some((word) => haystack.includes(word));
}

/* -------------------------------------------------------------------------
 * The sections
 * ---------------------------------------------------------------------- */

export type PackConditionRow = {
  readonly id: string;
  readonly name: string;
  readonly status: Condition['status'];
  readonly severity: Condition['severity'];
  readonly since: string;
  readonly until: string | null;
  readonly diagnosedBy: string | null;
  readonly lead: boolean;
};

export type PackMedicationRow = {
  readonly id: string;
  readonly label: string;
  readonly dose: string | null;
  readonly frequency: string | null;
  readonly startedAt: string | null;
  readonly stoppedAt: string | null;
  /**
   * Taken over scheduled in the window, as a fraction, or `null`.
   *
   * `null` where the schedule is `as_needed` or where nothing was scheduled —
   * §4.7's rule that an unlogged day is not a missed dose applies with force
   * here, because this figure is read by a prescriber. A denominator invented
   * to avoid a blank would be the system reporting non-adherence it did not
   * observe.
   */
  readonly adherence: number | null;
  readonly adherenceNote: string;
  readonly lead: boolean;
};

export type PackLabRow = {
  readonly resultId: string;
  readonly analyte: string;
  readonly value: string;
  readonly unit: string | null;
  readonly collectedAt: string | null;
  readonly rangeText: string | null;
  readonly flag: LabFlag | null;
  readonly flagSource: FlagSource;
  /** The previous result for the same analyte, so a trend is visible. */
  readonly previous: { readonly value: string; readonly collectedAt: string | null } | null;
  readonly lead: boolean;
};

export type PackSymptomRow = {
  readonly id: string;
  readonly name: string;
  readonly bodySite: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly severity: Symptom['severity'];
  readonly occurrences: number;
  readonly lead: boolean;
};

export type PackTreatmentRow = {
  readonly id: string;
  readonly label: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  /** What happened. §10.7 asks for "treatments already attempted with outcomes". */
  readonly outcome: string | null;
  readonly lead: boolean;
};

export type ConsultationPackDocument = {
  readonly specialty: PackSpecialty;
  readonly fromDayKey: string;
  readonly toDayKey: string;

  readonly conditions: readonly PackConditionRow[];
  readonly medications: readonly PackMedicationRow[];
  readonly labs: readonly PackLabRow[];
  readonly symptoms: readonly PackSymptomRow[];
  readonly treatments: readonly PackTreatmentRow[];
  readonly questions: readonly AppointmentQuestion[];

  /**
   * What the pack is and is not, printed on it.
   *
   * §10.7 makes the pack's whole purpose "a better conversation with a
   * qualified human" (P5). A document that looked like a medical record without
   * saying it was self-recorded would be presenting itself as something it is
   * not — to a clinician who has thirty seconds to decide how much to trust it.
   */
  readonly limitation: string;
  readonly generatedForDayKey: string;
};

export const PACK_LIMITATION =
  'Self-recorded by the patient, not a clinical record. Figures were entered by hand or read from photographed reports and have not been verified against a laboratory or pharmacy system. Adherence figures count logged doses: an unlogged day may be a dose taken and not recorded. Nothing here is a diagnosis.';

/**
 * The sections a pack can carry, in the order §10.7 lists them.
 *
 * Exported so the print layout and the screen share one order. A pack whose
 * paper version and screen version differed would be the kind of discrepancy
 * that surfaces in a consultation room.
 */
export const PACK_SECTIONS = Object.freeze([
  'conditions',
  'medications',
  'labs',
  'symptoms',
  'treatments',
  'questions',
] as const);

export type PackSection = (typeof PACK_SECTIONS)[number];

export const PACK_SECTION_TITLES: Readonly<Record<PackSection, string>> = Object.freeze({
  conditions: 'History',
  medications: 'Current medications',
  labs: 'Recent results',
  symptoms: 'Symptoms',
  treatments: 'Already tried',
  questions: 'Questions',
});

/**
 * Order a section: relevant first, then by recency, and nothing dropped.
 *
 * The comparator is stable on ties so two runs produce the same document —
 * a pack that reordered itself between the screen and the printout would be
 * confusing in exactly the setting where confusion is expensive.
 */
export function orderSection<T extends { readonly lead: boolean }>(
  rows: readonly T[],
  recencyOf: (row: T) => string | null,
): readonly T[] {
  return [...rows]
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      if (a.row.lead !== b.row.lead) return a.row.lead ? -1 : 1;

      const aWhen = recencyOf(a.row);
      const bWhen = recencyOf(b.row);
      if (aWhen !== bWhen) {
        /* Undated last. A record with no date is not recent; it is unknown, and
         * sorting it to the top would put the least-informative rows first. */
        if (aWhen === null) return 1;
        if (bWhen === null) return -1;
        return bWhen.localeCompare(aWhen);
      }

      return a.index - b.index;
    })
    .map((entry) => entry.row);
}

/**
 * How many of a section's rows lead.
 *
 * Used by the screen to draw the divider between "relevant to this specialty"
 * and "also on record". Zero means the divider is not drawn at all, which is
 * the right rendering for `general` — where everything leads and a divider
 * would imply a distinction nobody made.
 */
export function leadCount(rows: readonly { readonly lead: boolean }[]): number {
  return rows.filter((row) => row.lead).length;
}

/**
 * The sentence describing an adherence figure, or its absence.
 *
 * Written here rather than at the surface because a prescriber reads it and the
 * wording is load-bearing: "84% of 62 scheduled doses were logged" is a fact
 * about logging, and "84% adherence" is a claim about behaviour. The first is
 * true; the second is what a reader will hear unless it is said the other way.
 */
export function adherenceNote(input: {
  readonly logged: number;
  readonly scheduled: number;
  readonly asNeeded: boolean;
}): string {
  if (input.asNeeded) return 'Taken as needed, so there is no schedule to compare against.';
  if (input.scheduled <= 0) return 'No doses were scheduled in this window.';

  const percent = Math.round((input.logged / input.scheduled) * 100);
  return `${String(input.logged)} of ${String(input.scheduled)} scheduled doses were logged (${String(percent)}%). An unlogged day may be a dose taken and not recorded.`;
}

/** Whether a side effect is worth leading with: unreported ones always are. */
export function sideEffectLeads(effect: SideEffect): boolean {
  return !effect.reportedToPrescriber;
}
