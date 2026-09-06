/**
 * Normalising a wearable batch — the whole of the import's judgement.
 *
 * §2.3: "Pull-based, batch, never a live stream." So there is no socket, no
 * webhook, and no background sync; there is a file the operator exports from
 * their phone and hands to this function. Everything that could be wrong with
 * that file has to be decided here, because by the time the rows reach
 * Postgres the only vocabulary left is constraint violations.
 *
 * ## Three outcomes per row, and the difference between them is the design
 *
 *   - **Accepted.** Mapped, converted, in range. It becomes a `sample`.
 *   - **Skipped.** An identifier this system has no metric for. Counted and
 *     named, never fatal — an Apple Health export carries a hundred-odd
 *     quantity types, and refusing the file because of one called
 *     `AppleWalkingSteadiness` would leave the operator hand-editing XML.
 *   - **Rejected.** Mapped, but the number cannot be trusted: an unknown unit,
 *     an unparseable instant, a value outside the metric's registered bounds.
 *     Counted, named, and *not* stored. Storing an untrustworthy number is
 *     worse than losing it, because the loss is visible and the poison is not.
 *
 * The counts are returned rather than logged. §8.9 requires missing data be
 * shown as missing; an importer that quietly dropped a third of a file and
 * reported success would be the same lie in a different place.
 *
 * ## Deduplication happens twice, on purpose
 *
 * Once here, within the batch, and once in Postgres via the unique index on
 * `(source_id, metric_key, observed_at)`. The database one is the guarantee —
 * it is what makes re-importing last month's export a no-op. This one exists
 * because a single insert cannot resolve a conflict against a row in *the same
 * statement*: Postgres raises "ON CONFLICT DO UPDATE command cannot affect row
 * a second time", and an export that overlaps its own boundaries routinely
 * carries one instant twice.
 */

import type { MetricRegistry } from '../../observations/metric';
import { isoFromMillis, parseInstant as parseIsoInstant } from '../../temporal/instant';
import { acceptedUnits, mappingFor, convertToCanonical } from './mapping';
import type { WearablePlatform } from './mapping';

/** One row as the platform exported it, before this system has an opinion. */
export type RawSample = {
  /** `HKQuantityTypeIdentifierHeartRate`, `com.google.step_count.delta`. */
  readonly identifier: string;
  /** The number, as the platform reported it, in {@link RawSample.unit}. */
  readonly value: number;
  readonly unit: string;
  /** ISO-8601 with an offset. A bare local time is rejected — see below. */
  readonly observedAt: string;
  /** The IANA zone the device was in. Falls back to the profile's (§5.3). */
  readonly observedZone?: string | undefined;
};

/** A row ready for `sample`, in canonical units, with an id already minted. */
export type NormalisedSample = {
  readonly id: string;
  readonly metricKey: string;
  /** Decimal string for `numeric(20,6)`. Never a float at the boundary (§5.3). */
  readonly value: string;
  readonly unit: string;
  readonly observedAt: string;
  readonly observedZone: string;
};

/** Why a row was refused, in words the import screen can show unchanged. */
export type RejectedSample = {
  readonly identifier: string;
  readonly reason: string;
  /** The offending row, so "which one" is answerable without the file. */
  readonly observedAt: string;
};

export type NormalisedBatch = {
  readonly rows: readonly NormalisedSample[];
  /** Identifiers with no registered metric, each with how many rows it had. */
  readonly skipped: Readonly<Record<string, number>>;
  readonly rejected: readonly RejectedSample[];
  /** Rows dropped as duplicates of an earlier row in the same batch. */
  readonly duplicates: number;
  /** Rejections in total, including those past {@link MAX_REPORTED_REJECTIONS}. */
  readonly rejectedTotal: number;
};

/** How many rejections are described individually before they are only counted. */
export const MAX_REPORTED_REJECTIONS = 50;

export type NormaliseOptions = {
  readonly platform: WearablePlatform;
  readonly registry: MetricRegistry;
  /** Used when a row carries no zone of its own. */
  readonly fallbackZone: string;
  /** Mints the `sample.id`. Injected so a test can be deterministic (§5.7). */
  readonly newId: () => string;
};

/**
 * Six decimal places, matching `numeric(20,6)`.
 *
 * `toFixed` rather than `String`, because a value of 1e-7 — which a unit
 * conversion can produce from a near-zero reading — serialises to exponential
 * notation, which is valid JSON and is not valid input for the column.
 */
function toDecimalString(value: number): string {
  return value.toFixed(6);
}

/**
 * An instant, or `null`.
 *
 * A timestamp without an offset is refused rather than assumed to be local.
 * §5.3's position is that "a workout at '7am' during travel is a materially
 * different fact from one at 7am at home", and a wearable export is exactly the
 * artefact that crosses timezones — guessing here would misplace every reading
 * from a flight by hours, and nothing afterwards could tell that it had.
 */
function parseInstant(raw: string): string | null {
  const trimmed = raw.trim();
  /*
   * The offset check comes first and is this function's whole reason for
   * existing — `parseIsoInstant` accepts a bare local time and resolves it
   * against the *server's* zone, which for a wearable export is exactly the
   * wrong answer and an undetectable one.
   */
  if (!/([Zz]|[+-]\d{2}:?\d{2})$/.test(trimmed)) return null;
  const parsed = parseIsoInstant(trimmed);
  if (parsed === null) return null;
  return isoFromMillis(parsed.getTime());
}

/** Registered bounds, as §9.2 requires them enforced on write. */
function withinBounds(value: number, min: string | null, max: string | null): boolean {
  if (min !== null && value < Number(min)) return false;
  if (max !== null && value > Number(max)) return false;
  return true;
}

export function normaliseBatch(raw: readonly RawSample[], options: NormaliseOptions): NormalisedBatch {
  const rows: NormalisedSample[] = [];
  const skipped: Record<string, number> = {};
  const rejected: RejectedSample[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  let rejectedTotal = 0;

  const reject = (identifier: string, observedAt: string, reason: string): void => {
    /* Past the cap the rejections are still *counted* — only the descriptions
     * stop, so one malformed export cannot produce a fifty-megabyte response
     * body while still reporting the true scale of the damage. */
    rejectedTotal += 1;
    if (rejected.length < MAX_REPORTED_REJECTIONS) {
      rejected.push({ identifier, observedAt, reason });
    }
  };

  for (const row of raw) {
    const mapping = mappingFor(options.platform, row.identifier);
    if (mapping === null) {
      skipped[row.identifier] = (skipped[row.identifier] ?? 0) + 1;
      continue;
    }

    const definition = options.registry.get(mapping.metricKey);
    if (definition === null) {
      /*
       * The mapping names a metric the registry does not have, which means the
       * seed has not run since the mapping was added. A configuration fault
       * rather than a data fault, and it is surfaced with the key in it because
       * the alternative is a foreign-key violation on insert that names a
       * constraint instead of a cause.
       */
      reject(row.identifier, row.observedAt, `No metric registered as ${mapping.metricKey}. Run the seed.`);
      continue;
    }

    if (!Number.isFinite(row.value)) {
      reject(row.identifier, row.observedAt, 'Value is not a finite number.');
      continue;
    }

    const converted = convertToCanonical(mapping, row.value, row.unit);
    if (converted === null) {
      reject(
        row.identifier,
        row.observedAt,
        `Unit "${row.unit}" is not one this system knows for ${mapping.metricKey} (accepts ${acceptedUnits(mapping).join(', ')}).`,
      );
      continue;
    }

    const observedAt = parseInstant(row.observedAt);
    if (observedAt === null) {
      reject(row.identifier, row.observedAt, 'Timestamp has no UTC offset, so the instant it names is unknown.');
      continue;
    }

    const value = definition.valueType === 'integer' ? Math.round(converted) : converted;
    if (!withinBounds(value, definition.minValue, definition.maxValue)) {
      reject(
        row.identifier,
        row.observedAt,
        `${String(value)} ${definition.canonicalUnit} is outside the registered range for ${definition.key}.`,
      );
      continue;
    }

    /*
     * Keyed by metric and instant, not by identifier and instant. Two platform
     * identifiers can map onto one metric — and if they ever do, the second is
     * a duplicate as far as the unique index is concerned, so it has to be one
     * here too or the insert fails on a conflict this pass promised to remove.
     */
    const key = `${mapping.metricKey} ${observedAt}`;
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);

    rows.push({
      id: options.newId(),
      metricKey: mapping.metricKey,
      value: toDecimalString(value),
      unit: definition.canonicalUnit,
      observedAt,
      observedZone: row.observedZone ?? options.fallbackZone,
    });
  }

  return { rows, skipped, rejected, duplicates, rejectedTotal };
}

/** Total rows the platform offered that this system had no metric for. */
export function skippedTotal(batch: NormalisedBatch): number {
  return Object.values(batch.skipped).reduce((total, count) => total + count, 0);
}
