'use client';

/**
 * The Daily Close's client-side service (§7.3: "services — API calls").
 *
 * Two functions, and the asymmetry between them is the whole design.
 *
 * **Reading goes straight to the network** and falls back to TanStack Query's
 * persisted cache when it fails. A stale form is useful; a missing one is not.
 *
 * **Writing never goes straight to the network.** It goes into the IndexedDB
 * outbox and the drain sends it. §5.7 is unambiguous that "a failed drain must
 * never silently discard a write", and the only way to make that true is for the
 * durable write to happen *before* the request rather than after it fails.
 *
 * The practical consequence is that submitting a Close cannot fail from the
 * operator's point of view. It is queued; the banner says so; it is sent when it
 * can be. That is what makes the ritual survivable in a gym basement.
 */

import type { CloseField } from '@naitikos/core';

import { newIdempotencyKey, offlineEnvelope } from '@/lib/offline/device';
import { queueAndDrain } from '@/lib/offline/drain';

export type CloseAnswerValue =
  | { readonly kind: 'number'; readonly value: string; readonly unit?: string }
  | { readonly kind: 'integer'; readonly value: number }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'text'; readonly value: string };

export type StoredAnswer = {
  readonly value: string;
  readonly valueText: string | null;
  readonly decoded:
    | { readonly kind: 'integer'; readonly value: number }
    | { readonly kind: 'number'; readonly value: unknown; readonly unit: string }
    | { readonly kind: 'boolean'; readonly value: boolean }
    | { readonly kind: 'category'; readonly value: string; readonly ordinal: number }
    | { readonly kind: 'text'; readonly value: string }
    | null;
};

export type CloseSnapshot = {
  readonly dayKey: string;
  readonly zone: string;
  readonly isClosed: boolean;
  readonly fields: readonly CloseField[];
  readonly budget: { readonly count: number; readonly limit: number; readonly withinBudget: boolean };
  readonly overflow: readonly CloseField[];
  readonly answers: Readonly<Record<string, StoredAnswer>>;
  readonly note: string | null;
};

/** An HTTP failure with its status attached, so the query client can see it. */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

/** Fetch the form and the day's current answers. One round trip, on purpose. */
export async function fetchClose(dayKey: string, zone: string): Promise<CloseSnapshot> {
  const params = new URLSearchParams({ dayKey, zone });
  const response = await fetch(`/api/close?${params.toString()}`, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    throw new HttpError(response.status, `Could not load the Close (${String(response.status)}).`);
  }
  return (await response.json()) as CloseSnapshot;
}

export type SubmitAnswer =
  | { readonly kind: 'metric'; readonly metricKey: string; readonly value: CloseAnswerValue }
  | { readonly kind: 'medication'; readonly medicationId: string; readonly taken: boolean }
  | { readonly kind: 'note'; readonly text: string };

/**
 * Queue a Close.
 *
 * The id is the entry's *and* the idempotency key, so however many times the
 * drain replays it, the server sees one submission. Resolves as soon as the
 * entry is durable in IndexedDB — not when the server has it.
 */
export async function submitClose(
  dayKey: string,
  zone: string,
  answers: readonly SubmitAnswer[],
): Promise<{ readonly queuedId: string }> {
  const entry = await queueAndDrain({
    id: newIdempotencyKey(),
    endpoint: '/api/close',
    method: 'POST',
    body: { dayKey, zone, answers, ...offlineEnvelope() },
    // Shown in the unsynced banner. A day, not the answers — §5.13 keeps user
    // content out of anything that might end up in a log.
    label: `Daily Close · ${dayKey}`,
  });

  return { queuedId: entry.id };
}
