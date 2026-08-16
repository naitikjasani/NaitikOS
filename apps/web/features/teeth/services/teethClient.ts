'use client';

/**
 * The Teeth feature's client service (§7.3).
 *
 * One write. Everything else Teeth does is a filtered read of Health's data, or
 * a routine tap that already goes through the skin feature's routine client —
 * the engine is shared, so its transport is shared too rather than being copied
 * under a dental name. §9.2's "one implementation, three consumers", applied to
 * the wire as well as to the engine.
 *
 * It does not queue. A procedure is entered at a desk, minutes or years after
 * it happened, and it changes the shape of the record rather than adding an
 * observation to it.
 */

import type { DentalProcedure } from '@naitikos/core';

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export type ProcedureDraft = {
  readonly id: string;
  readonly name: string;
  readonly toothNotation: string | null;
  readonly performedBy: string | null;
  readonly location: string | null;
  readonly performedAt: string;
  readonly zone: string;
  readonly outcome: string | null;
  readonly complications: string | null;
  readonly costMinor: number | null;
  readonly currency: string | null;
};

export async function recordProcedure(draft: ProcedureDraft): Promise<{ readonly procedure: DentalProcedure }> {
  const response = await fetch('/api/health', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ kind: 'procedure', procedure: draft }),
  });
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as { readonly message?: string } | null;
    throw new HttpError(response.status, detail?.message ?? `Request failed (${String(response.status)}).`);
  }
  return (await response.json()) as { readonly procedure: DentalProcedure };
}
