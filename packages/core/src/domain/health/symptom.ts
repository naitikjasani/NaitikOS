/**
 * The symptom log — §4.4's plainest feature and the one with the most careful
 * wording.
 *
 * A symptom is an entity rather than a bare observation because it carries
 * duration, a body site, and a suspected trigger: internal structure, which is
 * §9.2's test. Its intensity is *also* written as an observation, so that "did
 * the headaches get worse in the month I raised the dose?" is a join over the
 * metric vocabulary rather than a bespoke query.
 *
 * ## The trigger is suspected, and stays suspected
 *
 * `suspectedTrigger` is the operator's, exactly as `mind/episode.ts` and
 * `skin/state.ts` treat theirs. Nothing here infers one, ranks one, or upgrades
 * one to a cause once it has been entered often enough. P5 is the reason and
 * the failure mode is specific: a system that told this operator their headache
 * was caused by Venlafaxine would be making a pharmacological claim it cannot
 * support, to a person who would reasonably act on it.
 *
 * ## Intensity aggregates as `max`, not `mean`
 *
 * Over a day, the question a symptom answers is *how bad did it get*. A mean
 * turns one severe hour and eleven quiet ones into "mild", which is the reading
 * that gets a symptom dismissed at an appointment.
 */

import type { Result } from '@naitikos/shared';
import { err, ok } from '@naitikos/shared';

import type { DomainError } from '../../errors/domain-error';
import { validationError } from '../../errors/domain-error';
import { parseInstant } from '../../temporal/instant';
import { isIanaZone } from '../../temporal/zone';
import type { ObservationInput } from '../../observations/observation';

export const SYMPTOM_METRIC = 'body.symptom.intensity';
export const SYMPTOM_SUBJECT_TYPE = 'symptom';

/** 1–10. Ten points because a symptom scale is compared against itself. */
export const MIN_SYMPTOM_INTENSITY = 1;
export const MAX_SYMPTOM_INTENSITY = 10;

export type Severity = 'mild' | 'moderate' | 'severe';

export const SEVERITIES: readonly Severity[] = Object.freeze(['mild', 'moderate', 'severe'] as const);

export const SEVERITY_LABELS: Readonly<Record<Severity, string>> = Object.freeze({
  mild: 'Mild',
  moderate: 'Moderate',
  severe: 'Severe',
});

export type Symptom = {
  readonly id: string;
  readonly medicalEventId: string;
  readonly name: string;
  readonly bodySite: string | null;
  readonly severity: Severity | null;
  readonly intensity: number | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly zone: string | null;
  readonly suspectedTrigger: string | null;
  readonly note: string | null;
};

export type SymptomInput = {
  readonly id: string;
  readonly name: string;
  readonly bodySite?: string | null;
  readonly severity?: Severity | null;
  readonly intensity?: number | null;
  readonly startedAt: string;
  readonly endedAt?: string | null;
  readonly zone: string;
  readonly suspectedTrigger?: string | null;
  readonly note?: string | null;
};

export type PlannedSymptom = {
  readonly input: SymptomInput;
  readonly observations: readonly ObservationInput[];
};

export function planSymptom(input: SymptomInput): Result<PlannedSymptom, DomainError> {
  if (input.name.trim() === '') {
    return err(validationError('symptom_name_empty', 'A symptom needs a name.'));
  }
  const started = parseInstant(input.startedAt);
  if (started === null) {
    return err(validationError('symptom_started_at_invalid', 'startedAt must be an ISO-8601 instant.'));
  }
  if (!isIanaZone(input.zone)) {
    return err(validationError('symptom_zone_invalid', 'zone must be an IANA zone name (§5.3).'));
  }

  if (input.endedAt !== undefined && input.endedAt !== null) {
    const ended = parseInstant(input.endedAt);
    if (ended === null) {
      return err(validationError('symptom_ended_at_invalid', 'endedAt must be an ISO-8601 instant.'));
    }
    if (ended.getTime() < started.getTime()) {
      return err(validationError('symptom_interval_reversed', 'A symptom cannot end before it starts.'));
    }
  }

  const intensity = input.intensity ?? null;
  if (intensity !== null && (!Number.isInteger(intensity) || intensity < MIN_SYMPTOM_INTENSITY || intensity > MAX_SYMPTOM_INTENSITY)) {
    return err(
      validationError(
        'symptom_intensity_range',
        `Intensity must be a whole number from ${String(MIN_SYMPTOM_INTENSITY)} to ${String(MAX_SYMPTOM_INTENSITY)}.`,
      ),
    );
  }

  const observations: ObservationInput[] =
    intensity === null
      ? []
      : [
          {
            metricKey: SYMPTOM_METRIC,
            value: { kind: 'integer', value: intensity },
            observedAt: input.startedAt,
            observedZone: input.zone,
            subject: { type: SYMPTOM_SUBJECT_TYPE, id: input.id },
          },
        ];

  return ok({ input, observations });
}

/**
 * How long a symptom lasted, in minutes, or `null` while it is still open.
 *
 * `null` rather than "minutes so far" for the same reason
 * `mind/episode.ts` returns it: an open symptom has no duration yet, and
 * reporting elapsed time as duration would let an unclosed entry from March
 * dominate every summary that averages them.
 */
export function symptomDurationMinutes(symptom: Symptom): number | null {
  if (symptom.startedAt === null || symptom.endedAt === null) return null;
  const started = parseInstant(symptom.startedAt);
  const ended = parseInstant(symptom.endedAt);
  if (started === null || ended === null) return null;
  return Math.round((ended.getTime() - started.getTime()) / 60_000);
}

/** Open symptoms, most recent first — what the log shows at the top. */
export function openSymptoms(symptoms: readonly Symptom[]): readonly Symptom[] {
  return symptoms
    .filter((symptom) => symptom.endedAt === null)
    .sort((a, b) => ((a.startedAt ?? '') < (b.startedAt ?? '') ? 1 : -1));
}

/**
 * Distinct symptom names in a window, with how often each appeared.
 *
 * Case-folded for grouping, first spelling kept for display — the same rule
 * `mind/episode.ts` applies to triggers. A count, not a rate and not a rank:
 * "headache × 4" is a fact, and anything more would be this module deciding
 * which symptom matters.
 */
export function symptomFrequency(
  symptoms: readonly Symptom[],
): readonly { readonly name: string; readonly count: number }[] {
  const seen = new Map<string, { name: string; count: number }>();
  for (const symptom of symptoms) {
    const key = symptom.name.trim().toLowerCase();
    if (key === '') continue;
    const existing = seen.get(key);
    if (existing === undefined) seen.set(key, { name: symptom.name.trim(), count: 1 });
    else existing.count += 1;
  }
  return [...seen.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}
