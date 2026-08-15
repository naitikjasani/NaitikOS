/**
 * Side effects — small module, and the one whose `reportedToPrescriber` column
 * does more work than it looks like it should.
 *
 * §9.2 keeps the flag "relevant to the Consultation Pack", and that is exactly
 * where it earns its place: an unreported side effect is the single most common
 * thing a person means to raise at an appointment and does not. It is the one
 * fact in this system whose *absence of an action* is the interesting part, so
 * `deriveQuestions` ranks it second only to a critical lab value.
 *
 * Nothing here attributes a side effect to a medication. `suspectedMedicationId`
 * is the operator's suspicion and stays labelled as one — P5, and a specific
 * failure: an SNRI, an SSRI and isotretinoin share a long list of overlapping
 * documented effects, so a system that picked one would be guessing with a
 * confident interface.
 */

import type { Result } from '@naitikos/shared';
import { err, ok } from '@naitikos/shared';

import type { DomainError } from '../../errors/domain-error';
import { validationError } from '../../errors/domain-error';
import { parseInstant } from '../../temporal/instant';
import type { Severity } from './symptom';

export type SideEffect = {
  readonly id: string;
  readonly medicalEventId: string;
  readonly suspectedMedicationId: string | null;
  readonly effect: string;
  readonly severity: Severity | null;
  readonly onsetAt: string | null;
  readonly resolvedAt: string | null;
  readonly reportedToPrescriber: boolean;
  readonly note: string | null;
};

export type SideEffectInput = {
  readonly id: string;
  readonly effect: string;
  readonly suspectedMedicationId?: string | null;
  readonly severity?: Severity | null;
  readonly onsetAt: string;
  readonly zone: string;
  readonly note?: string | null;
};

export function validateSideEffect(input: SideEffectInput): Result<SideEffectInput, DomainError> {
  if (input.effect.trim() === '') {
    return err(validationError('side_effect_empty', 'A side effect needs a description.'));
  }
  if (parseInstant(input.onsetAt) === null) {
    return err(validationError('side_effect_onset_invalid', 'onsetAt must be an ISO-8601 instant.'));
  }
  return ok(input);
}

/** Unresolved, and never mentioned to the person who prescribed it. */
export function unreported(effects: readonly SideEffect[]): readonly SideEffect[] {
  return effects
    .filter((effect) => !effect.reportedToPrescriber)
    .sort((a, b) => ((a.onsetAt ?? '') < (b.onsetAt ?? '') ? 1 : -1));
}

/** Still going, most recent first. */
export function ongoing(effects: readonly SideEffect[]): readonly SideEffect[] {
  return effects
    .filter((effect) => effect.resolvedAt === null)
    .sort((a, b) => ((a.onsetAt ?? '') < (b.onsetAt ?? '') ? 1 : -1));
}
