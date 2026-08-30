'use client';

/**
 * The Insight feature's client service (§7.3).
 *
 * Writes only, and nothing queues. A disposition is a judgement about a card on
 * screen right now; replaying one from an offline outbox three days later would
 * act on an insight the operator may since have dismissed for a different
 * reason. Same argument `goalClient.ts` makes for a goal definition, for the
 * same reason: the outbox replays in queue order, not causal order.
 */

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export async function setDisposition(input: {
  readonly id: string;
  readonly disposition: 'seen' | 'acted_on' | 'dismissed';
  readonly reason: string | null;
}): Promise<void> {
  const response = await fetch('/api/insights', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as { readonly message?: string } | null;
    throw new HttpError(response.status, detail?.message ?? `Request failed (${String(response.status)}).`);
  }
}
