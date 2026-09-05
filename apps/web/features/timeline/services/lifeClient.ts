'use client';

/**
 * The Life Timeline's client service (§7.3).
 *
 * Writes only. The timeline is server-rendered — it is opened deliberately and
 * rarely, and it holds a few dozen rows that change a handful of times a year.
 * Polling it would add exactly the background request §1.4's counter-metric
 * exists to discourage.
 *
 * **Nothing here queues through the outbox.** These are state transitions on
 * authored rows, not appended observations, and the outbox replays in queue
 * order rather than causal order — closing a span replayed after an edit would
 * leave the row wrong with nothing to detect it. The same reasoning
 * `workClient.ts` records.
 */

import type { LifeEvent, LifeSpan, LifeSpanKind } from '@naitikos/core';

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

async function post<T>(body: unknown): Promise<T> {
  const response = await fetch('/api/life', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as { readonly message?: string } | null;
    throw new HttpError(response.status, detail?.message ?? `Request failed (${String(response.status)}).`);
  }
  return (await response.json()) as T;
}

export type SpanDraft = {
  readonly id: string;
  readonly kind: LifeSpanKind;
  readonly title: string;
  readonly description: string | null;
  readonly startedAt: string;
  /** `null` while it is still running — never today's date standing in for one. */
  readonly endedAt: string | null;
  readonly parentId: string | null;
  readonly slot: number | null;
};

export async function saveSpan(draft: SpanDraft): Promise<{ readonly span: LifeSpan }> {
  return post({ kind: 'span', span: draft });
}

export async function closeSpan(input: {
  readonly id: string;
  readonly endedAt: string;
}): Promise<{ readonly span: LifeSpan }> {
  return post({ kind: 'span_close', close: input });
}

export type EventDraft = {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly occurredAt: string;
  readonly spanId: string | null;
  readonly significance: number | null;
};

export async function saveEvent(draft: EventDraft): Promise<{ readonly event: LifeEvent }> {
  return post({ kind: 'event', event: draft });
}
