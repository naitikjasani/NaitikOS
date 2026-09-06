'use client';

/**
 * The Mind feature's client service (§7.3).
 *
 * Same asymmetry as Gym: **reads go to the network, writes go to the outbox.**
 * The reason here is not a basement — it is that the moment somebody wants to
 * record an anxiety episode is not a moment to discover the network is down.
 *
 * ## Two things this file does that the Gym client does not
 *
 * **The outbox label for a journal entry carries no content.** §5.13 keeps user
 * content out of anything that could end up in a log, and the sync banner is a
 * log with a UI. The label is a date.
 *
 * **A journal entry is never cached.** `fetchJournalEntry` sends
 * `cache: 'no-store'`, matching the `Cache-Control` the route sets, and the
 * screen's query runs with `gcTime: 0` so it leaves memory on unmount. The
 * service worker never caches `/api/` at all. Three layers, because a cached
 * journal entry is a copy of the most sensitive data in the system sitting in a
 * browser cache directory (§4.7).
 */

import type {
  AnxietyEpisode,
  CrisisPlan,
  DailyValue,
  JournalEntry,
  JournalListItem,
  JournalPrompt,
  Medication,
  MedicationAnnotation,
  MindScaleId,
  Movement,
  PracticeSession,
  WindowAdherence,
} from '@naitikos/core';

import { newIdempotencyKey, offlineEnvelope } from '@/lib/offline/device';
import { queueAndDrain } from '@/lib/offline/drain';

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

async function getJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
    ...init,
  });
  if (!response.ok) {
    throw new HttpError(response.status, `Request failed (${String(response.status)}).`);
  }
  return (await response.json()) as T;
}

/* -------------------------------------------------------------------------
 * Reads
 * ---------------------------------------------------------------------- */

export type ScaleSeries = {
  readonly id: MindScaleId;
  readonly label: string;
  readonly metricKey: string;
  readonly points: readonly DailyValue[];
  readonly movement: Movement;
};

export type MindOverview = {
  readonly fromDayKey: string;
  readonly toDayKey: string;
  readonly scales: readonly ScaleSeries[];
  readonly annotations: readonly MedicationAnnotation[];
  readonly episodes: readonly AnxietyEpisode[];
  readonly practices: readonly PracticeSession[];
  readonly crisis: { readonly plan: CrisisPlan } | null;
  readonly invitePlanning: boolean;
  readonly prompt: JournalPrompt | null;
  /** Every active prompt, for `/mind/journal/prompts`. See the server type. */
  readonly promptLibrary: readonly JournalPrompt[];
  readonly journal: readonly JournalListItem[];
};

export async function fetchMindOverview(
  fromDayKey: string,
  toDayKey: string,
  zone: string,
): Promise<MindOverview> {
  const params = new URLSearchParams({ fromDayKey, toDayKey, zone });
  return getJson<MindOverview>(`/api/mind/overview?${params.toString()}`);
}

export type JournalIndex = {
  readonly entries: readonly JournalListItem[];
  readonly prompts: readonly JournalPrompt[];
};

export async function fetchJournalIndex(): Promise<JournalIndex> {
  return getJson<JournalIndex>('/api/mind/journal');
}

export async function fetchJournalEntry(id: string): Promise<JournalEntry> {
  // Never cached, at any layer. See the file header.
  const body = await getJson<{ entry: JournalEntry }>(`/api/mind/journal/${id}`, { cache: 'no-store' });
  return body.entry;
}

export type MedicationLens = {
  readonly medications: readonly Medication[];
  readonly adherence: readonly WindowAdherence[];
  readonly annotations: readonly MedicationAnnotation[];
  readonly windowDays: number;
};

export async function fetchMedications(
  toDayKey: string,
  zone: string,
  options: { readonly windowDays?: number; readonly psychiatricOnly?: boolean } = {},
): Promise<MedicationLens> {
  const params = new URLSearchParams({ toDayKey, zone });
  if (options.windowDays !== undefined) params.set('windowDays', String(options.windowDays));
  if (options.psychiatricOnly === true) params.set('lens', 'psychiatric');
  return getJson<MedicationLens>(`/api/medications?${params.toString()}`);
}

/* -------------------------------------------------------------------------
 * Writes — all through the outbox
 * ---------------------------------------------------------------------- */

export async function logEpisode(input: {
  readonly id: string;
  readonly startedAt: string;
  readonly endedAt?: string | null;
  readonly zone: string;
  readonly intensity?: number | null;
  readonly trigger?: string | null;
  readonly copingResponse?: string | null;
  readonly outcome?: string | null;
  readonly note?: string | null;
}): Promise<void> {
  await queueAndDrain({
    id: newIdempotencyKey(),
    endpoint: '/api/mind/episodes',
    method: 'POST',
    body: { ...stripNullish(input), ...offlineEnvelope() },
    // A date and nothing else. The trigger and the note are user content.
    label: `Episode · ${input.startedAt.slice(0, 10)}`,
  });
}

export async function logJournalEntry(input: {
  readonly id: string;
  readonly writtenAt: string;
  readonly zone: string;
  readonly title?: string | null;
  readonly content: string;
  readonly promptId?: string | null;
  readonly moodAtWriting?: number | null;
}): Promise<void> {
  await queueAndDrain({
    id: newIdempotencyKey(),
    endpoint: '/api/mind/journal',
    method: 'POST',
    body: { ...stripNullish(input), ...offlineEnvelope() },
    label: `Journal · ${input.writtenAt.slice(0, 10)}`,
  });
}

export async function logPractice(input: {
  readonly id: string;
  readonly kind: string;
  readonly startedAt: string;
  readonly zone: string;
  readonly durationMinutes?: number | null;
  readonly method?: string | null;
  readonly stateBefore?: number | null;
  readonly stateAfter?: number | null;
}): Promise<void> {
  await queueAndDrain({
    id: newIdempotencyKey(),
    endpoint: '/api/mind/practices',
    method: 'POST',
    body: { ...stripNullish(input), ...offlineEnvelope() },
    label: `${input.kind} · ${input.startedAt.slice(0, 10)}`,
  });
}

export async function logDose(input: {
  readonly id: string;
  readonly medicationId: string;
  readonly scheduleId?: string | null;
  readonly kind: 'taken' | 'skipped' | 'delayed';
  readonly scheduledFor: string;
  readonly takenAt?: string | null;
  readonly zone: string;
}): Promise<void> {
  await queueAndDrain({
    id: newIdempotencyKey(),
    endpoint: '/api/medications',
    method: 'POST',
    body: { ...stripNullish(input), ...offlineEnvelope() },
    label: `Dose · ${input.scheduledFor.slice(0, 10)}`,
  });
}

/**
 * Drop `undefined` and `null` before the request body is built.
 *
 * The contracts accept `nullish`, so a null would pass — but it would also
 * overwrite a value the operator set earlier when the same shape is reused for
 * an edit. Omission and explicit null are different instructions, and the UI
 * only ever means the first.
 */
function stripNullish<T extends Record<string, unknown>>(input: T): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    output[key] = value;
  }
  return output;
}
