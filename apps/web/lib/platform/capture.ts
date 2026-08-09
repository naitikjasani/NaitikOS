/**
 * The capture service — the orchestration behind every write of an observation.
 *
 * §5.2: "route handlers are transport, not logic. A handler parses,
 * authenticates, delegates to a domain service, and serialises." This is the
 * service the capture handlers delegate to; it is the only place that knows how
 * `core`'s pure planning functions and `db`'s repositories fit together.
 *
 * ## How the server picks a hybrid logical clock
 *
 * The HLC needs a node's clock state, and the server has nowhere to keep one:
 * §5.15 deploys to serverless, so there is no long-lived process, and
 * `sync_state` has no column for it.
 *
 * The resolution is to **use the writing device as the HLC node**, and rebuild
 * its state per request from two inputs it already sends: the client's last
 * HLC, and the server's physical clock. `hlcReceive` merges them, which is the
 * published algorithm's own operation for exactly this — a node learning a
 * peer's time. Three properties follow, and all three are needed:
 *
 * 1. **Monotone per device.** The merged value is `> clientHlc`, so a device's
 *    writes stay in order across requests without the server remembering
 *    anything.
 * 2. **Globally distinct.** The node id is the device's, so two devices writing
 *    in the same millisecond produce different timestamps rather than
 *    colliding — which a server-owned node id would not.
 * 3. **Drift-bounded.** `hlcReceive` clamps a peer more than five minutes ahead
 *    (§5.8) instead of adopting it, so a phone with a wrong clock cannot drag
 *    the record into the future permanently.
 *
 * The cost is that a device losing its stored HLC restarts from the physical
 * clock. That is correct rather than merely tolerable: the new value is still
 * ahead of anything it wrote before, because those were also ahead of their own
 * physical time by at most the drift ceiling.
 */

import 'server-only';

import type { Result } from '@naitikos/shared';
import { err, ok, uuidV7 } from '@naitikos/shared';
import type {
  ClosePlan,
  CloseForm,
  CloseSubmission,
  DomainError,
  Hlc,
  MetricRegistry,
  Observation,
  ObservationInput,
} from '@naitikos/core';
import {
  buildCloseForm,
  hlcReceive,
  initialHlcState,
  isoFromMillis,
  planDailyClose,
  prepareObservations,
  systemClock,
} from '@naitikos/core';
import type { Database } from '@naitikos/db';
import {
  createDailyCloseRepository,
  createMetricRepository,
  createObservationRepository,
} from '@naitikos/db';

/** The offline envelope every mutation carries (§5.7). */
export type OfflineEnvelope = {
  readonly deviceId: string;
  readonly clientHlc?: string | undefined;
};

/** Rebuild the writing device's clock for this request. See the file header. */
function clockFor(envelope: OfflineEnvelope, physicalMillis: number) {
  const seed = initialHlcState(envelope.deviceId, physicalMillis);
  return envelope.clientHlc === undefined
    ? { state: seed, anomalies: [] as const }
    : hlcReceive(seed, envelope.clientHlc as Hlc, physicalMillis);
}

export type CaptureResult = {
  readonly written: number;
  readonly observations: readonly Observation[];
  /** The device should store this and send it as `clientHlc` next time. */
  readonly hlc: string | null;
  /** Non-empty when §5.8 wants something in diagnostics. */
  readonly anomalies: readonly string[];
};

/**
 * Write a batch of observations.
 *
 * Validation is `core`'s (`prepareObservations`), persistence is `db`'s, and
 * neither is repeated here — this function's only job is to hold the registry,
 * the provenance row and the clock together.
 */
export async function captureObservations(
  db: Database,
  inputs: readonly ObservationInput[],
  envelope: OfflineEnvelope,
): Promise<Result<CaptureResult, DomainError>> {
  const registry = await createMetricRepository(db).registry();
  if (!registry.ok) return registry;

  const observations = createObservationRepository(db);
  const sourceId = await observations.manualSourceId();
  if (!sourceId.ok) return sourceId;

  const physicalMillis = systemClock.nowMillis();
  const clock = clockFor(envelope, physicalMillis);

  const prepared = prepareObservations(inputs, clock.state, {
    registry: registry.value,
    sourceId: sourceId.value as Observation['sourceId'],
    newId: () => uuidV7(physicalMillis),
    recordedAt: isoFromMillis(physicalMillis),
    physicalMillis,
  });
  if (!prepared.ok) return err(prepared.error);

  const appended = await observations.append(prepared.value.observations, prepared.value.supersessions);
  if (!appended.ok) return appended;

  return ok({
    written: appended.value,
    observations: prepared.value.observations,
    hlc: prepared.value.observations.at(-1)?.hlc ?? null,
    anomalies: [...clock.anomalies, ...prepared.value.anomalies],
  });
}

export type CloseResult = {
  readonly plan: ClosePlan;
  /** The rows actually written, for the events the route publishes. */
  readonly committedObservations: readonly Observation[];
  /** How many fields the Close offered, for `DailyClose.Completed`'s count. */
  readonly fieldsAvailable: number;
  readonly hlc: string | null;
  readonly anomalies: readonly string[];
};

/**
 * Record a Daily Close.
 *
 * Read-then-plan-then-commit, and the read is inside the same call rather than
 * supplied by the caller: the plan's correctness depends on seeing the day's
 * *current* state, and a state fetched by a client three minutes ago would turn
 * an unchanged answer into a spurious correction.
 */
export async function recordDailyClose(
  db: Database,
  submission: CloseSubmission,
  envelope: OfflineEnvelope,
): Promise<Result<CloseResult, DomainError>> {
  const registry = await createMetricRepository(db).registry();
  if (!registry.ok) return registry;

  const closes = createDailyCloseRepository(db, registry.value);

  const existing = await closes.stateFor(submission.dayKey, submission.zone);
  if (!existing.ok) return existing;

  const physicalMillis = systemClock.nowMillis();
  const now = isoFromMillis(physicalMillis);

  const plan = planDailyClose(submission, existing.value, {
    registry: registry.value,
    now,
    newId: () => uuidV7(physicalMillis),
  });
  if (!plan.ok) return plan;

  const clock = clockFor(envelope, physicalMillis);

  const committed = await closes.commit(plan.value, {
    registry: registry.value,
    hlcState: clock.state,
    recordedAt: now,
    physicalMillis,
    newId: () => uuidV7(physicalMillis),
  });
  if (!committed.ok) return committed;

  return ok({
    plan: plan.value,
    committedObservations: committed.value.observations,
    // The registry's Close subset plus the note line — the same count
    // `buildCloseForm` produces, without rebuilding the form to get it.
    fieldsAvailable: registry.value.dailyClose().length + 1,
    hlc: committed.value.observations.at(-1)?.hlc ?? null,
    anomalies: [...clock.anomalies],
  });
}

/**
 * The Close form for a day, plus whatever is already recorded on it.
 *
 * One round trip rather than two. The form and the answers are useless apart —
 * a form with no current values renders every field empty on a re-close, which
 * is how an operator overwrites a morning's answers by accident.
 */
export type LoadedClose = {
  readonly form: CloseForm;
  /** What the day already holds, by metric key. Sparse — an unanswered field is absent. */
  readonly answers: Readonly<Record<string, { readonly value: string; readonly valueText: string | null }>>;
  readonly note: string | null;
  readonly isClosed: boolean;
  /** Passed back so the caller can decode values without a second registry read. */
  readonly registry: MetricRegistry;
};

export async function loadDailyClose(
  db: Database,
  dayKey: string,
  zone: string,
): Promise<Result<LoadedClose, DomainError>> {
  const registry = await createMetricRepository(db).registry();
  if (!registry.ok) return registry;

  const closes = createDailyCloseRepository(db, registry.value);
  const existing = await closes.stateFor(dayKey, zone);
  if (!existing.ok) return existing;

  /*
   * No medications yet.
   *
   * §4.0 asks for one toggle per *active* medication and §12 puts the register
   * itself in week four. The form generator already takes the list and the
   * budget arithmetic already counts it, so this becomes a repository read
   * rather than a redesign when the register lands. Passing `[]` today is the
   * honest state of the register, not a stub.
   */
  const form = buildCloseForm(registry.value, [], dayKey, zone);

  const answers: Record<string, { value: string; valueText: string | null }> = {};
  for (const observation of existing.value.observations) {
    answers[observation.metricKey] = { value: observation.value, valueText: observation.valueText };
  }

  return ok({
    form,
    answers,
    note: existing.value.note?.content ?? null,
    isClosed: existing.value.observations.some((o) => o.metricKey === 'system.daily_close.completed'),
    registry: registry.value,
  });
}
