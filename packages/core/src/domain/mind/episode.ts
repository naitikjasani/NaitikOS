/**
 * Anxiety episodes — §4.7, §9.2.
 *
 * ## Why an episode is an entity and a level is not
 *
 * §9.2 draws the line: "Mood, energy, and anxiety *levels* are plain
 * observations. Only things with internal structure become entities." An
 * episode has a start, possibly an end, a trigger the operator names, a coping
 * response they chose, and their judgement of whether it helped. That is
 * structure, and flattening it into a scalar would throw away the only part
 * that is clinically actionable — *what they did, and whether it worked*.
 *
 * The intensity is nonetheless *also* written as a `mind.anxiety` observation
 * against the episode, for the same P3 reason Gym writes set loads: Skin, Sleep
 * and Gym can ask "how anxious was this week" through the metric vocabulary
 * without any of them knowing that a table called `anxiety_episode` exists.
 *
 * ## Two things this module will not do
 *
 * **It will not infer a trigger.** §4.7: "'Your mood is low because you skipped
 * the gym' is a claim the system is not entitled to make." `trigger` is a
 * nullable free-text field the operator fills in or does not. Nothing here
 * suggests a value for it, and nothing downstream may either.
 *
 * **It will not close an episode on the operator's behalf.** An open episode
 * stays open. A background job that stamped an end time after six hours would
 * be inventing a fact about someone's mental state to make a duration chart
 * tidier, and {@link episodeDurationMinutes} returns `null` instead — which is
 * the honest answer to "how long did it last" when the answer is not known yet.
 */

import type { Result } from '@naitikos/shared';
import { err, ok } from '@naitikos/shared';

import type { DomainError } from '../../errors/domain-error';
import { validationError } from '../../errors/domain-error';
import { parseInstant } from '../../temporal/instant';
import { isIanaZone } from '../../temporal/zone';
import type { ObservationInput } from '../../observations/observation';
import { MIND_METRICS } from './scales';

/** The subject type every episode-scoped observation carries (§9.3(3)). */
export const EPISODE_SUBJECT_TYPE = 'anxiety_episode';

/** Clinical severity bands, matching the `severity` enum in the schema. */
export type EpisodeSeverity = 'mild' | 'moderate' | 'severe';

/**
 * The longest episode that can be recorded in one row: 24 hours.
 *
 * Not a claim that anxiety cannot last longer — it plainly can. It is a claim
 * that a *single episode record* spanning more than a day is almost always an
 * episode someone forgot to close, and silently keeping it would put a
 * multi-day outlier into every duration statistic. The operator can record
 * consecutive days as consecutive episodes.
 */
export const MAX_EPISODE_MINUTES = 24 * 60;

export type AnxietyEpisode = {
  readonly id: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly zone: string;
  readonly intensity: number | null;
  readonly severity: EpisodeSeverity | null;
  readonly physicalSymptoms: string | null;
  /** What the operator believes set it off. Never inferred. */
  readonly trigger: string | null;
  readonly copingResponse: string | null;
  readonly outcome: string | null;
  readonly note: string | null;
};

export type EpisodeInput = {
  readonly id: string;
  readonly startedAt: string;
  readonly endedAt?: string | null;
  readonly zone: string;
  readonly intensity?: number | null;
  readonly physicalSymptoms?: string | null;
  readonly trigger?: string | null;
  readonly copingResponse?: string | null;
  readonly outcome?: string | null;
  readonly note?: string | null;
};

export type PlannedEpisode = {
  readonly episode: AnxietyEpisode;
  /** The `mind.anxiety` write, or none when no intensity was given. */
  readonly observations: readonly ObservationInput[];
};

/**
 * Map an intensity to a severity band.
 *
 * The bands are wide on purpose. A five-point self-report does not carry enough
 * resolution to justify five severity classes, and pretending otherwise would
 * make a one-point answering difference look like a clinical change.
 */
export function severityFor(intensity: number | null | undefined): EpisodeSeverity | null {
  if (intensity === null || intensity === undefined || !Number.isInteger(intensity)) return null;
  if (intensity <= 2) return 'mild';
  if (intensity <= 3) return 'moderate';
  if (intensity <= 5) return 'severe';
  return null;
}

/**
 * Duration in minutes, or `null` while the episode is open.
 *
 * `null` is load-bearing. A caller that wants "average episode length" must
 * decide what to do with open episodes, and returning zero would quietly make
 * that decision for them — in the direction that shortens every average.
 */
export function episodeDurationMinutes(episode: Pick<AnxietyEpisode, 'startedAt' | 'endedAt'>): number | null {
  if (episode.endedAt === null) return null;
  const start = parseInstant(episode.startedAt);
  const end = parseInstant(episode.endedAt);
  if (start === null || end === null) return null;
  return Math.round((end.getTime() - start.getTime()) / 60_000);
}

/**
 * Validate an episode and produce the rows and observations it becomes.
 *
 * Everything except the timestamps and the zone is optional, and that is §4.0's
 * reasoning applied outside the Close: "a system that only accepts complete
 * records trains the user to log nothing on a bad day, and bad days are the
 * clinically interesting ones." An episode row with a start time and nothing
 * else is a legitimate record of *it happened, and I could not face the form*.
 */
export function planEpisode(input: EpisodeInput): Result<PlannedEpisode, DomainError> {
  const startedAt = parseInstant(input.startedAt);
  if (startedAt === null) {
    return err(validationError('episode_started_at_invalid', 'startedAt must be an ISO-8601 instant.'));
  }
  if (!isIanaZone(input.zone)) {
    return err(validationError('episode_zone_invalid', 'zone must be an IANA zone name (§5.3).'));
  }

  const endedAtRaw = input.endedAt ?? null;
  let endedAt: string | null = null;
  if (endedAtRaw !== null) {
    const parsed = parseInstant(endedAtRaw);
    if (parsed === null) {
      return err(validationError('episode_ended_at_invalid', 'endedAt must be an ISO-8601 instant.'));
    }
    if (parsed.getTime() < startedAt.getTime()) {
      return err(validationError('episode_ends_before_start', 'An episode cannot end before it started.'));
    }
    if ((parsed.getTime() - startedAt.getTime()) / 60_000 > MAX_EPISODE_MINUTES) {
      return err(
        validationError(
          'episode_too_long',
          `An episode may span at most ${String(MAX_EPISODE_MINUTES)} minutes. Record consecutive days as consecutive episodes.`,
        ),
      );
    }
    endedAt = endedAtRaw;
  }

  const intensity = input.intensity ?? null;
  if (intensity !== null && (!Number.isInteger(intensity) || intensity < 1 || intensity > 5)) {
    return err(validationError('episode_intensity_range', 'intensity must be an integer from 1 to 5.'));
  }

  const episode: AnxietyEpisode = {
    id: input.id,
    startedAt: input.startedAt,
    endedAt,
    zone: input.zone,
    intensity,
    severity: severityFor(intensity),
    physicalSymptoms: blankToNull(input.physicalSymptoms),
    trigger: blankToNull(input.trigger),
    copingResponse: blankToNull(input.copingResponse),
    outcome: blankToNull(input.outcome),
    note: blankToNull(input.note),
  };

  /*
   * No intensity, no observation. Writing a placeholder so the series has a
   * point would put a number nobody reported into the record — and §9.1 makes
   * observations append-only, so it would be permanent.
   */
  const observations: ObservationInput[] =
    intensity === null
      ? []
      : [
          {
            metricKey: MIND_METRICS.anxiety,
            value: { kind: 'integer', value: intensity },
            observedAt: input.startedAt,
            observedZone: input.zone,
            subject: { type: EPISODE_SUBJECT_TYPE, id: input.id },
          },
        ];

  return ok({ episode, observations });
}

function blankToNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/* -------------------------------------------------------------------------
 * Reading a run of episodes
 * ---------------------------------------------------------------------- */

export type EpisodeSummary = {
  readonly count: number;
  readonly openCount: number;
  /** Mean minutes across *closed* episodes only. */
  readonly meanClosedMinutes: number | null;
  readonly closedCount: number;
  /**
   * Triggers the operator named, most frequent first.
   *
   * A tally of what they wrote down. Not an analysis, not ranked by anything
   * other than how often they typed it, and explicitly not a causal claim —
   * which is why the type says `named` rather than `causes`.
   */
  readonly namedTriggers: readonly { readonly trigger: string; readonly count: number }[];
  /** Coping responses they recorded, most frequent first. Same caveat. */
  readonly namedCoping: readonly { readonly response: string; readonly count: number }[];
};

export function summariseEpisodes(episodes: readonly AnxietyEpisode[]): EpisodeSummary {
  let openCount = 0;
  let closedCount = 0;
  let totalMinutes = 0;
  const triggers = new Map<string, number>();
  const coping = new Map<string, number>();

  for (const episode of episodes) {
    const minutes = episodeDurationMinutes(episode);
    if (minutes === null) openCount += 1;
    else {
      closedCount += 1;
      totalMinutes += minutes;
    }
    tally(triggers, episode.trigger);
    tally(coping, episode.copingResponse);
  }

  return {
    count: episodes.length,
    openCount,
    closedCount,
    meanClosedMinutes: closedCount === 0 ? null : totalMinutes / closedCount,
    namedTriggers: rank(triggers).map(([trigger, count]) => ({ trigger, count })),
    namedCoping: rank(coping).map(([response, count]) => ({ response, count })),
  };
}

/**
 * Case-folded so "Work" and "work" are one entry, but the *first* spelling seen
 * is what gets displayed — the operator's own words, back at them.
 */
function tally(into: Map<string, number>, raw: string | null): void {
  if (raw === null) return;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return;
  const folded = trimmed.toLocaleLowerCase();
  for (const existing of into.keys()) {
    if (existing.toLocaleLowerCase() === folded) {
      into.set(existing, (into.get(existing) ?? 0) + 1);
      return;
    }
  }
  into.set(trimmed, 1);
}

function rank(counts: ReadonlyMap<string, number>): readonly (readonly [string, number])[] {
  return [...counts.entries()].sort((a, b) => (b[1] - a[1] !== 0 ? b[1] - a[1] : a[0].localeCompare(b[0])));
}
