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

export async function askQuestion(question: string): Promise<AskResult> {
  const response = await fetch('/api/ask', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ question }),
  });

  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as { readonly message?: string } | null;
    throw new HttpError(response.status, detail?.message ?? `Request failed (${String(response.status)}).`);
  }

  return (await response.json()) as AskResult;
}
