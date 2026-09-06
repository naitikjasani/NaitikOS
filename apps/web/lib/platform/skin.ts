/**
 * The Skin service — §4.2's orchestration, plus the shared routine engine.
 *
 * ## The read-before-write that makes a day editable
 *
 * `skin_state` has one row per day for its whole life, and its observations are
 * append-only. Both facts mean a write cannot be planned from the request
 * alone: {@link logSkinDay} reads the day first, so `planSkinState` can reuse
 * the existing row ids (or the day would sprout orphaned region rows) and emit
 * `supersedes` for the observations already there (or `mean` aggregation would
 * report the average of the mistake and the correction).
 *
 * The client sends ids anyway — §5.7 wants a record to have its identity from
 * the moment it exists offline — and they are used when the day is new. When it
 * is not, the stored ids win. That asymmetry is deliberate: the offline device
 * cannot know which of its days the server has already seen.
 */

import 'server-only';

import type { Result } from '@naitikos/shared';
import { err, ok } from '@naitikos/shared';
import type {
  BodyRegion,
  DomainError,
  Hlc,
  MetricRegistry,
  ProductChange,
  ProductEvent,
  Reaction,
  RegionTrend,
  Routine,
  RoutineStep,
  RoutineWindowAdherence,
  SkinState,
  SkincareProduct,
  SkinStateInput,
} from '@naitikos/core';
import {
  REGION_LABELS,
  TRACKED_REGIONS,
  changesBefore,
  comparablePhotos,
  dayKeyInZone,
  daysSinceIntroduction,
  hlcReceive,
  isBodyRegion,
  initialHlcState,
  isoFromMillis,
  notFoundError,
  planSkinState,
  reactionHistory,
  regionTrends,
  routineWindowAdherence,
  seriesKey,
  shiftDayKey,
  systemClock,
  windowDayKeys,
} from '@naitikos/core';
import type { Database, ProtocolPhoto } from '@naitikos/db';
import {
  createMetricRepository,
  createRoutineRepository,
  createSkinRepository,
} from '@naitikos/db';

import type { OfflineEnvelope } from './capture';

function writeContext(registry: MetricRegistry, envelope: OfflineEnvelope, newId: () => string) {
  const physicalMillis = systemClock.nowMillis();
  const seed = initialHlcState(envelope.deviceId, physicalMillis);
  const state =
    envelope.clientHlc === undefined
      ? seed
      : hlcReceive(seed, envelope.clientHlc as Hlc, physicalMillis).state;

  return {
    registry,
    hlcState: state,
    recordedAt: isoFromMillis(physicalMillis),
    physicalMillis,
    newId,
  };
}

/* -------------------------------------------------------------------------
 * The daily log
 * ---------------------------------------------------------------------- */

export async function logSkinDay(
  db: Database,
  envelope: OfflineEnvelope,
  input: SkinStateInput,
  newId: () => string,
): Promise<Result<SkinState, DomainError>> {
  const skin = createSkinRepository(db);

  const [existingDay, existingObservations, registry] = await Promise.all([
    skin.stateForDay(input.observedOn),
    skin.observationsForDay(input.observedOn),
    createMetricRepository(db).registry(),
  ]);
  if (!existingDay.ok) return err(existingDay.error);
  if (!existingObservations.ok) return err(existingObservations.error);
  if (!registry.ok) return err(registry.error);

  const stored = existingDay.value;

  /*
   * Reuse the stored ids where the day already exists. See the file header.
   */
  const resolved: SkinStateInput = {
    ...input,
    id: stored?.id ?? input.id,
    regions: (input.regions ?? []).map((region) => {
      const priorId = stored?.regions.find((candidate) => candidate.region === region.region)?.id;
      return priorId === undefined ? region : { ...region, id: priorId };
    }),
    existing: existingObservations.value,
  };

  const planned = planSkinState(resolved);
  if (!planned.ok) return planned;

  const written = await skin.writeState(planned.value, writeContext(registry.value, envelope, newId));
  return written.ok ? ok(written.value.state) : err(written.error);
}

export type SkinOverview = {
  readonly fromDayKey: string;
  readonly toDayKey: string;
  readonly states: readonly SkinState[];
  readonly regions: ReturnType<typeof regionTrends>;
  /** Flare days in the window, with what changed in the fortnight before each. */
  readonly flares: readonly {
    readonly dayKey: string;
    readonly suspectedTrigger: string | null;
    readonly changes: readonly ProductChange[];
  }[];
};

export async function loadSkinOverview(
  db: Database,
  options: { readonly fromDayKey: string; readonly toDayKey: string; readonly zone: string },
): Promise<Result<SkinOverview, DomainError>> {
  const skin = createSkinRepository(db);
  const [states, events] = await Promise.all([
    skin.statesBetween(options.fromDayKey, options.toDayKey),
    skin.productEvents(),
  ]);
  if (!states.ok) return err(states.error);
  if (!events.ok) return err(events.error);

  /*
   * A flare carries what *changed* before it, and nothing resembling a cause.
   * `changesBefore` returns a list with a `daysBefore` and no score — §4.2's
   * payoff question answered by putting the facts next to each other and
   * letting the operator, who has a memory, do the reasoning.
   */
  const flares = states.value
    .filter((state) => state.isFlare)
    .map((state) => ({
      dayKey: state.observedOn,
      suspectedTrigger: state.suspectedTrigger,
      changes: changesBefore(events.value, state.observedOn, options.zone),
    }));

  return ok({
    fromDayKey: options.fromDayKey,
    toDayKey: options.toDayKey,
    states: states.value,
    regions: regionTrends(states.value),
    flares,
  });
}

/* -------------------------------------------------------------------------
 * Per-region history
 * ---------------------------------------------------------------------- */

/**
 * How far back the regions view reaches.
 *
 * Ninety days. The overview's window answers "how is it now"; this one answers
 * "is one region moving while another is not", and that question needs long
 * enough for a treatment course or a seasonal change to show. Shorter and every
 * region looks flat; longer and a resolved flare from last spring drags the mean
 * of a region that has been clear for months.
 */
export const REGION_WINDOW_DAYS = 90;

export type RegionSeriesPoint = {
  readonly dayKey: string;
  /** `null` for a day with no record. Never zero — §8.9. */
  readonly state: number | null;
  readonly lesionCount: number | null;
};

export type RegionHistory = {
  readonly region: BodyRegion;
  readonly label: string;
  readonly trend: RegionTrend | null;
  /** One entry per day in the window, oldest first. */
  readonly series: readonly RegionSeriesPoint[];
};

export type SkinRegionsView = {
  readonly fromDayKey: string;
  readonly toDayKey: string;
  readonly windowDays: number;
  /** One per tracked region, in §4.2's order, whether or not it has data. */
  readonly regions: readonly RegionHistory[];
  /** Days in the window with any skin record at all, for the coverage line. */
  readonly recordedDays: number;
};

/**
 * Each tracked region as its own series.
 *
 * The reason this is not the overview: `regionTrends` collapses a region to one
 * mean, and the question this page exists for — *is my face clearing while my
 * back is not* — is invisible in a mean. Two regions with the same ninety-day
 * average can be moving in opposite directions.
 *
 * Every tracked region appears whether or not it has been recorded. §4.2 fixes
 * the list at face, chest and back, and a region silently absent because it was
 * never logged would read as a region with nothing wrong.
 */
export async function loadSkinRegions(
  db: Database,
  options: { readonly toDayKey: string },
): Promise<Result<SkinRegionsView, DomainError>> {
  const fromDayKey = shiftDayKey(options.toDayKey, -(REGION_WINDOW_DAYS - 1)) ?? options.toDayKey;

  const states = await createSkinRepository(db).statesBetween(fromDayKey, options.toDayKey);
  if (!states.ok) return err(states.error);

  const dayKeys = windowDayKeys(options.toDayKey, REGION_WINDOW_DAYS);
  const trends = new Map(regionTrends(states.value).map((trend) => [trend.region, trend]));

  /* Region readings indexed by day, so the series is one pass rather than a
   * scan of every state per day. */
  const byRegionAndDay = new Map<string, { state: number | null; lesionCount: number | null }>();
  for (const state of states.value) {
    for (const region of state.regions) {
      byRegionAndDay.set(`${region.region}:${state.observedOn}`, {
        state: region.state,
        lesionCount: region.activeLesionCount,
      });
    }
  }

  const recordedDays = new Set(states.value.map((state) => state.observedOn)).size;

  return ok({
    fromDayKey,
    toDayKey: options.toDayKey,
    windowDays: REGION_WINDOW_DAYS,
    recordedDays,
    regions: TRACKED_REGIONS.map((region) => ({
      region,
      label: REGION_LABELS[region],
      trend: trends.get(region) ?? null,
      series: dayKeys.map((dayKey) => {
        const found = byRegionAndDay.get(`${region}:${dayKey}`);
        return {
          dayKey,
          /* A day with no record contributes `null`, never a zero. The grid
           * renders the two differently, and a day the operator did not log is
           * not a day their skin was clear. */
          state: found?.state ?? null,
          lesionCount: found?.lesionCount ?? null,
        };
      }),
    })),
  });
}

/* -------------------------------------------------------------------------
 * Products
 * ---------------------------------------------------------------------- */

export type ProductView = {
  readonly product: SkincareProduct;
  /** Days since the current period of use began, or null when not in use. */
  readonly daysInUse: number | null;
};

export type ProductRegister = {
  readonly products: readonly ProductView[];
  readonly reactions: readonly Reaction[];
  readonly events: readonly ProductEvent[];
};

export async function loadProducts(
  db: Database,
  options: { readonly asOfDayKey: string; readonly zone: string },
): Promise<Result<ProductRegister, DomainError>> {
  const skin = createSkinRepository(db);
  const [products, events] = await Promise.all([skin.products(), skin.productEvents()]);
  if (!products.ok) return err(products.error);
  if (!events.ok) return err(events.error);

  return ok({
    products: products.value.map((product) => ({
      product,
      daysInUse: daysSinceIntroduction(events.value, product.id, options.asOfDayKey, options.zone),
    })),
    reactions: reactionHistory(events.value, options.zone),
    events: events.value,
  });
}

/* -------------------------------------------------------------------------
 * The routine engine (§9.2) — skincare today, dental and supplements later
 * ---------------------------------------------------------------------- */

export type RoutineView = {
  readonly routine: Routine;
  readonly steps: readonly RoutineStep[];
  readonly adherence: RoutineWindowAdherence;
  /** Today's log, keyed by step id, so the screen can render tick state. */
  readonly today: Readonly<Record<string, 'done' | 'skipped' | 'partial'>>;
};

export async function loadRoutines(
  db: Database,
  options: {
    readonly toDayKey: string;
    readonly windowDays?: number;
    readonly kind?: 'skincare' | 'dental' | 'supplement' | 'other';
  },
): Promise<Result<readonly RoutineView[], DomainError>> {
  const windowDays = options.windowDays ?? 30;
  const dayKeys = windowDayKeys(options.toDayKey, windowDays);
  const first = dayKeys[0];
  if (first === undefined) return err(notFoundError('day', options.toDayKey, 'invalid_day'));

  const routines = createRoutineRepository(db);
  const active = await routines.activeRoutines(options.kind);
  if (!active.ok) return err(active.error);
  if (active.value.length === 0) return ok([]);

  const ids = active.value.map((routine) => routine.id);
  const [steps, logs] = await Promise.all([
    routines.stepsFor(ids),
    routines.logsBetween(ids, first, options.toDayKey),
  ]);
  if (!steps.ok) return err(steps.error);
  if (!logs.ok) return err(logs.error);

  return ok(
    active.value.map((routine) => {
      const own = steps.value.filter((step) => step.routineId === routine.id);
      const today: Record<string, 'done' | 'skipped' | 'partial'> = {};
      for (const log of logs.value) {
        if (log.routineId !== routine.id || log.occurredOn !== options.toDayKey) continue;
        if (log.stepId === null) continue;
        today[log.stepId] = log.status;
      }

      return {
        routine,
        steps: own,
        adherence: routineWindowAdherence(routine, own, logs.value, dayKeys),
        today,
      };
    }),
  );
}

export async function logRoutineStep(
  db: Database,
  input: Parameters<ReturnType<typeof createRoutineRepository>['logStep']>[0],
): Promise<Result<{ readonly status: string }, DomainError>> {
  const logged = await createRoutineRepository(db).logStep(input);
  return logged.ok ? ok({ status: logged.value.status }) : err(logged.error);
}

export async function clearRoutineStep(
  db: Database,
  routineId: string,
  stepId: string,
  dayKey: string,
): Promise<Result<{ readonly cleared: boolean }, DomainError>> {
  const cleared = await createRoutineRepository(db).clearStep(routineId, stepId, dayKey);
  return cleared.ok ? ok({ cleared: cleared.value }) : err(cleared.error);
}

/* -------------------------------------------------------------------------
 * Photo comparison (§3.2 `/body/skin/photos/compare`, §4.2, §9.8)
 * ---------------------------------------------------------------------- */

/**
 * A stored photo with the civil day it belongs to.
 *
 * The day is resolved here rather than in the browser, and in the photo's *own*
 * capture zone rather than the profile's. §5.3's failure mode is a photo taken
 * at 23:40 in Mumbai being filed under the following day because a runtime in
 * UTC re-derived it — which in a comparison view would silently reorder two
 * photos taken hours apart.
 */
export type ComparisonPhoto = ProtocolPhoto & {
  readonly dayKey: string;
};

/**
 * One region-plus-pose series, split by what §9.8 lets a comparison show.
 *
 * The split is the point. A single list with a flag on some entries invites a
 * renderer to forget the flag; two lists make the flagged photos something the
 * screen has to *ask* for.
 */
export type PhotoSeries = {
  readonly key: string;
  readonly region: BodyRegion;
  readonly regionLabel: string;
  readonly poseId: string | null;
  /** Compliant at capture, oldest first. What the view offers by default. */
  readonly eligible: readonly ComparisonPhoto[];
  /** Flagged at capture. Behind the toggle, and marked wherever it appears. */
  readonly flagged: readonly ComparisonPhoto[];
};

export type PhotoComparisonView = {
  /** In §4.2's region order, then by pose. Empty series are not carried. */
  readonly series: readonly PhotoSeries[];
  /** Photos with no capture time, which cannot be placed in a series. */
  readonly undatedCount: number;
  /**
   * How many of the photos are sensitive-tier ciphertext.
   *
   * Surfaced because it decides what the screen can honestly render. §5.5: the
   * storage provider "holds ciphertext it cannot read", and neither does this
   * server — decryption needs the passphrase-derived master key, which lives in
   * the browser's memory and is never transmitted.
   */
  readonly encryptedCount: number;
};

/**
 * Everything `/body/skin/photos/compare` is allowed to know.
 *
 * ## What this deliberately does not return
 *
 * No similarity figure, no change score, no luminance delta, no perceptual-hash
 * distance. Not because they are hard — the hash is already on the row — but
 * because §4.2 says the quiet part out loud: apparent change between two
 * photographs "is dominated by capture variance rather than skin change". A
 * number derived from two images would therefore be *mostly a measurement of
 * the light*, presented with the authority of arithmetic.
 *
 * §10.0 forbids the model computing or asserting. A deterministic figure would
 * evade the letter of that rule and break its purpose: the constraint exists so
 * that every number the operator reads is one the system can stand behind, and
 * "these two photos are 12% different" is not.
 *
 * What it returns instead is what was *recorded at capture*: the protocol block
 * of each photo, and the compliance score the capture screen computed against
 * that series' own baseline. Those are retrieved facts, not new claims.
 */
export async function loadPhotoComparison(
  db: Database,
  options: { readonly zone: string },
): Promise<Result<PhotoComparisonView, DomainError>> {
  const read = await createSkinRepository(db).protocolPhotos(TRACKED_REGIONS);
  if (!read.ok) return err(read.error);

  const dated: ComparisonPhoto[] = read.value.photos.map((photo) => ({
    ...photo,
    dayKey: dayKeyInZone(photo.capturedAt, photo.capturedZone ?? options.zone),
  }));

  /* Grouped by region *and* pose. `seriesKey` is the authority on that pairing
   * because it is the same function the capture screen picks its alignment
   * reference with — a face-front and a face-left photo are not two views of
   * one series, they are two series. */
  const grouped = new Map<string, ComparisonPhoto[]>();
  for (const photo of dated) {
    const key = seriesKey(photo.region, photo.poseId);
    const existing = grouped.get(key);
    if (existing === undefined) grouped.set(key, [photo]);
    else existing.push(photo);
  }

  const series: PhotoSeries[] = [];
  for (const [key, photos] of grouped) {
    const first = photos[0];
    if (first === undefined || !isBodyRegion(first.region)) continue;

    /*
     * The eligibility decision is `core`'s, not this loader's. Only the ids
     * come back, because `comparablePhotos` returns `SeriesPhoto` and would
     * drop the encryption and zone fields the screen needs — so the ids
     * partition the richer list rather than replacing it.
     */
    const eligibleIds = new Set(
      comparablePhotos(photos, first.region, first.poseId).map((photo) => photo.mediaObjectId),
    );

    const ordered = [...photos].sort((a, b) => (a.capturedAt < b.capturedAt ? -1 : a.capturedAt > b.capturedAt ? 1 : 0));

    series.push({
      key,
      region: first.region,
      regionLabel: REGION_LABELS[first.region],
      poseId: first.poseId,
      eligible: ordered.filter((photo) => eligibleIds.has(photo.mediaObjectId)),
      flagged: ordered.filter((photo) => !eligibleIds.has(photo.mediaObjectId)),
    });
  }

  series.sort((a, b) => {
    const byRegion = TRACKED_REGIONS.indexOf(a.region) - TRACKED_REGIONS.indexOf(b.region);
    return byRegion === 0 ? a.key.localeCompare(b.key) : byRegion;
  });

  return ok({
    series,
    undatedCount: read.value.undatedCount,
    encryptedCount: dated.filter((photo) => photo.isEncrypted).length,
  });
}
