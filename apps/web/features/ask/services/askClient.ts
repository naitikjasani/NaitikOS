'use client';

/**
 * The Ask feature's client service (§7.3).
 *
 * Does not queue. A question is only worth answering against the record as it
 * is now — replaying one from an offline outbox three days later would produce
 * an answer to a question nobody is still asking, against data that has since
 * moved. §5.7's queue is for facts; this is an enquiry.
 */

import type { AskResult } from '@/lib/platform/ask';

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
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

/**
 * Ask a question.
 *
 * `threadId` is optional and asking without one is the default. §2.5 demotes
 * Ask deliberately; a surface that saved every question by itself would be a
 * chat log the operator never chose to keep.
 */
export async function askQuestion(question: string, threadId?: string): Promise<AskResult> {
  return post<AskResult>('/api/ask', threadId === undefined ? { question } : { question, threadId });
}

export type ThreadDraft = {
  readonly id: string;
  readonly title: string;
  readonly note: string | null;
};

export async function saveThread(thread: ThreadDraft): Promise<void> {
  await post('/api/enquiry', { kind: 'thread', thread });
}

export async function deleteThread(id: string, reason: string | null): Promise<void> {
  await post('/api/enquiry', { kind: 'thread_delete', delete: { id, reason } });
}

export async function deleteTurn(id: string, reason: string | null): Promise<void> {
  await post('/api/enquiry', { kind: 'turn_delete', delete: { id, reason } });
}
