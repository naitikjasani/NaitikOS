/**
 * Wearable ingestion at the wire — §2.3's "pull-based, batch, never a live
 * stream", spelled out as a schema.
 *
 * ## Why this takes JSON rows and not an Apple Health export
 *
 * `export.xml` from a phone that has been worn for a few years is routinely
 * hundreds of megabytes. Accepting it whole would mean buffering that in a
 * route handler, which is not a size problem so much as a design one: the
 * operator would press a button and wait, with no partial progress, no way to
 * retry the half that failed, and one timeout between them and the import.
 *
 * So the wire format is a bounded batch of already-extracted rows, and the
 * splitting happens on the client where the file already is. The batch cap
 * below is what makes each request a unit of work that either lands or does
 * not — §5.7's offline-first posture applied to an import: a failed chunk is
 * re-sent, and re-sending is free because the natural key makes it a no-op.
 *
 * ## The client sends what the platform said, not what this system means
 *
 * `identifier`, `value` and `unit` are the platform's own vocabulary —
 * `HKQuantityTypeIdentifierHeartRate`, `count/min`. Translation into a
 * registered metric happens server-side in `normaliseBatch`, because §9.2's
 * registry is the single vocabulary and a client that could name a metric key
 * directly could name one that does not exist, or name the wrong one for the
 * number it is carrying. The mapping table is the only thing allowed to decide
 * that a heart rate is a heart rate.
 *
 * ## Nothing here accepts a `sourceId`
 *
 * Provenance is resolved from the platform and the importer version, server
 * side (§9.2: "provenance is mandatory, not optional"). A client that could
 * choose its own source id could attribute a stream to the wrong device, or —
 * worse — to a *different* source on every chunk, which would defeat the
 * deduplication key and turn a re-import into a doubling.
 */

import { z } from 'zod';

import { instantSchema, zoneSchema } from './timeline';

/**
 * Rows per request.
 *
 * A day of continuous heart rate is roughly 1,500 readings; a week of several
 * streams is a few tens of thousands. Ten thousand keeps a chunk under a couple
 * of megabytes of JSON and a single insert well inside Postgres's parameter
 * budget, while being large enough that importing a year is tens of requests
 * rather than thousands.
 */
export const MAX_SAMPLE_BATCH = 10_000;

export const wearablePlatformSchema = z.enum(['apple_health', 'google_fit']);

export const rawSampleSchema = z.object({
  /** The platform's own type name, untranslated. */
  identifier: z.string().min(1).max(200),
  /**
   * Finite, and that is enforced here rather than left to the normaliser.
   * `z.number()` alone accepts `Infinity`, which survives JSON as `null` in
   * some encoders and as a string in others — neither of which is a reading.
   */
  value: z.number().finite(),
  unit: z.string().min(1).max(40),
  /**
   * An instant with an offset. `instantSchema` already refuses a bare local
   * time, which is the rule that matters most for this endpoint: a wearable
   * export is the artefact most likely to cross a timezone, and a guess would
   * misplace every reading from a flight with nothing afterwards able to tell.
   */
  observedAt: instantSchema,
  /** The zone the device was in. Falls back to the profile's when absent. */
  observedZone: zoneSchema.optional(),
});

export const sampleImportRequestSchema = z.object({
  platform: wearablePlatformSchema,
  /**
   * The importer's version, echoed back into provenance.
   *
   * Client-supplied because the client is what did the extraction — the server
   * never sees the file. A future client that fixes an extraction bug bumps
   * this, gets its own `observation_source`, and its rows stay distinguishable
   * from the ones the broken version wrote (§9.2). Defaulted rather than
   * required so a hand-rolled script is not blocked by bookkeeping.
   */
  importerVersion: z.string().min(1).max(40).default('1'),
  rows: z.array(rawSampleSchema).min(1).max(MAX_SAMPLE_BATCH),
});

export type SampleImportRequest = z.infer<typeof sampleImportRequestSchema>;
export type RawSampleRequest = z.infer<typeof rawSampleSchema>;
