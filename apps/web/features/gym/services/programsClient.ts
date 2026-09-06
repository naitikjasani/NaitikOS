'use client';

/**
 * The program-definition client (§7.3).
 *
 * **Writes only.** Both program surfaces are server-rendered and re-read
 * through `router.refresh()`. A training plan is written once a mesocycle and
 * read at the start of a session; polling one would add a background request
 * for a row that changes six times a year.
 *
 * **Nothing here queues through the outbox.** §5.7's queue is for facts
 * captured away from a connection — a set logged in a basement gym. Defining a
 * program is deliberate desk work, and a replayed activation arriving a week
 * later would stand down whatever plan the operator had since chosen.
 */

import type { PrescribedExercise } from '@naitikos/core';

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

async function post<T>(body: unknown): Promise<T> {
  const response = await fetch('/api/gym/program', {
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

export type ProgramDraft = {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly targetFrequency: number | null;
};

export async function saveProgram(program: ProgramDraft): Promise<void> {
  await post({ kind: 'program', program });
}

/**
 * Make one program the active one.
 *
 * A kind of its own rather than a field on the draft: `program_one_active` is a
 * partial unique index, so this is a transition across two rows in a
 * transaction, and a boolean on an upsert would produce a constraint violation
 * the first time two programs existed.
 */
export async function activateProgram(id: string): Promise<void> {
  await post({ kind: 'program_activate', id });
}

export async function retireProgram(id: string, endedAt: string): Promise<void> {
  await post({ kind: 'program_retire', id, endedAt });
}

export async function deleteProgram(id: string, reason: string | null): Promise<void> {
  await post({ kind: 'program_delete', delete: { id, reason } });
}

export type BlockDraft = {
  readonly id: string;
  readonly programId: string;
  readonly name: string;
  readonly orderIndex: number;
  readonly prescription: readonly PrescribedExercise[];
  readonly notes: string | null;
};

export async function saveBlock(block: BlockDraft): Promise<void> {
  await post({ kind: 'block', block });
}

export async function deleteBlock(id: string, reason: string | null): Promise<void> {
  await post({ kind: 'block_delete', delete: { id, reason } });
}
