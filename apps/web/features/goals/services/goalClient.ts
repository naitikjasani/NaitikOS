'use client';

/**
 * The Goals feature's client service (§7.3).
 *
 * Writes only — every goal surface is server-rendered, because a goal page is
 * opened deliberately and rarely and polling one would add exactly the
 * background request §1.4's counter-metric exists to discourage.
 *
 * **Nothing here queues.** A goal changes what every future projection is
 * measured against, and the outbox replays in queue order rather than causal
 * order — a goal applied after the snapshot job had already run would produce a
 * night with no record of a goal that existed. The same reasoning
 * `registerClient.ts` records for routine definitions.
 */

import type { Goal, GoalComparator, GoalStatus } from '@naitikos/core';

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

async function post<T>(body: unknown): Promise<T> {
  const response = await fetch('/api/goals', {
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

export type GoalTargetDraft = {
  readonly id: string;
  readonly metricKey: string;
  readonly comparator: GoalComparator;
  readonly targetValue: string;
  readonly unit: string;
  readonly windowDays: number | null;
};

export type GoalDraft = {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly startedAt: string;
  readonly horizonAt: string | null;
  readonly targets: readonly GoalTargetDraft[];
};

export async function createGoal(draft: GoalDraft): Promise<{ readonly goal: Goal }> {
  return post({ kind: 'create', goal: draft });
}

export async function closeGoal(input: {
  readonly id: string;
  readonly status: Exclude<GoalStatus, 'active'>;
  readonly closingNote: string | null;
}): Promise<{ readonly goal: Goal }> {
  return post({ kind: 'close', close: input });
}
