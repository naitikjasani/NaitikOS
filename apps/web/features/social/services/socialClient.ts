'use client';

/**
 * The People and Places client service (§7.3).
 *
 * **Writes only.** Both surfaces are server-rendered and re-read through
 * `router.refresh()` after a write. A relationship log is opened deliberately
 * rather than watched, and polling one would add exactly the background request
 * §1.4's counter-metric exists to discourage.
 *
 * **Nothing here queues through the outbox.** Every call is a state transition
 * on a named row, and the outbox replays in queue order rather than causal
 * order — the same argument `workClient.ts` and `moneyClient.ts` record. The
 * one write that would genuinely benefit from offline queueing is recording a
 * contact, which is the kind of thing done on a train; it is not queued because
 * a replay that resurrected a contact the operator had since deleted would be
 * worse than a failed request they can see.
 */

import type {
  InteractionKind,
  PlaceKind,
  RelationshipKind,
  TripPurpose,
} from '@naitikos/core';

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

async function post<T>(body: unknown): Promise<T> {
  const response = await fetch('/api/social', {
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

export type PersonDraft = {
  readonly id: string;
  readonly name: string;
  readonly relationship: RelationshipKind;
  readonly context: string | null;
  /** `--MM-DD`. The year is not stored. */
  readonly birthday: string | null;
  readonly cadenceDays: number | null;
};

export async function savePerson(person: PersonDraft): Promise<void> {
  await post({ kind: 'person', person });
}

export async function deletePerson(id: string, reason: string | null): Promise<void> {
  await post({ kind: 'person_delete', delete: { id, reason } });
}

export type InteractionDraft = {
  readonly id: string;
  readonly personId: string;
  readonly kind: InteractionKind;
  readonly occurredAt: string;
  readonly zone: string;
  readonly note: string | null;
};

export async function recordInteraction(interaction: InteractionDraft): Promise<void> {
  /* No `dayKey`. The server derives it from the instant and the zone, so the
   * two can never be sent disagreeing. */
  await post({ kind: 'interaction', interaction });
}

export async function deleteInteraction(id: string, reason: string | null): Promise<void> {
  await post({ kind: 'interaction_delete', delete: { id, reason } });
}

export type PlaceDraft = {
  readonly id: string;
  readonly name: string;
  readonly kind: PlaceKind;
  readonly countryCode: string | null;
  readonly zone: string | null;
  readonly latitude: string | null;
  readonly longitude: string | null;
  readonly notes: string | null;
};

export async function savePlace(place: PlaceDraft): Promise<void> {
  await post({ kind: 'place', place });
}

export async function deletePlace(id: string, reason: string | null): Promise<void> {
  await post({ kind: 'place_delete', delete: { id, reason } });
}

export type TripDraft = {
  readonly id: string;
  readonly title: string;
  readonly purpose: TripPurpose;
  readonly startedOn: string;
  readonly endedOn: string | null;
  readonly notes: string | null;
};

export async function saveTrip(trip: TripDraft): Promise<void> {
  await post({ kind: 'trip', trip });
}

export async function deleteTrip(id: string, reason: string | null): Promise<void> {
  await post({ kind: 'trip_delete', delete: { id, reason } });
}

export type VisitDraft = {
  readonly id: string;
  readonly placeId: string;
  readonly tripId: string | null;
  readonly arrivedOn: string;
  readonly departedOn: string | null;
  readonly notes: string | null;
};

export async function saveVisit(visit: VisitDraft): Promise<void> {
  await post({ kind: 'visit', visit });
}

export async function deleteVisit(id: string, reason: string | null): Promise<void> {
  await post({ kind: 'visit_delete', delete: { id, reason } });
}
