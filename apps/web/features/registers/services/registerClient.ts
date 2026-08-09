'use client';

/**
 * The authoring client — §2.1's "no manual database intervention required".
 *
 * ## These writes go to the network, not the outbox
 *
 * Every other write in the application queues. These do not, and the reason is
 * what they are: defining a routine or registering a medication is a deliberate,
 * once-a-year act performed while sitting down, and its result changes how every
 * *subsequent* write is interpreted.
 *
 * A routine definition queued behind twelve step-completions would be applied
 * after them, and those twelve completions would have been counted against a
 * denominator that no longer exists. Ordering a schema change behind the data it
 * governs is the one case where the outbox is the wrong tool — so these fail
 * visibly and the operator retries, which is correct for a form they are looking
 * at.
 */

import type { CrisisPlan } from '@naitikos/core';

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

async function post<T>(body: Record<string, unknown>): Promise<T> {
  const response = await fetch('/api/registers', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new HttpError(response.status, `Could not save (${String(response.status)}).`);
  }
  return (await response.json()) as T;
}

export type RoutineStepDraft = {
  readonly id: string;
  readonly label: string;
  readonly orderIndex: number;
  readonly isOptional: boolean;
};

export async function defineRoutine(input: {
  readonly id: string;
  readonly kind: 'skincare' | 'dental' | 'supplement' | 'other';
  readonly period: 'am' | 'pm' | 'midday' | 'as_needed';
  readonly name: string;
  readonly expectedAt: string | null;
  readonly steps: readonly RoutineStepDraft[];
}): Promise<void> {
  await post({
    kind: 'routine',
    routine: {
      ...input,
      ...(input.expectedAt === null ? {} : { expectedAt: input.expectedAt }),
      isActive: true,
      // §5.7's envelope is required by the contract even here, where nothing
      // queues: the idempotency key still makes a double-submit one write.
      idempotencyKey: crypto.randomUUID(),
      deviceId: 'browser',
    },
  });
}

export async function registerMedication(input: {
  readonly id: string;
  readonly substance: string;
  readonly brandName: string | null;
  readonly form: string;
  readonly strength: string | null;
  readonly strengthUnit: string | null;
  readonly startedAt: string;
  readonly isPsychiatric: boolean;
  readonly zone: string;
  readonly schedule: {
    readonly id: string;
    readonly dose: string;
    readonly doseUnit: string;
    readonly frequency: string;
    readonly times: readonly string[];
  };
}): Promise<void> {
  await post({
    kind: 'medication',
    medication: {
      ...input,
      ...(input.brandName === null ? {} : { brandName: input.brandName }),
      ...(input.strength === null ? {} : { strength: input.strength }),
      ...(input.strengthUnit === null ? {} : { strengthUnit: input.strengthUnit }),
      idempotencyKey: crypto.randomUUID(),
      deviceId: 'browser',
    },
  });
}

export type CrisisContactDraft = {
  readonly name: string;
  readonly relationship: string | null;
  readonly phone: string | null;
};

export async function saveCrisisPlan(input: {
  readonly id: string;
  readonly warningSigns: string | null;
  readonly copingStrategies: string | null;
  readonly reasonsToLive: string | null;
  readonly contacts: readonly CrisisContactDraft[];
}): Promise<CrisisPlan> {
  const body = await post<{ plan: CrisisPlan }>({
    kind: 'crisis_plan',
    plan: {
      id: input.id,
      ...(input.warningSigns === null ? {} : { warningSigns: input.warningSigns }),
      ...(input.copingStrategies === null ? {} : { copingStrategies: input.copingStrategies }),
      ...(input.reasonsToLive === null ? {} : { reasonsToLive: input.reasonsToLive }),
      contacts: input.contacts.map((contact) => ({
        name: contact.name,
        ...(contact.relationship === null ? {} : { relationship: contact.relationship }),
        ...(contact.phone === null ? {} : { phone: contact.phone }),
      })),
      idempotencyKey: crypto.randomUUID(),
      deviceId: 'browser',
    },
  });
  return body.plan;
}
