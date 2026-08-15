'use client';

/**
 * The Health feature's client service (§7.3).
 *
 * Reads are server-rendered — every Health screen is opened deliberately and
 * none of them polls — so this file is writes only.
 *
 * ## Only two of these queue offline
 *
 * A vital reading and a symptom are captures: they happen wherever the operator
 * is, they belong to the moment they were taken, and §5.7's outbox is what
 * makes that work in a clinic corridor with no signal.
 *
 * Everything else goes straight to the network. A condition, an appointment or
 * a confirmed lab panel changes the *shape* of the record, and the outbox
 * replays in queue order rather than in causal order — a panel applied after
 * the questions derived from it would produce a consultation list built from a
 * record that did not yet contain the result. The same reasoning
 * `registers/services/registerClient.ts` records for routine definitions.
 */

import type {
  AppointmentQuestion,
  Condition,
  ConditionStatus,
  Severity,
  SideEffect,
  Symptom,
} from '@naitikos/core';

import { newIdempotencyKey, offlineEnvelope } from '@/lib/offline/device';
import { queueAndDrain } from '@/lib/offline/drain';

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

async function post<T>(body: unknown): Promise<T> {
  const response = await fetch('/api/health', {
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

/* -------------------------------------------------------------------------
 * Captures — these queue
 * ---------------------------------------------------------------------- */

export type VitalReadingDraft = {
  readonly id: string;
  readonly observedAt: string;
  readonly observedZone: string;
  readonly systolic: number | null;
  readonly diastolic: number | null;
  readonly restingHeartRate: number | null;
  readonly temperatureCelsius: string | null;
  readonly oxygenSaturation: number | null;
};

export async function recordVitals(draft: VitalReadingDraft): Promise<void> {
  await queueAndDrain({
    id: newIdempotencyKey(),
    endpoint: '/api/health',
    method: 'POST',
    body: { kind: 'vitals', reading: { ...draft, ...offlineEnvelope() } },
    label: 'Vitals',
  });
}

export type SymptomDraft = {
  readonly id: string;
  readonly name: string;
  readonly bodySite: string | null;
  readonly severity: Severity | null;
  readonly intensity: number | null;
  readonly startedAt: string;
  readonly zone: string;
  readonly suspectedTrigger: string | null;
  readonly note: string | null;
};

export async function logSymptom(draft: SymptomDraft): Promise<void> {
  await queueAndDrain({
    id: newIdempotencyKey(),
    endpoint: '/api/health',
    method: 'POST',
    body: { kind: 'symptom', symptom: { ...draft, ...offlineEnvelope() } },
    label: `Symptom · ${draft.name}`,
  });
}

export async function endSymptom(id: string, endedAt: string): Promise<void> {
  await queueAndDrain({
    id: newIdempotencyKey(),
    endpoint: '/api/health',
    method: 'POST',
    body: { kind: 'symptom_end', end: { id, endedAt } },
    label: 'Symptom ended',
  });
}

/* -------------------------------------------------------------------------
 * Register changes — these do not
 * ---------------------------------------------------------------------- */

export type ConditionDraft = {
  readonly id: string;
  readonly name: string;
  readonly status: ConditionStatus;
  readonly severity: Severity | null;
  readonly diagnosedBy: string | null;
  readonly onsetAt: string;
  readonly zone: string;
  readonly note: string | null;
};

export async function addCondition(draft: ConditionDraft): Promise<{ readonly condition: Condition }> {
  return post({ kind: 'condition', condition: draft });
}

export async function reviseCondition(input: {
  readonly id: string;
  readonly successorId: string;
  readonly status: ConditionStatus;
  readonly note: string | null;
}): Promise<{ readonly condition: Condition }> {
  return post({ kind: 'condition_status', change: input });
}

export type SideEffectDraft = {
  readonly id: string;
  readonly effect: string;
  readonly suspectedMedicationId: string | null;
  readonly severity: Severity | null;
  readonly onsetAt: string;
  readonly zone: string;
  readonly note: string | null;
};

export async function recordSideEffect(draft: SideEffectDraft): Promise<{ readonly sideEffect: SideEffect }> {
  return post({ kind: 'side_effect', sideEffect: draft });
}

export async function markSideEffectReported(id: string): Promise<void> {
  await post({ kind: 'side_effect_reported', reported: { id } });
}

export type AppointmentDraft = {
  readonly id: string;
  readonly title: string;
  readonly provider: string | null;
  readonly specialty: string | null;
  readonly location: string | null;
  readonly scheduledFor: string;
  readonly zone: string;
};

export async function scheduleAppointment(draft: AppointmentDraft): Promise<void> {
  await post({ kind: 'appointment', appointment: draft });
}

export async function saveQuestions(id: string, questions: readonly AppointmentQuestion[]): Promise<void> {
  await post({ kind: 'appointment_questions', questions: { id, questions } });
}

export async function recordVisitNotes(input: {
  readonly id: string;
  readonly attendedAt: string | null;
  readonly postVisitNotes: string | null;
  readonly outcome: string | null;
}): Promise<void> {
  await post({ kind: 'visit_notes', notes: input });
}

export type { Symptom };
