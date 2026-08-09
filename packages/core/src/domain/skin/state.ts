/**
 * Daily skin state — §4.2.
 *
 * ## One row per day, three regions inside it
 *
 * §4.2 tracks "the operator's three affected regions" separately, and the
 * schema comment says why: "an aggregate score hides a chest flare during a good
 * face week." So the day carries an overall judgement *and* per-region detail,
 * and both are written to the observation log — the overall against
 * `body.skin.state`, each region against `body.skin.region.state` with the
 * region row as its subject.
 *
 * ## Lesions and scars are different numbers
 *
 * §4.2 requires "scar tracking as distinct from active lesions", and the metric
 * registry keeps them apart: `body.skin.lesion_count` aggregates as `last`,
 * scarring is a 1–5 level on the region row and is not a count at all. Summing
 * them would produce a figure that improves when inflammation settles and
 * worsens when it leaves a mark, which is two unrelated processes fighting over
 * one axis.
 *
 * ## A flare is annotated, never detected
 *
 * `isFlare` and `suspectedTrigger` are the operator's. §4.2 says "flare
 * annotation with suspected trigger" and the schema comment adds "Suspected,
 * not asserted." Nothing in this module infers either, for the same P5 reason
 * `mind/episode.ts` will not infer a trigger.
 */

import type { Result } from '@naitikos/shared';
import { err, ok } from '@naitikos/shared';

import type { DomainError } from '../../errors/domain-error';
import { validationError } from '../../errors/domain-error';
import { isIanaZone } from '../../temporal/zone';
import type { ObservationInput } from '../../observations/observation';

export const SKIN_METRICS = Object.freeze({
  state: 'body.skin.state',
  regionState: 'body.skin.region.state',
  lesionCount: 'body.skin.lesion_count',
});

export const SKIN_STATE_SUBJECT_TYPE = 'skin_state';
export const SKIN_REGION_SUBJECT_TYPE = 'skin_region_state';

/** The regions the schema's `body_region` enum permits. */
export const BODY_REGIONS = Object.freeze([
  'face',
  'chest',
  'back',
  'shoulders',
  'arms',
  'neck',
  'other',
] as const);

export type BodyRegion = (typeof BODY_REGIONS)[number];

/**
 * The three §4.2 names explicitly, in the order the UI presents them.
 *
 * The enum has seven values because a schema is expensive to change and a
 * region list is not; this is the subset that is actually tracked, and it is
 * separate so adding `neck` to the UI is a one-line edit rather than a
 * migration.
 */
export const TRACKED_REGIONS: readonly BodyRegion[] = Object.freeze(['face', 'chest', 'back']);

export const REGION_LABELS: Readonly<Record<BodyRegion, string>> = Object.freeze({
  face: 'Face',
  chest: 'Chest',
  back: 'Back',
  shoulders: 'Shoulders',
  arms: 'Arms',
  neck: 'Neck',
  other: 'Other',
});

/** 1 is worst, 5 is clear — matching the registry description for `body.skin.state`. */
export const SKIN_STATE_LABELS: readonly [string, string, string, string, string] = Object.freeze([
  'Very poor',
  'Poor',
  'Fair',
  'Good',
  'Clear',
]) as readonly [string, string, string, string, string];

/** A fat-finger guard, not a clinical bound. */
export const MAX_LESION_COUNT = 500;

export type SkinRegionState = {
  readonly id: string;
  readonly region: BodyRegion;
  readonly state: number | null;
  readonly activeLesionCount: number | null;
  readonly scarringLevel: number | null;
  readonly inflammation: number | null;
  readonly dryness: number | null;
  readonly oiliness: number | null;
  readonly note: string | null;
};

export type SkinState = {
  readonly id: string;
  /** `YYYY-MM-DD` in the operator's zone. One row per day (unique index). */
  readonly observedOn: string;
  readonly zone: string;
  readonly overallState: number | null;
  readonly note: string | null;
  readonly isFlare: boolean;
  readonly suspectedTrigger: string | null;
  readonly regions: readonly SkinRegionState[];
};

export type SkinRegionInput = {
  readonly id: string;
  readonly region: string;
  readonly state?: number | null;
  readonly activeLesionCount?: number | null;
  readonly scarringLevel?: number | null;
  readonly inflammation?: number | null;
  readonly dryness?: number | null;
  readonly oiliness?: number | null;
  readonly note?: string | null;
};

/**
 * An observation already on record for this day, so a re-log can supersede it.
 *
 * §9.1 makes the observation log append-only: "corrections are supersessions,
 * not updates". Without this, logging skin state twice on one day would leave
 * *both* readings current, and `body.skin.state` aggregates as `mean` — so
 * correcting a 2 to a 4 would produce a 3, which is a number the operator never
 * entered and cannot see the source of.
 *
 * The same shape as the Daily Close's `ExistingObservation`, and for the same
 * reason.
 */
export type ExistingSkinObservation = {
  readonly id: string;
  readonly metricKey: string;
  readonly subjectId: string | null;
};

export const SKIN_REVISION_REASON = 'skin_state_revised';

export type SkinStateInput = {
  readonly id: string;
  readonly observedOn: string;
  readonly zone: string;
  /** When on that day the judgement was made. Drives `observedAt` (§5.3). */
  readonly observedAt: string;
  readonly overallState?: number | null;
  readonly note?: string | null;
  readonly isFlare?: boolean;
  readonly suspectedTrigger?: string | null;
  readonly regions?: readonly SkinRegionInput[];
  /** What is already recorded for this day. See {@link ExistingSkinObservation}. */
  readonly existing?: readonly ExistingSkinObservation[];
};

export type PlannedSkinState = {
  readonly state: SkinState;
  readonly observations: readonly ObservationInput[];
};

export function isBodyRegion(value: string): value is BodyRegion {
  return (BODY_REGIONS as readonly string[]).includes(value);
}

/**
 * Validate a day's skin log and produce its rows and observations.
 *
 * Every measure is optional, including the overall state — a day on which the
 * operator only counted lesions on their chest is a legitimate record, and
 * §4.0's reasoning about partial records applies here exactly as it does to the
 * Close. What is *not* optional is the day key and the zone, because a skin log
 * with no day cannot be compared to a photo, a routine, or anything else.
 */
export function planSkinState(input: SkinStateInput): Result<PlannedSkinState, DomainError> {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(input.observedOn)) {
    return err(validationError('skin_day_invalid', 'observedOn must be a YYYY-MM-DD day key.'));
  }
  if (!isIanaZone(input.zone)) {
    return err(validationError('skin_zone_invalid', 'zone must be an IANA zone name (§5.3).'));
  }

  const overall = input.overallState ?? null;
  if (overall !== null && !isScale(overall)) {
    return err(validationError('skin_state_range', 'overallState must be an integer from 1 to 5.'));
  }

  const regions: SkinRegionState[] = [];
  const seen = new Set<string>();

  for (const region of input.regions ?? []) {
    if (!isBodyRegion(region.region)) {
      return err(validationError('skin_region_unknown', `Unknown body region: ${region.region}.`));
    }
    if (seen.has(region.region)) {
      return err(
        validationError('skin_region_duplicate', `Region ${region.region} appears twice in one day's log.`),
      );
    }
    seen.add(region.region);

    for (const [field, value] of [
      ['state', region.state ?? null],
      ['scarringLevel', region.scarringLevel ?? null],
      ['inflammation', region.inflammation ?? null],
      ['dryness', region.dryness ?? null],
      ['oiliness', region.oiliness ?? null],
    ] as const) {
      if (value !== null && !isScale(value)) {
        return err(validationError('skin_region_range', `${field} must be an integer from 1 to 5.`));
      }
    }

    const lesions = region.activeLesionCount ?? null;
    if (lesions !== null && (!Number.isInteger(lesions) || lesions < 0 || lesions > MAX_LESION_COUNT)) {
      return err(
        validationError(
          'skin_lesion_range',
          `activeLesionCount must be an integer from 0 to ${String(MAX_LESION_COUNT)}.`,
        ),
      );
    }

    regions.push({
      id: region.id,
      region: region.region,
      state: region.state ?? null,
      activeLesionCount: lesions,
      scarringLevel: region.scarringLevel ?? null,
      inflammation: region.inflammation ?? null,
      dryness: region.dryness ?? null,
      oiliness: region.oiliness ?? null,
      note: trimToNull(region.note),
    });
  }

  const state: SkinState = {
    id: input.id,
    observedOn: input.observedOn,
    zone: input.zone,
    overallState: overall,
    note: trimToNull(input.note),
    isFlare: input.isFlare ?? false,
    suspectedTrigger: trimToNull(input.suspectedTrigger),
    regions,
  };

  const priorFor = (metricKey: string, subjectId: string): string | null =>
    (input.existing ?? []).find((prior) => prior.metricKey === metricKey && prior.subjectId === subjectId)
      ?.id ?? null;

  const observations: ObservationInput[] = [];

  const push = (metricKey: string, value: number, subjectType: string, subjectId: string, region?: BodyRegion): void => {
    const prior = priorFor(metricKey, subjectId);
    observations.push({
      metricKey,
      value: { kind: 'integer', value },
      observedAt: input.observedAt,
      observedZone: input.zone,
      subject: { type: subjectType, id: subjectId },
      /*
       * The region travels in context as well as in the subject. A chart
       * filtering "face only" would otherwise have to join back to
       * skin_region_state — which is exactly the Skin-shaped query P3 says
       * other domains must not have to write.
       */
      ...(region === undefined ? {} : { context: { region } }),
      ...(prior === null ? {} : { supersedes: { id: prior, reason: SKIN_REVISION_REASON } }),
    });
  };

  if (overall !== null) push(SKIN_METRICS.state, overall, SKIN_STATE_SUBJECT_TYPE, input.id);

  for (const region of regions) {
    if (region.state !== null) {
      push(SKIN_METRICS.regionState, region.state, SKIN_REGION_SUBJECT_TYPE, region.id, region.region);
    }
    if (region.activeLesionCount !== null) {
      push(
        SKIN_METRICS.lesionCount,
        region.activeLesionCount,
        SKIN_REGION_SUBJECT_TYPE,
        region.id,
        region.region,
      );
    }
  }

  return ok({ state, observations });
}

function isScale(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 5;
}

function trimToNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/* -------------------------------------------------------------------------
 * Reading a run of days
 * ---------------------------------------------------------------------- */

export type RegionTrend = {
  readonly region: BodyRegion;
  readonly recordedDays: number;
  readonly meanState: number | null;
  readonly latestState: number | null;
  readonly latestLesionCount: number | null;
};

/**
 * Per-region summary across a window of days.
 *
 * Means are over *recorded* days, and `recordedDays` travels with them so a
 * mean of 4.0 from two days is never mistaken for a mean of 4.0 from thirty.
 */
export function regionTrends(states: readonly SkinState[]): readonly RegionTrend[] {
  const ordered = [...states].sort((a, b) => (a.observedOn < b.observedOn ? -1 : a.observedOn > b.observedOn ? 1 : 0));
  const buckets = new Map<BodyRegion, { sum: number; count: number; latest: number | null; lesions: number | null }>();

  for (const state of ordered) {
    for (const region of state.regions) {
      const bucket = buckets.get(region.region) ?? { sum: 0, count: 0, latest: null, lesions: null };
      if (region.state !== null) {
        bucket.sum += region.state;
        bucket.count += 1;
        bucket.latest = region.state;
      }
      if (region.activeLesionCount !== null) bucket.lesions = region.activeLesionCount;
      buckets.set(region.region, bucket);
    }
  }

  return [...buckets.entries()].map(([region, bucket]) => ({
    region,
    recordedDays: bucket.count,
    meanState: bucket.count === 0 ? null : bucket.sum / bucket.count,
    latestState: bucket.latest,
    latestLesionCount: bucket.lesions,
  }));
}
