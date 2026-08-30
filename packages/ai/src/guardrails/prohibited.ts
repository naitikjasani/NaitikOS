/**
 * Post-generation validation — §10.10.
 *
 *   "**Post-generation validation** scans for prohibited patterns — diagnostic
 *    language, dosage instructions, discontinuation advice, urgency framing —
 *    and **blocks rather than sanitises**. A blocked output is logged as a
 *    defect and drives a prompt eval case."
 *
 * ## Blocking, not sanitising, and why that is not pedantry
 *
 * Sanitising means deleting the offending clause and showing the rest. But the
 * rest was written *around* the clause: strip "you should stop taking it" from
 * a paragraph and what remains reads as agreement with whatever preceded it.
 * A partially-redacted clinical instruction is more dangerous than the whole
 * one, because it has lost the context that would have made it obviously wrong.
 *
 * So a match discards the entire output. The surface shows nothing, and the
 * block is recorded as a defect against the prompt — §10.10 makes that a source
 * of eval cases rather than an incident to be silenced.
 *
 * ## This is the *last* line, not the first
 *
 * The schemas are the real control (`schemas/`): no field can express a
 * diagnosis or a dose, and prose cannot contain digits. This file catches what
 * gets through a field that was legitimately free text — a `limitation`, a
 * `rationale`. Treating it as the primary defence would be a mistake; a regex
 * over natural language is a heuristic, and §10.10 is explicit that the
 * structural controls are what make the harmful output unrepresentable.
 */

/** Which §10.10 category a match belongs to. Reported, so the eval case is specific. */
export type ProhibitionCategory = 'diagnostic' | 'dosage' | 'discontinuation' | 'urgency';

export type Prohibition = {
  readonly id: string;
  readonly category: ProhibitionCategory;
  readonly pattern: RegExp;
  /** Why this is prohibited, in words a maintainer reading a block report needs. */
  readonly reason: string;
};

/**
 * The patterns.
 *
 * Written to catch the *speech act*, not the vocabulary. "Vitamin D" is a
 * perfectly ordinary thing for this system to name; "you have a Vitamin D
 * deficiency" is a diagnosis. So the patterns anchor on the assertive
 * construction — "you have", "this indicates", "stop taking", "see a doctor
 * immediately" — rather than on clinical nouns, which appear legitimately on
 * every screen in the Health module.
 *
 * Deliberately no attempt at completeness. A list that tried to enumerate every
 * phrasing of medical advice would be long, wrong, and would create the
 * impression that anything unmatched is safe.
 */
export const PROHIBITIONS: readonly Prohibition[] = Object.freeze([
  {
    id: 'diagnostic.you_have',
    category: 'diagnostic',
    pattern: /\byou (?:have|are suffering from|likely have|probably have|may have)\b/iu,
    reason:
      'Asserting a condition about the operator. §10.7 makes the system’s clinical output "a better conversation with a qualified human" — a question, never a finding.',
  },
  {
    id: 'diagnostic.this_indicates',
    category: 'diagnostic',
    pattern: /\b(?:this|that|these) (?:indicates?|suggests? that you|means you|confirms?)\b/iu,
    reason:
      'Inferring a clinical conclusion from data. §10.2: no edge is ever labelled causal, and causation is a claim only a clinician makes.',
  },
  {
    id: 'diagnostic.is_diagnosed',
    category: 'diagnostic',
    pattern: /\b(?:diagnos(?:is|ed|e)|consistent with (?:a )?(?:condition|disorder|syndrome))\b/iu,
    reason: 'Diagnostic vocabulary in an assertive position. The schemas cannot express a diagnosis; prose must not either.',
  },
  {
    id: 'dosage.instruction',
    category: 'dosage',
    pattern: /\b(?:take|increase|decrease|reduce|raise|lower)\s+(?:your\s+)?(?:dose|dosage|it)\b/iu,
    reason: '§10.10: insight and recommendation schemas contain no field capable of expressing a dosage. Neither may prose.',
  },
  {
    id: 'dosage.numeric_units',
    category: 'dosage',
    pattern: /\b\d+\s*(?:mg|mcg|µg|ug|iu|ml|units?)\b.{0,40}\b(?:daily|twice|per day|a day|每)\b/iu,
    reason: 'A dose and a frequency together is a prescription. Narration cannot contain digits at all, so this is a defence in depth.',
  },
  {
    id: 'discontinuation.stop',
    category: 'discontinuation',
    pattern: /\b(?:stop|discontinue|come off|quit|cease)\s+(?:taking\s+)?(?:your\s+)?(?:medication|meds?|the\s+\w+|it)\b/iu,
    reason:
      'Advising discontinuation. This is the single most dangerous output the system could produce — abrupt cessation of an SSRI or SNRI has a well-documented discontinuation syndrome.',
  },
  {
    id: 'urgency.immediately',
    category: 'urgency',
    pattern: /\b(?:immediately|urgently|right away|as soon as possible|emergency)\b/iu,
    reason:
      'Urgency framing. P6 forbids manufactured urgency, and in a health context it converts an ambiguous number into alarm — which is exactly the failure mode §4.7 is written against.',
  },
  {
    id: 'urgency.should_see',
    category: 'urgency',
    pattern: /\byou (?:should|need to|must) (?:see|call|contact|visit)\b/iu,
    reason:
      'Directing the operator to seek care is a clinical judgement about severity. §10.7 frames everything as a question the operator may choose to ask.',
  },
]);

export type BlockVerdict =
  | { readonly blocked: false }
  | {
      readonly blocked: true;
      readonly prohibitionId: string;
      readonly category: ProhibitionCategory;
      readonly reason: string;
      /** The matched span, for the eval case. Never shown to the operator. */
      readonly match: string;
    };

export const PASSED: BlockVerdict = Object.freeze({ blocked: false });

/**
 * Scan generated text.
 *
 * Returns the **first** match rather than all of them. A blocked output is
 * discarded whole, so the second match changes nothing about the outcome and
 * enumerating them would only make the defect report longer.
 */
export function scanForProhibited(text: string): BlockVerdict {
  for (const prohibition of PROHIBITIONS) {
    const found = prohibition.pattern.exec(text);
    if (found !== null) {
      return {
        blocked: true,
        prohibitionId: prohibition.id,
        category: prohibition.category,
        reason: prohibition.reason,
        match: found[0],
      };
    }
  }
  return PASSED;
}

/**
 * Scan every free-text field of a structured output at once.
 *
 * Takes the *strings*, not the object, because each schema has a different
 * shape and a walker over `unknown` would silently skip a field added later.
 * The caller lists what it is submitting, which makes the omission visible in
 * review rather than at runtime.
 */
export function scanAll(fields: readonly string[]): BlockVerdict {
  for (const field of fields) {
    const verdict = scanForProhibited(field);
    if (verdict.blocked) return verdict;
  }
  return PASSED;
}
