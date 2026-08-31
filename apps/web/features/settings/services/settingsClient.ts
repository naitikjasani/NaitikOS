'use client';

/**
 * The settings feature's client service (§7.3).
 *
 * Nothing queues. A consent change must take effect now or not at all — an
 * offline outbox replaying a *grant* three days later, after the operator had
 * withdrawn it, would send data on the strength of a decision that had been
 * reversed. §5.7's queue is for facts about the past; this is a rule about the
 * future.
 */

import type { AiPreferences } from '@naitikos/core';

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export async function saveAiSettings(next: AiPreferences): Promise<void> {
  const response = await fetch('/api/settings', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    /* All four scopes, always. A partial patch would let a UI bug preserve a
     * grant the operator had just cleared — see the route's schema. */
    body: JSON.stringify({ kind: 'ai', ...next }),
  });

  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as { readonly message?: string } | null;
    throw new HttpError(response.status, detail?.message ?? `Request failed (${String(response.status)}).`);
  }
}
