'use client';

/**
 * The Skin feature's client service (§7.3).
 *
 * Reads to the network, writes to the outbox, as everywhere. The routine tap is
 * the one that matters offline: §4.2's AM routine happens at 07:00 in a
 * bathroom, and the operator should not learn about their signal there.
 */

import type {
  ProductChange,
  ProductEvent,
  Reaction,
  Routine,
  RoutineStep,
  RoutineWindowAdherence,
  SkinState,
  SkincareProduct,
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

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new HttpError(response.status, `Request failed (${String(response.status)}).`);
  }
  return (await response.json()) as T;
}

/* -------------------------------------------------------------------------
 * Reads
 * ---------------------------------------------------------------------- */

export type SkinOverview = {
  readonly fromDayKey: string;
  readonly toDayKey: string;
  readonly states: readonly SkinState[];
  readonly regions: readonly {
    readonly region: string;
    readonly recordedDays: number;
    readonly meanState: number | null;
    readonly latestState: number | null;
    readonly latestLesionCount: number | null;
  }[];
  readonly flares: readonly {
    readonly dayKey: string;
    readonly suspectedTrigger: string | null;
    readonly changes: readonly ProductChange[];
  }[];
};

export async function fetchSkinOverview(fromDayKey: string, toDayKey: string): Promise<SkinOverview> {
  const params = new URLSearchParams({ fromDayKey, toDayKey });
  return getJson<SkinOverview>(`/api/skin/state?${params.toString()}`);
}

export type ProductRegister = {
  readonly products: readonly { readonly product: SkincareProduct; readonly daysInUse: number | null }[];
  readonly reactions: readonly Reaction[];
  readonly events: readonly ProductEvent[];
};

export async function fetchProducts(asOfDayKey: string): Promise<ProductRegister> {
  return getJson<ProductRegister>(`/api/skin/products?asOfDayKey=${asOfDayKey}`);
}

export type RoutineView = {
  readonly routine: Routine;
  readonly steps: readonly RoutineStep[];
  readonly adherence: RoutineWindowAdherence;
  readonly today: Readonly<Record<string, 'done' | 'skipped' | 'partial'>>;
};

export async function fetchRoutines(
  toDayKey: string,
  options: { readonly kind?: string; readonly windowDays?: number } = {},
): Promise<readonly RoutineView[]> {
  const params = new URLSearchParams({ toDayKey });
  if (options.kind !== undefined) params.set('kind', options.kind);
  if (options.windowDays !== undefined) params.set('windowDays', String(options.windowDays));
  const body = await getJson<{ routines: readonly RoutineView[] }>(`/api/routines?${params.toString()}`);
  return body.routines;
}

/* -------------------------------------------------------------------------
 * Writes
 * ---------------------------------------------------------------------- */

export type SkinRegionInput = {
  readonly id: string;
  readonly region: string;
  readonly state?: number | null;
  readonly activeLesionCount?: number | null;
};

export async function logSkinDay(input: {
  readonly id: string;
  readonly observedOn: string;
  readonly observedAt: string;
  readonly zone: string;
  readonly overallState?: number | null;
  readonly note?: string | null;
  readonly isFlare?: boolean;
  readonly suspectedTrigger?: string | null;
  readonly regions: readonly SkinRegionInput[];
}): Promise<void> {
  await queueAndDrain({
    id: newIdempotencyKey(),
    endpoint: '/api/skin/state',
    method: 'POST',
    body: {
      id: input.id,
      observedOn: input.observedOn,
      observedAt: input.observedAt,
      zone: input.zone,
      ...(input.overallState === undefined || input.overallState === null
        ? {}
        : { overallState: input.overallState }),
      ...(input.note === undefined || input.note === null ? {} : { note: input.note }),
      ...(input.isFlare === undefined ? {} : { isFlare: input.isFlare }),
      ...(input.suspectedTrigger === undefined || input.suspectedTrigger === null
        ? {}
        : { suspectedTrigger: input.suspectedTrigger }),
      regions: input.regions.map((region) => ({
        id: region.id,
        region: region.region,
        ...(region.state === undefined || region.state === null ? {} : { state: region.state }),
        ...(region.activeLesionCount === undefined || region.activeLesionCount === null
          ? {}
          : { activeLesionCount: region.activeLesionCount }),
      })),
      ...offlineEnvelope(),
    },
    label: `Skin · ${input.observedOn}`,
  });
}

export async function logRoutineStep(input: {
  readonly id: string;
  readonly routineId: string;
  readonly stepId: string;
  readonly occurredOn: string;
  readonly completedAt: string | null;
  readonly zone: string;
  readonly status: 'done' | 'skipped' | 'partial';
}): Promise<void> {
  await queueAndDrain({
    id: newIdempotencyKey(),
    endpoint: '/api/routines',
    method: 'POST',
    body: { ...input, ...offlineEnvelope() },
    label: `Routine · ${input.occurredOn}`,
  });
}

export async function clearRoutineStep(input: {
  readonly routineId: string;
  readonly stepId: string;
  readonly occurredOn: string;
}): Promise<void> {
  await queueAndDrain({
    id: newIdempotencyKey(),
    endpoint: '/api/routines',
    method: 'DELETE',
    body: { ...input, ...offlineEnvelope() },
    label: `Routine cleared · ${input.occurredOn}`,
  });
}
