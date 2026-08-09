/**
 * The photography protocol — §4.2, §9.8, and §14.2's ninth finding.
 *
 * ## Why this is the module
 *
 * §4.2 does not hedge:
 *
 *   "**The photography protocol is the module.** Photographs taken under
 *    inconsistent lighting, distance, angle, or time of day are not merely lower
 *    quality — they are *actively misleading*, because apparent change is
 *    dominated by capture variance rather than skin change."
 *
 * A year of face photos taken at whatever hour under whatever light does not
 * show whether skin improved. It shows the weather. The protocol exists so that
 * the comparison in month nine is a comparison of skin.
 *
 * ## Advisory, always. Never blocking.
 *
 * §14.2's Finding 9 is the governing constraint on everything below:
 *
 *   "A luminance-based lighting check will produce false warnings, and a warning
 *    that is wrong even twenty percent of the time is a warning that gets
 *    ignored within a fortnight, taking the credible warnings with it. *Fixed:*
 *    §4.2 and §9.8 now make protocol checks **advisory and recorded, never
 *    blocking**. The ghost overlay is the primary mechanism, because it actually
 *    works — it makes the correct behaviour easier than the incorrect one, which
 *    is the only reliable form of enforcement."
 *
 * So {@link evaluateProtocol} returns a `Result`-free plain value. There is no
 * failure path, no `err`, nothing a caller could accidentally turn into a
 * refusal. The worst outcome available to this module is a low score and a list
 * of advisories, and the photo is stored either way.
 *
 * The ghost overlay is not in this file because it is not a computation — it is
 * the previous photo, at low opacity, behind the viewfinder. It lives in the
 * capture component, and {@link alignmentReferenceFor} is what tells that
 * component which photo to use.
 *
 * ## What a "series" is
 *
 * Region plus pose. A face-front series and a face-left series are different
 * series and must not be compared to each other or used as each other's
 * alignment reference — which is why {@link seriesKey} exists rather than
 * callers matching on region alone.
 */

import type { CaptureProtocol } from '../../media/pipeline';
import type { BodyRegion } from './state';

/* -------------------------------------------------------------------------
 * Vocabularies — mirroring the schema enums (§9.8)
 * ---------------------------------------------------------------------- */

export const CAPTURE_DISTANCES = Object.freeze(['close', 'medium', 'full'] as const);
export type CaptureDistance = (typeof CAPTURE_DISTANCES)[number];

export const CAPTURE_LIGHTING = Object.freeze([
  'daylight_indirect',
  'daylight_direct',
  'artificial_warm',
  'artificial_cool',
  'mixed',
  'unknown',
] as const);
export type CaptureLighting = (typeof CAPTURE_LIGHTING)[number];

export const CAPTURE_TIME_BUCKETS = Object.freeze([
  'early_morning',
  'morning',
  'midday',
  'afternoon',
  'evening',
  'night',
] as const);
export type CaptureTimeBucket = (typeof CAPTURE_TIME_BUCKETS)[number];

export const FLASH_STATES = Object.freeze(['on', 'off', 'auto_fired', 'auto_not_fired'] as const);
export type FlashState = (typeof FLASH_STATES)[number];

export const LIGHTING_LABELS: Readonly<Record<CaptureLighting, string>> = Object.freeze({
  daylight_indirect: 'Indirect daylight',
  daylight_direct: 'Direct daylight',
  artificial_warm: 'Warm artificial',
  artificial_cool: 'Cool artificial',
  mixed: 'Mixed',
  unknown: 'Unknown',
});

export const DISTANCE_LABELS: Readonly<Record<CaptureDistance, string>> = Object.freeze({
  close: 'Close',
  medium: 'Medium',
  full: 'Full',
});

/**
 * The recommended capture condition, stated once.
 *
 * Indirect daylight, no flash, same time each day. Not enforced — it is what
 * the capture screen suggests and what a series drifts back towards when the
 * operator follows the ghost overlay.
 */
export const RECOMMENDED = Object.freeze({
  lighting: 'daylight_indirect' as CaptureLighting,
  flash: 'off' as FlashState,
});

/* -------------------------------------------------------------------------
 * Series
 * ---------------------------------------------------------------------- */

/** Region plus pose. Two photos are comparable only if these match. */
export function seriesKey(region: BodyRegion | string, poseId: string | null): string {
  return `${region}::${poseId ?? 'default'}`;
}

export type SeriesPhoto = {
  readonly mediaObjectId: string;
  readonly capturedAt: string;
  readonly region: string;
  readonly poseId: string | null;
  readonly distance: CaptureDistance | null;
  readonly lighting: CaptureLighting | null;
  readonly timeBucket: CaptureTimeBucket | null;
  readonly flash: FlashState | null;
  readonly medianLuminance: number | null;
  readonly complianceScore: number | null;
};

/**
 * The photo the ghost overlay should show: the most recent in the same series.
 *
 * *Most recent*, not most compliant. The overlay's job is alignment, and
 * aligning to the last photo is what keeps a series from drifting one degree at
 * a time. Aligning to a compliant photo from three months ago would ask the
 * operator to reproduce a framing they no longer remember.
 */
export function alignmentReferenceFor(
  series: readonly SeriesPhoto[],
  region: string,
  poseId: string | null,
): SeriesPhoto | null {
  const key = seriesKey(region, poseId);
  let latest: SeriesPhoto | null = null;
  for (const photo of series) {
    if (seriesKey(photo.region, photo.poseId) !== key) continue;
    if (latest === null || photo.capturedAt > latest.capturedAt) latest = photo;
  }
  return latest;
}

/* -------------------------------------------------------------------------
 * Time of day
 * ---------------------------------------------------------------------- */

/**
 * The bucket a local clock time falls in.
 *
 * Takes `HH:MM` rather than an instant for the same reason `isRoutineDue` does:
 * "I photograph at 08:00" is a wall-clock fact, and deriving it from an instant
 * here would need a zone this module should not know about.
 */
export function timeBucketFor(localTime: string): CaptureTimeBucket | null {
  const match = /^(\d{2}):(\d{2})$/u.exec(localTime.trim());
  if (match === null) return null;
  const hours = Number(match[1]);
  if (!Number.isInteger(hours) || hours > 23) return null;
  if (hours < 7) return 'early_morning';
  if (hours < 11) return 'morning';
  if (hours < 14) return 'midday';
  if (hours < 17) return 'afternoon';
  if (hours < 21) return 'evening';
  return 'night';
}

/* -------------------------------------------------------------------------
 * The checks
 * ---------------------------------------------------------------------- */

export type CheckStatus = 'pass' | 'advisory' | 'unknown';

export type ProtocolCheck = {
  readonly id: string;
  readonly label: string;
  readonly status: CheckStatus;
  /** A sentence for the capture screen. Never an instruction to stop. */
  readonly detail: string;
  /** Contribution to the score. `unknown` checks are excluded from both sides. */
  readonly weight: number;
};

/**
 * Weights, and the reasoning behind the ordering.
 *
 * Distance and lighting condition dominate apparent change — a face shot at
 * arm's length under a window looks like a different person's skin from the
 * same face at half a metre under a ceiling light. Time of day and flash matter
 * because they change colour temperature and specular highlight, which read as
 * oiliness. Luminance is weighted *below* the categorical checks on purpose:
 * §14.2 Finding 9 says it will produce false warnings, so it gets a vote rather
 * than a veto. Alignment is lowest not because it matters least but because the
 * ghost overlay already enforces it far better than a score can.
 */
const WEIGHTS = Object.freeze({
  /*
   * Named `framing` rather than `distance` deliberately: this is the weight of
   * a consistency check, not a measured distance, and `no-bare-quantity`
   * correctly refuses a bare number bound to a measured-concept name (§6.2).
   */
  framing: 3,
  lighting: 3,
  timeBucket: 2,
  flash: 2,
  luminance: 2,
  alignment: 1,
});

/** Fractional luminance drift tolerated before the check turns advisory. */
export const LUMINANCE_TOLERANCE = 0.15;

/** At or above this, a photo is included in comparison views by default (§9.8). */
export const COMPLIANCE_THRESHOLD = 0.7;

export type CaptureCandidate = {
  readonly region: string;
  readonly poseId: string | null;
  readonly distance: CaptureDistance | null;
  readonly lighting: CaptureLighting | null;
  readonly timeBucket: CaptureTimeBucket | null;
  readonly flash: FlashState | null;
  readonly medianLuminance: number | null;
  readonly alignmentReferenceId: string | null;
};

export type ProtocolVerdict = {
  readonly checks: readonly ProtocolCheck[];
  /**
   * 0–1, or `null` when nothing could be assessed.
   *
   * `null` is the first photo in a series. It has no baseline to be consistent
   * with, and scoring it zero would exclude the reference photo from its own
   * series' comparison view — leaving nothing to compare against.
   */
  readonly complianceScore: number | null;
  /** Comparison views default to this being true (§9.8). */
  readonly isCompliant: boolean;
  readonly advisories: readonly ProtocolCheck[];
};

/**
 * Score a capture against its series baseline.
 *
 * There is no error path. See the header: the worst thing this function can do
 * is return advisories.
 */
export function evaluateProtocol(
  candidate: CaptureCandidate,
  baseline: SeriesPhoto | null,
  trailingLuminance: readonly number[] = [],
): ProtocolVerdict {
  const checks: ProtocolCheck[] = [];

  checks.push(
    matchCheck(
      'distance',
      'Distance',
      WEIGHTS.framing,
      candidate.distance,
      baseline?.distance ?? null,
      (value) => DISTANCE_LABELS[value as CaptureDistance] ?? value,
    ),
  );
  checks.push(
    matchCheck(
      'lighting',
      'Lighting',
      WEIGHTS.lighting,
      candidate.lighting,
      baseline?.lighting ?? null,
      (value) => LIGHTING_LABELS[value as CaptureLighting] ?? value,
    ),
  );
  checks.push(
    matchCheck('time_bucket', 'Time of day', WEIGHTS.timeBucket, candidate.timeBucket, baseline?.timeBucket ?? null),
  );
  checks.push(matchCheck('flash', 'Flash', WEIGHTS.flash, candidate.flash, baseline?.flash ?? null));
  checks.push(luminanceCheck(candidate.medianLuminance, trailingLuminance));
  checks.push(alignmentCheck(candidate.alignmentReferenceId, baseline));

  let earned = 0;
  let possible = 0;
  for (const check of checks) {
    if (check.status === 'unknown') continue;
    possible += check.weight;
    if (check.status === 'pass') earned += check.weight;
  }

  const complianceScore = possible === 0 ? null : earned / possible;

  return {
    checks,
    complianceScore,
    isCompliant: complianceScore === null || complianceScore >= COMPLIANCE_THRESHOLD,
    advisories: checks.filter((check) => check.status === 'advisory'),
  };
}

function matchCheck(
  id: string,
  label: string,
  weight: number,
  value: string | null,
  expected: string | null,
  format: (value: string) => string = (value) => value,
): ProtocolCheck {
  if (value === null || expected === null) {
    return {
      id,
      label,
      weight,
      status: 'unknown',
      detail:
        expected === null
          ? `No previous photo in this series to match ${label.toLowerCase()} against.`
          : `${label} was not recorded for this capture.`,
    };
  }
  if (value === expected) {
    return { id, label, weight, status: 'pass', detail: `Matches the previous photo (${format(value)}).` };
  }
  return {
    id,
    label,
    weight,
    status: 'advisory',
    detail: `Previous photo in this series was ${format(expected)}; this one is ${format(value)}.`,
  };
}

/**
 * Median luminance against the trailing baseline.
 *
 * Median rather than mean, because one photo taken with a lamp on would drag a
 * mean far enough to make every subsequent photo look non-compliant — the
 * failure mode Finding 9 describes, arriving through the statistic rather than
 * the threshold.
 */
function luminanceCheck(value: number | null, trailing: readonly number[]): ProtocolCheck {
  const weight = WEIGHTS.luminance;
  const baseline = median(trailing);
  if (value === null || baseline === null || baseline === 0) {
    return {
      id: 'luminance',
      label: 'Brightness',
      weight,
      status: 'unknown',
      detail: 'Not enough previous photos in this series to compare brightness.',
    };
  }
  const drift = Math.abs(value - baseline) / baseline;
  if (drift <= LUMINANCE_TOLERANCE) {
    return {
      id: 'luminance',
      label: 'Brightness',
      weight,
      status: 'pass',
      detail: 'Close to the usual brightness for this series.',
    };
  }
  return {
    id: 'luminance',
    label: 'Brightness',
    weight,
    status: 'advisory',
    detail: `About ${String(Math.round(drift * 100))}% ${value > baseline ? 'brighter' : 'darker'} than the usual for this series. Worth a second look, not a reason to retake.`,
  };
}

function alignmentCheck(referenceId: string | null, baseline: SeriesPhoto | null): ProtocolCheck {
  const weight = WEIGHTS.alignment;
  if (baseline === null) {
    return {
      id: 'alignment',
      label: 'Alignment',
      weight,
      status: 'unknown',
      detail: 'First photo in this series — it becomes the alignment reference.',
    };
  }
  if (referenceId === baseline.mediaObjectId) {
    return { id: 'alignment', label: 'Alignment', weight, status: 'pass', detail: 'Aligned to the previous photo.' };
  }
  return {
    id: 'alignment',
    label: 'Alignment',
    weight,
    status: 'advisory',
    detail: 'Taken without the alignment overlay.',
  };
}

function median(values: readonly number[]): number | null {
  const usable = values.filter((value) => Number.isFinite(value));
  if (usable.length === 0) return null;
  const sorted = [...usable].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? null;
  const lower = sorted[middle - 1];
  const upper = sorted[middle];
  return lower === undefined || upper === undefined ? null : (lower + upper) / 2;
}

/**
 * The protocol block stored on the media row (§9.8).
 *
 * Built from the candidate and the verdict together, so the score that gets
 * persisted is always the one produced by the checks that were actually run.
 */
export function toProtocolBlock(candidate: CaptureCandidate, verdict: ProtocolVerdict): CaptureProtocol {
  return {
    region: candidate.region,
    ...(candidate.poseId === null ? {} : { poseId: candidate.poseId }),
    ...(candidate.distance === null ? {} : { distance: candidate.distance }),
    ...(candidate.lighting === null ? {} : { lighting: candidate.lighting }),
    ...(candidate.timeBucket === null ? {} : { timeBucket: candidate.timeBucket }),
    ...(candidate.flash === null ? {} : { flash: candidate.flash }),
    ...(candidate.alignmentReferenceId === null
      ? {}
      : { alignmentReferenceId: candidate.alignmentReferenceId }),
    ...(candidate.medianLuminance === null ? {} : { medianLuminance: candidate.medianLuminance }),
    ...(verdict.complianceScore === null ? {} : { complianceScore: verdict.complianceScore }),
  };
}

/**
 * Photos eligible for a comparison view.
 *
 * §9.8: "Comparison views default to compliant photos only, with non-compliant
 * ones available behind a toggle and clearly marked." A photo with no score is
 * included — it is the series reference, not a failure.
 */
export function comparablePhotos(
  photos: readonly SeriesPhoto[],
  region: string,
  poseId: string | null,
  options: { readonly includeNonCompliant?: boolean } = {},
): readonly SeriesPhoto[] {
  const key = seriesKey(region, poseId);
  return photos
    .filter((photo) => seriesKey(photo.region, photo.poseId) === key)
    .filter(
      (photo) =>
        (options.includeNonCompliant ?? false) ||
        photo.complianceScore === null ||
        photo.complianceScore >= COMPLIANCE_THRESHOLD,
    )
    .sort((a, b) => (a.capturedAt < b.capturedAt ? -1 : a.capturedAt > b.capturedAt ? 1 : 0));
}
