/**
 * Physique photography, assembled — §3.2's `/body/composition/photos`, §4.6.
 *
 * ## Why this is not the skin gallery with a different region
 *
 * §4.6 asks for "physique photography under the same protocol discipline as
 * Skin", and the discipline is the same. The *shape of the data* is not:
 *
 *  - A skin photo is **per region**. Face, chest and back are three series that
 *    move independently, and §4.2's question is whether one is clearing while
 *    another is not. A physique photo is **whole body**; the region column has
 *    nothing useful to say about it, and the thing that identifies one series
 *    from another is the pose.
 *  - A skin series is **daily**. A physique series is weeks apart, which changes
 *    what is worth reporting: the interval between plates is a fact about the
 *    series, and a fortnight's gap in a skin log means something quite different
 *    from a fortnight between physique shots.
 *
 * So the grouping key is the pose, the cadence is reported, and the per-region
 * comparison that drives `/body/skin/regions` is absent because it would be
 * three views of the same body.
 *
 * ## The gallery's real subject is capture variance
 *
 * §4.2's sentence governs this file more than any other:
 *
 *   "Photographs taken under inconsistent lighting, distance, angle, or time of
 *    day are not merely lower quality — they are *actively misleading*, because
 *    apparent change is dominated by capture variance rather than skin change."
 *
 * A gallery that lists twelve photos in date order implies they are twelve
 * observations of one thing. If four were shot under a ceiling light at 22:00
 * and eight in morning daylight, they are two things, and the difference between
 * the first and the last is mostly the lamp. {@link ConditionConsistency} is
 * therefore computed for every series and is the reason
 * {@link PhysiqueSeries.isComparable} exists — the screen refuses the
 * side-by-side when it is false rather than drawing it with a caveat underneath.
 *
 * ## Which rows are physique rows
 *
 * `body_region` has no whole-body value, so a physique plate is filed under
 * `other`. That is a convention this module establishes rather than one the
 * schema enforces, and it is stated here because the capture path does not exist
 * yet and will have to honour it. A `whole_body` enum value would be better and
 * is a migration; §9.8's protocol block is otherwise exactly right as it stands.
 */

import 'server-only';

import type { Result } from '@naitikos/shared';
import { err, ok } from '@naitikos/shared';
import type {
  BodyRegion,
  CaptureTimeBucket,
  DomainError,
  FlashState,
  SeriesPhoto,
} from '@naitikos/core';
import {
  COMPLIANCE_THRESHOLD,
  DISTANCE_LABELS,
  LIGHTING_LABELS,
  comparablePhotos,
  dayKeyInZone,
  dayKeyIndex,
  seriesKey,
} from '@naitikos/core';
import type { Database, ProtocolPhotoRow } from '@naitikos/db';
import { createMediaRepository } from '@naitikos/db';

/** See the file header: `other` is the whole body, for want of an enum value. */
export const PHYSIQUE_REGIONS: readonly BodyRegion[] = Object.freeze(['other']);

/**
 * Pose names, with the raw identifier as the fallback.
 *
 * A map with a fallback rather than a closed union, because the pose vocabulary
 * belongs to the capture screen and that screen does not exist yet. A closed
 * union here would silently drop a series the day someone adds a pose, which is
 * the one failure a progress gallery must not have.
 */
const POSE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  front_relaxed: 'Front, relaxed',
  front_flexed: 'Front, flexed',
  side_relaxed: 'Side, relaxed',
  back_relaxed: 'Back, relaxed',
  back_flexed: 'Back, flexed',
});

export function physiquePoseLabel(poseId: string | null): string {
  if (poseId === null) return 'Pose not recorded';
  return POSE_LABELS[poseId] ?? poseId;
}

/*
 * Labels for the two protocol vocabularies `core` does not label.
 *
 * `DISTANCE_LABELS` and `LIGHTING_LABELS` live in `core/domain/skin/protocol`
 * beside the enums; time bucket and flash have no equivalent, so they are here.
 * They belong next to the other two and moving them is a `core` change this
 * module is not the right place to make.
 */
const TIME_BUCKET_LABELS: Readonly<Record<CaptureTimeBucket, string>> = Object.freeze({
  early_morning: 'Early morning',
  morning: 'Morning',
  midday: 'Midday',
  afternoon: 'Afternoon',
  evening: 'Evening',
  night: 'Night',
});

const FLASH_LABELS: Readonly<Record<FlashState, string>> = Object.freeze({
  on: 'Flash on',
  off: 'Flash off',
  auto_fired: 'Auto — fired',
  auto_not_fired: 'Auto — did not fire',
});

/* -------------------------------------------------------------------------
 * The four conditions that decide whether two photographs are one series
 * ---------------------------------------------------------------------- */

export type ProtocolFieldId = 'distance' | 'lighting' | 'timeBucket' | 'flash';

/**
 * The four categorical fields, in the order §4.2 lists them.
 *
 * Median luminance is deliberately not one of them. It is a measurement rather
 * than a setting, §14.2's Finding 9 says a luminance check produces false
 * warnings, and a gallery that marked a series inconsistent because one photo
 * was eighteen percent brighter would be the false-warning failure with more
 * screen space. Luminance is reported per plate and votes on nothing.
 */
const PROTOCOL_FIELDS: readonly {
  readonly field: ProtocolFieldId;
  readonly label: string;
  readonly read: (row: ProtocolPhotoRow) => string | null;
  readonly format: (value: string) => string;
}[] = Object.freeze([
  {
    field: 'distance',
    label: 'Distance',
    read: (row) => row.distance,
    format: (value) => DISTANCE_LABELS[value as keyof typeof DISTANCE_LABELS] ?? value,
  },
  {
    field: 'lighting',
    label: 'Lighting',
    read: (row) => row.lighting,
    format: (value) => LIGHTING_LABELS[value as keyof typeof LIGHTING_LABELS] ?? value,
  },
  {
    field: 'timeBucket',
    label: 'Time of day',
    read: (row) => row.timeBucket,
    format: (value) => TIME_BUCKET_LABELS[value as keyof typeof TIME_BUCKET_LABELS] ?? value,
  },
  {
    field: 'flash',
    label: 'Flash',
    read: (row) => row.flash,
    format: (value) => FLASH_LABELS[value as keyof typeof FLASH_LABELS] ?? value,
  },
]);

export type PlateCondition = {
  readonly field: ProtocolFieldId;
  readonly label: string;
  /** `null` when the capture did not record it. Never a default — §8.9. */
  readonly value: string | null;
  /** Recorded, and different from what the rest of the series was shot at. */
  readonly deviates: boolean;
};

export type ConditionConsistency = {
  readonly field: ProtocolFieldId;
  readonly label: string;
  /** Distinct recorded values, most frequent first. */
  readonly values: readonly { readonly value: string; readonly count: number }[];
  readonly missingCount: number;
  /** One recorded value across every plate in the series, and none missing. */
  readonly isConsistent: boolean;
};

/* -------------------------------------------------------------------------
 * Plates and series
 * ---------------------------------------------------------------------- */

export type PhysiquePlate = {
  readonly mediaObjectId: string;
  /** `null` for a photo whose capture time was never recorded. */
  readonly capturedAt: string | null;
  /** The day it was captured in, in the zone *it* was captured in (§5.3). */
  readonly dayKey: string | null;
  readonly zone: string | null;
  /** Days since the previous plate in this series. `null` for the first. */
  readonly daysSincePrevious: number | null;

  readonly conditions: readonly PlateCondition[];
  readonly medianLuminance: number | null;
  readonly complianceScore: number | null;
  readonly complianceNotes: string | null;
  /** §9.8's default filter: at or above the threshold, or never scored. */
  readonly isCompliant: boolean;

  /**
   * The server holds ciphertext it cannot read (§5.5).
   *
   * The single most important field on this type, because it is the reason the
   * screen renders a plate rather than a picture.
   */
  readonly isEncrypted: boolean;
  readonly dimensions: { readonly width: number; readonly height: number } | null;
};

export type PhysiqueSeries = {
  readonly key: string;
  readonly poseId: string | null;
  readonly label: string;
  /** Oldest first. A progress gallery reads forwards. */
  readonly plates: readonly PhysiquePlate[];
  /** Non-compliant plates withheld from this series by the default filter. */
  readonly hiddenCount: number;
  readonly consistency: readonly ConditionConsistency[];
  /**
   * Every protocol field has exactly one recorded value across the series.
   *
   * The gate on side-by-side. False means the plates document different capture
   * conditions, and §4.2 says the difference between the first and the last
   * would then be dominated by the conditions.
   */
  readonly isComparable: boolean;
  readonly firstDayKey: string | null;
  readonly lastDayKey: string | null;
  /** Typical gap between plates. Median, so one six-month gap does not set it. */
  readonly medianIntervalDays: number | null;
};

export type PhysiqueGallery = {
  readonly series: readonly PhysiqueSeries[];
  /** Photos with no capture time. Present, unplaceable, and shown as such. */
  readonly undated: readonly PhysiquePlate[];
  readonly totalPhotos: number;
  /** Withheld across all series by the compliance filter (§9.8). */
  readonly hiddenCount: number;
  readonly includeNonCompliant: boolean;
  /** Plates whose bytes the server cannot read, and therefore cannot render. */
  readonly encryptedCount: number;
};

/* -------------------------------------------------------------------------
 * The loader
 * ---------------------------------------------------------------------- */

export async function loadPhysiqueGallery(
  db: Database,
  options: { readonly zone: string; readonly includeNonCompliant?: boolean },
): Promise<Result<PhysiqueGallery, DomainError>> {
  const includeNonCompliant = options.includeNonCompliant ?? false;

  const rows = await createMediaRepository(db).protocolPhotos(PHYSIQUE_REGIONS);
  if (!rows.ok) return err(rows.error);

  const byId = new Map(rows.value.map((row) => [row.mediaObjectId, row]));

  /*
   * Dated rows become `SeriesPhoto`s so `core` can do the grouping and the
   * compliance filter.
   *
   * Reimplementing either here would put §9.8's threshold in two places, and the
   * one that drifts is always the one in the app. `comparablePhotos` also sorts
   * oldest-first, which is the order this page reads in.
   */
  const dated: SeriesPhoto[] = [];
  const undated: PhysiquePlate[] = [];
  for (const row of rows.value) {
    if (row.capturedAt === null) {
      /* No series, so nothing to deviate from — an empty dominant map makes
       * every condition report its own value and flag nothing. */
      undated.push(toPlate(row, null, row.capturedZone, conditionsOf(row, new Map()), null));
      continue;
    }
    dated.push({
      mediaObjectId: row.mediaObjectId,
      capturedAt: row.capturedAt,
      region: row.region ?? 'other',
      poseId: row.poseId,
      distance: row.distance,
      lighting: row.lighting,
      timeBucket: row.timeBucket,
      flash: row.flash,
      medianLuminance: row.medianLuminance,
      complianceScore: row.complianceScore,
    });
  }

  /* Series identity is `core`'s `seriesKey`, so a physique series and a skin
   * series are the same kind of thing to every part of the system that has an
   * opinion about it. Insertion order is preserved, which puts the pose the
   * operator shoots most often first without ranking anything. */
  const keys: string[] = [];
  const grouped = new Map<string, SeriesPhoto[]>();
  for (const photo of dated) {
    const key = seriesKey(photo.region, photo.poseId);
    const existing = grouped.get(key);
    if (existing === undefined) {
      keys.push(key);
      grouped.set(key, [photo]);
    } else {
      existing.push(photo);
    }
  }

  let hiddenCount = 0;
  const series: PhysiqueSeries[] = [];

  for (const key of keys) {
    const members = grouped.get(key) ?? [];
    const first = members[0];
    if (first === undefined) continue;

    const visible = comparablePhotos(members, first.region, first.poseId, { includeNonCompliant });
    const withheld = members.length - visible.length;
    hiddenCount += withheld;
    if (visible.length === 0) continue;

    const visibleRows = visible.flatMap((photo) => {
      const row = byId.get(photo.mediaObjectId);
      return row === undefined ? [] : [row];
    });

    const consistency = consistencyOf(visibleRows);
    const dominant = dominantValues(visibleRows);

    let previousIndex: number | null = null;
    const intervals: number[] = [];
    const plates = visibleRows.map((row) => {
      const zone = row.capturedZone ?? options.zone;
      const dayKey = row.capturedAt === null ? null : dayKeyInZone(row.capturedAt, zone);
      const index = dayKey === null ? null : dayKeyIndex(dayKey);
      const gap = index === null || previousIndex === null ? null : index - previousIndex;
      if (gap !== null) intervals.push(gap);
      if (index !== null) previousIndex = index;
      return toPlate(row, dayKey, zone, conditionsOf(row, dominant), gap);
    });

    series.push({
      key,
      poseId: first.poseId,
      label: physiquePoseLabel(first.poseId),
      plates,
      hiddenCount: withheld,
      consistency,
      isComparable: plates.length > 1 && consistency.every((entry) => entry.isConsistent),
      firstDayKey: plates[0]?.dayKey ?? null,
      lastDayKey: plates[plates.length - 1]?.dayKey ?? null,
      medianIntervalDays: median(intervals),
    });
  }

  return ok({
    series,
    undated,
    totalPhotos: rows.value.length,
    hiddenCount,
    includeNonCompliant,
    encryptedCount: rows.value.filter((row) => row.isEncrypted).length,
  });
}

/* -------------------------------------------------------------------------
 * Assembly
 * ---------------------------------------------------------------------- */

function toPlate(
  row: ProtocolPhotoRow,
  dayKey: string | null,
  zone: string | null,
  conditions: readonly PlateCondition[],
  daysSincePrevious: number | null,
): PhysiquePlate {
  return {
    mediaObjectId: row.mediaObjectId,
    capturedAt: row.capturedAt,
    dayKey,
    zone,
    daysSincePrevious,
    conditions,
    medianLuminance: row.medianLuminance,
    complianceScore: row.complianceScore,
    complianceNotes: row.complianceNotes,
    /* A never-scored plate counts as compliant, for the reason `evaluateProtocol`
     * gives: the first photo in a series has no baseline to be consistent with,
     * and excluding it would leave the series with nothing to compare against. */
    isCompliant: row.complianceScore === null || row.complianceScore >= COMPLIANCE_THRESHOLD,
    isEncrypted: row.isEncrypted,
    dimensions:
      row.width === null || row.height === null ? null : { width: row.width, height: row.height },
  };
}

/** The most frequent recorded value per field, or `null` where none was recorded. */
function dominantValues(rows: readonly ProtocolPhotoRow[]): ReadonlyMap<ProtocolFieldId, string | null> {
  const dominant = new Map<ProtocolFieldId, string | null>();

  for (const field of PROTOCOL_FIELDS) {
    const counts = new Map<string, number>();
    for (const row of rows) {
      const value = field.read(row);
      if (value === null) continue;
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }

    let best: string | null = null;
    let bestCount = 0;
    for (const [value, count] of counts) {
      if (count > bestCount) {
        best = value;
        bestCount = count;
      }
    }
    dominant.set(field.field, best);
  }

  return dominant;
}

function conditionsOf(
  row: ProtocolPhotoRow,
  dominant: ReadonlyMap<ProtocolFieldId, string | null>,
): readonly PlateCondition[] {
  return PROTOCOL_FIELDS.map((field) => {
    const raw = field.read(row);
    const expected = dominant.get(field.field) ?? null;
    return {
      field: field.field,
      label: field.label,
      value: raw === null ? null : field.format(raw),
      /* Missing is not deviating. A field nobody recorded is a gap in the
       * record; a field recorded differently is a different photograph. The
       * screen says two different things about them. */
      deviates: raw !== null && expected !== null && raw !== expected,
    };
  });
}

function consistencyOf(rows: readonly ProtocolPhotoRow[]): readonly ConditionConsistency[] {
  return PROTOCOL_FIELDS.map((field) => {
    const counts = new Map<string, number>();
    let missingCount = 0;

    for (const row of rows) {
      const value = field.read(row);
      if (value === null) {
        missingCount += 1;
        continue;
      }
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }

    const values = [...counts.entries()]
      .map(([value, count]) => ({ value: field.format(value), count }))
      .sort((a, b) => b.count - a.count);

    return {
      field: field.field,
      label: field.label,
      values,
      missingCount,
      /*
       * A field nobody recorded is *not* consistent.
       *
       * The tempting reading is that zero recorded values means nothing varied.
       * It means nothing is known, and treating an absence of evidence as
       * evidence of consistency is precisely how a series of photographs taken
       * under whatever light comes to be presented as a comparison.
       */
      isConsistent: values.length === 1 && missingCount === 0,
    };
  });
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? null;
  const lower = sorted[middle - 1];
  const upper = sorted[middle];
  return lower === undefined || upper === undefined ? null : (lower + upper) / 2;
}
