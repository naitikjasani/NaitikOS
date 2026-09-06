'use client';

/**
 * The device-import client (§7.3).
 *
 * ## The file is read here, in the browser, and split here too
 *
 * Same reasoning as the bank CSV: handing the server a path or a URL turns one
 * endpoint into a proxy for arbitrary outbound requests, and the operator
 * already had the file in order to name it.
 *
 * The chunking is the part that is specific to this import. A wearable export
 * is not a few hundred rows, it is a few hundred thousand, and one request
 * carrying all of them is a request that either succeeds after two minutes or
 * fails after ninety seconds having accomplished nothing. So the file is cut
 * into batches of {@link MAX_SAMPLE_BATCH}, sent one at a time, and the totals
 * accumulate — which makes progress visible and makes a failure partial rather
 * than total.
 *
 * Re-sending a chunk after a failure is safe and cheap. The natural key
 * `(source, metric, instant)` makes a repeat a no-op, so "retry the import"
 * never means "check whether it half-worked first".
 *
 * ## Sequential, not parallel
 *
 * Six concurrent chunks would be faster and would also have six inserts
 * competing for the same unique index on overlapping instants. At n=1, on a
 * file the operator exports a handful of times a year, the wall-clock
 * difference is not worth a deadlock nobody can reproduce.
 *
 * ## Nothing here queues through the outbox
 *
 * §5.7's outbox replays writes that happened while offline. An import is a
 * batch initiated from a file the operator is looking at; queueing it would
 * mean a replay a week later of a file they have since re-imported, which is a
 * confusion with no upside. The same argument `moneyClient.ts` records.
 */

import { MAX_SAMPLE_BATCH } from '@naitikos/api';
import type { WearablePlatform } from '@naitikos/core';

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

/** One row, in the platform's own vocabulary. Untranslated on purpose. */
export type RawSampleRow = {
  readonly identifier: string;
  readonly value: number;
  readonly unit: string;
  readonly observedAt: string;
  readonly observedZone?: string;
};

/** What one chunk did. Mirrors `/api/samples`. */
export type ChunkOutcome = {
  readonly received: number;
  readonly inserted: number;
  readonly alreadyPresent: number;
  readonly duplicatesInBatch: number;
  readonly skipped: Readonly<Record<string, number>>;
  readonly skippedTotal: number;
  readonly rejectedTotal: number;
  readonly rejected: readonly { readonly identifier: string; readonly reason: string; readonly observedAt: string }[];
};

/** The whole file, summed. Every number here is shown to the operator (§8.9). */
export type ImportSummary = {
  readonly chunks: number;
  readonly received: number;
  readonly inserted: number;
  readonly alreadyPresent: number;
  readonly duplicatesInBatch: number;
  readonly skipped: Readonly<Record<string, number>>;
  readonly skippedTotal: number;
  readonly rejectedTotal: number;
  /** The first few, with reasons. The rest are counted in `rejectedTotal`. */
  readonly rejected: readonly { readonly identifier: string; readonly reason: string; readonly observedAt: string }[];
};

/** How many rejection descriptions the summary carries before it stops. */
const SUMMARY_REJECTION_LIMIT = 25;

async function postChunk(
  platform: WearablePlatform,
  importerVersion: string,
  rows: readonly RawSampleRow[],
): Promise<ChunkOutcome> {
  const response = await fetch('/api/samples', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ platform, importerVersion, rows }),
  });
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as { readonly message?: string } | null;
    throw new HttpError(response.status, detail?.message ?? `Request failed (${String(response.status)}).`);
  }
  return (await response.json()) as ChunkOutcome;
}

/**
 * Parse a JSON export into rows.
 *
 * Accepts either a bare array or `{ rows: [...] }`, because both shapes come
 * out of the shortcuts and scripts people actually use. Anything else throws
 * with a sentence rather than a stack — the operator is holding a file they
 * exported from a phone and needs to know it is the wrong one, not why
 * `Array.isArray` returned false.
 */
export function parseSampleFile(text: string): readonly RawSampleRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('That file is not JSON. Export as JSON, not XML or CSV.');
  }

  const candidate =
    Array.isArray(parsed) ? parsed
    : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { rows?: unknown }).rows) ?
      ((parsed as { rows: unknown[] }).rows)
    : null;

  if (candidate === null) {
    throw new Error('Expected a list of readings, or an object with a "rows" list.');
  }

  const rows: RawSampleRow[] = [];
  for (const entry of candidate) {
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as Record<string, unknown>;
    const identifier = row['identifier'] ?? row['type'];
    const observedAt = row['observedAt'] ?? row['date'] ?? row['startDate'];
    const value = typeof row['value'] === 'string' ? Number(row['value']) : row['value'];
    const zone = row['observedZone'];

    if (typeof identifier !== 'string' || typeof observedAt !== 'string' || typeof value !== 'number') {
      /*
       * Dropped here rather than sent and rejected. A row missing the three
       * fields that identify it cannot be described in a rejection message
       * either — there is nothing to name it by — so counting it as received
       * would inflate every total on the summary.
       */
      continue;
    }

    rows.push({
      identifier,
      value,
      unit: typeof row['unit'] === 'string' ? row['unit'] : '',
      observedAt,
      ...(typeof zone === 'string' ? { observedZone: zone } : {}),
    });
  }

  if (rows.length === 0) {
    throw new Error('No readings in that file. Each one needs an identifier, a value and a timestamp.');
  }

  return rows;
}

export async function importSamples(
  platform: WearablePlatform,
  importerVersion: string,
  rows: readonly RawSampleRow[],
  onProgress?: (sent: number, total: number) => void,
): Promise<ImportSummary> {
  let chunks = 0;
  let received = 0;
  let inserted = 0;
  let alreadyPresent = 0;
  let duplicatesInBatch = 0;
  let skippedTotal = 0;
  let rejectedTotal = 0;
  const skipped: Record<string, number> = {};
  const rejected: ChunkOutcome['rejected'][number][] = [];

  for (let offset = 0; offset < rows.length; offset += MAX_SAMPLE_BATCH) {
    const slice = rows.slice(offset, offset + MAX_SAMPLE_BATCH);
    const outcome = await postChunk(platform, importerVersion, slice);

    chunks += 1;
    received += outcome.received;
    inserted += outcome.inserted;
    alreadyPresent += outcome.alreadyPresent;
    duplicatesInBatch += outcome.duplicatesInBatch;
    skippedTotal += outcome.skippedTotal;
    rejectedTotal += outcome.rejectedTotal;

    for (const [identifier, count] of Object.entries(outcome.skipped)) {
      skipped[identifier] = (skipped[identifier] ?? 0) + count;
    }
    for (const entry of outcome.rejected) {
      if (rejected.length < SUMMARY_REJECTION_LIMIT) rejected.push(entry);
    }

    onProgress?.(Math.min(offset + MAX_SAMPLE_BATCH, rows.length), rows.length);
  }

  return {
    chunks,
    received,
    inserted,
    alreadyPresent,
    duplicatesInBatch,
    skipped,
    skippedTotal,
    rejectedTotal,
    rejected,
  };
}

export { MAX_SAMPLE_BATCH };
