'use client';

/**
 * The Work feature's client service (§7.3).
 *
 * Writes only — every Work surface is server-rendered. A work page is opened
 * deliberately rather than watched, and polling one would add exactly the
 * background request §1.4's counter-metric exists to discourage.
 *
 * **Nothing here queues through the outbox.** Closing a task is not an
 * observation: it is a state transition on a row, and the outbox replays in
 * queue order rather than causal order. A close replayed after a reopen would
 * leave the task in the wrong state with no error anywhere. The observation
 * path has idempotent inserts to protect it; this path has none, so it stays
 * online-only and says so.
 */

import type { CareerEntry, CareerEntryKind, ProjectStatus, Task, WorkProject } from '@naitikos/core';

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

async function post<T>(body: unknown): Promise<T> {
  const response = await fetch('/api/work', {
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

export type ProjectDraft = {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly startedAt: string | null;
  readonly context: string | null;
};

export async function createProject(draft: ProjectDraft): Promise<{ readonly project: WorkProject }> {
  return post({ kind: 'project', project: draft });
}

export async function setProjectStatus(
  id: string,
  status: ProjectStatus,
): Promise<{ readonly project: WorkProject }> {
  return post({ kind: 'project_status', status: { id, status } });
}

export type TaskDraft = {
  readonly id: string;
  readonly title: string;
  readonly note: string | null;
  readonly projectId: string | null;
  readonly dueDayKey: string | null;
};

export async function createTask(draft: TaskDraft): Promise<{ readonly task: Task }> {
  return post({ kind: 'task', task: draft });
}

export async function closeTask(input: {
  readonly id: string;
  readonly status: 'done' | 'dropped';
  readonly zone: string;
  readonly droppedReason?: string | null;
}): Promise<{ readonly task: Task }> {
  return post({ kind: 'task_close', close: input });
}

export async function reopenTask(id: string): Promise<{ readonly task: Task }> {
  return post({ kind: 'task_reopen', reopen: { id } });
}

export type CareerDraft = {
  readonly id: string;
  readonly kind: CareerEntryKind;
  readonly title: string;
  readonly detail: string | null;
  readonly occurredAt: string;
  readonly zone: string;
  readonly projectId: string | null;
  readonly attributedTo: string | null;
  readonly artifactUrl: string | null;
  readonly isVisibleToLeadership: boolean | null;
  readonly skills: readonly string[];
};

export async function recordCareerEntry(draft: CareerDraft): Promise<{ readonly entry: CareerEntry }> {
  return post({ kind: 'career', entry: draft });
}
