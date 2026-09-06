/**
 * The device-data service — what a wearable has actually put in the record.
 *
 * §2.3's wearable ingestion is the only import in this system whose results are
 * not legible one row at a time. A calendar import produces meetings you can
 * read; a bank import produces transactions you can check. A health import
 * produces four hundred thousand heart-rate readings, and the only honest thing
 * to show is coverage: which metrics, how many rows, and over what span.
 *
 * ## Coverage is the whole of the read model, on purpose
 *
 * There is no chart here and no daily average. Both would be a second place
 * that decides what a device stream means, and §5.6 already has one — the
 * nightly rollups, which the existing charts read. A page that computed its own
 * mean over `sample` would drift from every other page in the system the first
 * time the rollup definition changed.
 *
 * ## Two counts, because they answer different questions
 *
 * `samples` is rows; `aggregates` is how many of those are hourly means rather
 * than readings (§9.7). Showing only the first would let the operator believe
 * they still have minute-resolution history for a year they do not. §8.9's
 * "missing data is shown as missing" has a quieter counterpart: *coarsened*
 * data must be shown as coarsened.
 */

import 'server-only';

import type { Result } from '@naitikos/shared';
import { ok } from '@naitikos/shared';
import type { DomainError, WearablePlatform } from '@naitikos/core';
import {
  SAMPLE_RETENTION_DAYS,
  WEARABLE_PLATFORMS,
  WEARABLE_PLATFORM_LABELS,
  isoFromMillis,
  mappedIdentifiers,
  systemClock,
} from '@naitikos/core';
import type { Database, SampleCoverage } from '@naitikos/db';
import { createSampleRepository } from '@naitikos/db';

/** What one platform can supply, for the screen's "what will be read" list. */
export type PlatformSupport = {
  readonly platform: WearablePlatform;
  readonly label: string;
  readonly identifiers: readonly string[];
};

export type DeviceBoard = {
  readonly coverage: readonly SampleCoverage[];
  readonly totalSamples: number;
  /** Rows in the DEFAULT partition — malformed timestamps, and never expected. */
  readonly stranded: number;
  readonly retentionDays: number;
  readonly platforms: readonly PlatformSupport[];
  /** The instant this was read, so the page can date its own numbers. */
  readonly asOf: string;
};

export async function loadDevices(db: Database): Promise<Result<DeviceBoard, DomainError>> {
  const samples = createSampleRepository(db);

  const coverage = await samples.coverage();
  if (!coverage.ok) return coverage;

  const stranded = await samples.strandedCount();
  if (!stranded.ok) return stranded;

  return ok({
    coverage: coverage.value,
    totalSamples: coverage.value.reduce((total, entry) => total + entry.samples, 0),
    stranded: stranded.value,
    retentionDays: SAMPLE_RETENTION_DAYS,
    platforms: WEARABLE_PLATFORMS.map((platform) => ({
      platform,
      label: WEARABLE_PLATFORM_LABELS[platform],
      identifiers: mappedIdentifiers(platform),
    })),
    asOf: isoFromMillis(systemClock.nowMillis()),
  });
}
