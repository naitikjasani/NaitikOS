'use client';

/**
 * The Sleep feature's client service (§7.3).
 *
 * Writes only. `/body/sleep` is server-rendered — a night is recorded once, on
 * waking, and there is nothing on the page that changes while it is open.
 * Polling it would add exactly the background request §1.4's capture-friction
 * counter-metric exists to discourage.
 *
 * **Nothing here queues through the outbox.** A night is unique on its day key,
 * so a replayed write is a uniqueness violation rather than a harmless
 * duplicate — and the outbox replays in queue order rather than causal order, so
 * a delete replayed after a correction would remove the corrected row with
 * nothing anywhere to detect it. The observation path has idempotent inserts to
 * protect it; this one does not, so it stays online-only and the form says so.
 */

import type { SleepDisturbance, SleepNight } from '@naitikos/core';

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

async function post<T>(body: unknown): Promise<T> {
  const response = await fetch('/api/sleep', {
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

export type NightDraft = {
  readonly id: string;
  /** The morning this night ended, not the evening it started. */
  readonly dayKey: string;
  readonly zone: string;
  readonly bedAt: string | null;
  readonly wokeAt: string | null;
  /**
   * A decimal string, sent independently of the two endpoints.
   *
   * Deliberately not computed from `bedAt` and `wokeAt` on this side either:
   * time in bed is not time asleep, and a client-side derivation would be the
   * same overstatement the server refuses to make.
   */
  readonly durationHours: string | null;
  readonly quality: number | null;
  readonly latencyMinutes: number | null;
  readonly wakings: number | null;
  readonly disturbance: SleepDisturbance | null;
  readonly disturbanceNote: string | null;
  readonly note: string | null;
};

export async function recordNight(draft: NightDraft): Promise<{ readonly night: SleepNight }> {
  return post({ kind: 'night', night: draft });
}

export async function deleteNight(
  id: string,
  reason: string | null,
): Promise<{ readonly deleted: boolean }> {
  return post({ kind: 'night_delete', night: { id, reason } });
}
