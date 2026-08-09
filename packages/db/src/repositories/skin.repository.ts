/**
 * Skin, persisted — the daily log, the regions, and the product register.
 *
 * ## The day is the key, not the row id
 *
 * `skin_state` carries a unique index on `observed_on`, so a day has one row
 * for its whole life. That makes the write here an **upsert on the day**, and
 * it makes {@link SkinRepository.stateForDay} the first call any write path
 * makes: the caller needs the existing row id and the existing region row ids
 * so that re-logging a day *edits* it rather than orphaning three region rows
 * and leaving two contradictory readings current.
 *
 * The observations follow the same rule from the other direction. `core`'s
 * `planSkinState` takes the day's current observations and emits `supersedes`
 * for each — because §9.1's log is append-only, and correcting a 2 to a 4 by
 * appending would leave `mean` reporting 3.
 *
 * ## Products are events
 *
 * There is deliberately no `setActive` here. §4.2's payoff question needs the
 * *events*, and `core/domain/skin/product.ts` replays them. The `is_active`
 * column is a cache for the hot path, refreshed from the replay rather than
 * written directly.
 */

import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import type { Result } from '@naitikos/shared';
import { err, ok } from '@naitikos/shared';
import type {
  BodyRegion,
  DomainError,
  ExistingSkinObservation,
  Observation,
  PlannedSkinState,
  ProductEvent,
  ProductEventKind,
  ProductSeverity,
  SkinRegionState,
  SkinState,
  SkincareProduct,
} from '@naitikos/core';
import { SKIN_METRICS, conflictError, isActiveOn, isDomainError, prepareObservations } from '@naitikos/core';

import type { Database } from '../client';
import { productEvent, skinRegionState, skinState, skincareProduct } from '../schema/body';
import { observation } from '../schema/substrate';
import { createObservationRepository } from './observation.repository';
import type { WriteContext } from './workout.repository';

class TransactionAbort extends Error {
  readonly domainError: DomainError;

  constructor(domainError: DomainError) {
    super(domainError.message);
    this.name = 'TransactionAbort';
    this.domainError = domainError;
  }
}

function fromAbort(error: unknown): DomainError | null {
  if (error instanceof TransactionAbort) return error.domainError;
  return isDomainError(error) ? error : null;
}

/* -------------------------------------------------------------------------
 * Row mapping
 * ---------------------------------------------------------------------- */

function toRegion(row: typeof skinRegionState.$inferSelect): SkinRegionState {
  return {
    id: row.id,
    region: row.region as BodyRegion,
    state: row.state,
    activeLesionCount: row.activeLesionCount,
    scarringLevel: row.scarringLevel,
    inflammation: row.inflammation,
    dryness: row.dryness,
    oiliness: row.oiliness,
    note: row.note,
  };
}

function toState(row: typeof skinState.$inferSelect, regions: readonly SkinRegionState[]): SkinState {
  return {
    id: row.id,
    observedOn: row.observedOn,
    zone: row.zone,
    overallState: row.overallState,
    note: row.note,
    isFlare: row.isFlare,
    suspectedTrigger: row.suspectedTrigger,
    regions,
  };
}

function toProduct(row: typeof skincareProduct.$inferSelect): SkincareProduct {
  return {
    id: row.id,
    name: row.name,
    brand: row.brand,
    category: row.category,
    keyIngredients: Array.isArray(row.keyIngredients)
      ? row.keyIngredients.filter((item): item is string => typeof item === 'string')
      : [],
    isActive: row.isActive,
    notes: row.notes,
  };
}

function toProductEvent(row: typeof productEvent.$inferSelect): ProductEvent {
  return {
    id: row.id,
    productId: row.productId,
    kind: row.kind as ProductEventKind,
    occurredAt: row.occurredAt,
    zone: row.zone,
    reactionDescription: row.reactionDescription,
    reactionSeverity: row.reactionSeverity as ProductSeverity | null,
    note: row.note,
  };
}

/* -------------------------------------------------------------------------
 * The repository
 * ---------------------------------------------------------------------- */

export type SkinStateWritten = {
  readonly state: SkinState;
  readonly hlc: string | null;
};

export type SkinRepository = {
  /** The day's row with its regions, or null. Call this before writing. */
  stateForDay(dayKey: string): Promise<Result<SkinState | null, DomainError>>;
  /** The observations currently on record for a day, for supersession. */
  observationsForDay(dayKey: string): Promise<Result<readonly ExistingSkinObservation[], DomainError>>;
  statesBetween(fromDayKey: string, toDayKey: string): Promise<Result<readonly SkinState[], DomainError>>;
  recentStates(limit?: number): Promise<Result<readonly SkinState[], DomainError>>;

  writeState(planned: PlannedSkinState, context: WriteContext): Promise<Result<SkinStateWritten, DomainError>>;

  products(): Promise<Result<readonly SkincareProduct[], DomainError>>;
  productEvents(): Promise<Result<readonly ProductEvent[], DomainError>>;
  /** Recompute the `is_active` cache from the event replay (§9.3(4)). */
  refreshActiveProducts(dayKey: string, zone: string): Promise<Result<number, DomainError>>;
};

export function createSkinRepository(db: Database): SkinRepository {
  async function loadStates(rows: readonly (typeof skinState.$inferSelect)[]): Promise<readonly SkinState[]> {
    if (rows.length === 0) return [];
    const regions = await db
      .select()
      .from(skinRegionState)
      .where(
        and(
          inArray(
            skinRegionState.skinStateId,
            rows.map((row) => row.id),
          ),
          isNull(skinRegionState.deletedAt),
        ),
      );

    const byState = new Map<string, SkinRegionState[]>();
    for (const region of regions) {
      const existing = byState.get(region.skinStateId);
      if (existing === undefined) byState.set(region.skinStateId, [toRegion(region)]);
      else existing.push(toRegion(region));
    }

    return rows.map((row) => toState(row, byState.get(row.id) ?? []));
  }

  return {
    async stateForDay(dayKey) {
      const rows = await db
        .select()
        .from(skinState)
        .where(and(eq(skinState.observedOn, dayKey), isNull(skinState.deletedAt)))
        .limit(1);
      const states = await loadStates(rows);
      return ok(states[0] ?? null);
    },

    async observationsForDay(dayKey) {
      /*
       * Joined through the day's own rows rather than filtered on
       * `observed_at`, because the day boundary is a zoned question (§5.3) and
       * the subject reference already answers it exactly.
       */
      const state = await db
        .select({ id: skinState.id })
        .from(skinState)
        .where(and(eq(skinState.observedOn, dayKey), isNull(skinState.deletedAt)))
        .limit(1);

      const stateId = state[0]?.id;
      if (stateId === undefined) return ok([]);

      const regions = await db
        .select({ id: skinRegionState.id })
        .from(skinRegionState)
        .where(and(eq(skinRegionState.skinStateId, stateId), isNull(skinRegionState.deletedAt)));

      const subjectIds = [stateId, ...regions.map((row) => row.id)];

      const rows = await db
        .select({
          id: observation.id,
          metricKey: observation.metricKey,
          subjectId: observation.subjectId,
        })
        .from(observation)
        .where(
          and(
            inArray(observation.subjectId, subjectIds),
            inArray(observation.metricKey, [
              SKIN_METRICS.state,
              SKIN_METRICS.regionState,
              SKIN_METRICS.lesionCount,
            ]),
            isNull(observation.supersededById),
          ),
        );

      return ok(rows.map((row) => ({ id: row.id, metricKey: row.metricKey, subjectId: row.subjectId })));
    },

    async statesBetween(fromDayKey, toDayKey) {
      const rows = await db
        .select()
        .from(skinState)
        .where(
          and(gte(skinState.observedOn, fromDayKey), lte(skinState.observedOn, toDayKey), isNull(skinState.deletedAt)),
        )
        .orderBy(asc(skinState.observedOn));
      return ok(await loadStates(rows));
    },

    async recentStates(limit = 30) {
      const rows = await db
        .select()
        .from(skinState)
        .where(isNull(skinState.deletedAt))
        .orderBy(desc(skinState.observedOn))
        .limit(limit);
      return ok(await loadStates(rows));
    },

    async writeState(planned, context) {
      const observations = createObservationRepository(db);
      const sourceId = await observations.manualSourceId();
      if (!sourceId.ok) return sourceId;

      const prepared = prepareObservations(planned.observations, context.hlcState, {
        registry: context.registry,
        sourceId: sourceId.value as Observation['sourceId'],
        newId: context.newId,
        recordedAt: context.recordedAt,
        physicalMillis: context.physicalMillis,
      });
      if (!prepared.ok) return err(prepared.error);

      try {
        return await db.transaction(async (tx) => {
          /*
           * `DO UPDATE` on the day, unlike the gym writes.
           *
           * A skin log is a judgement the operator revises — they log in the
           * morning and count lesions properly that evening. `DO NOTHING`
           * would discard the second, more careful reading.
           */
          await tx
            .insert(skinState)
            .values({
              id: planned.state.id,
              observedOn: planned.state.observedOn,
              zone: planned.state.zone,
              overallState: planned.state.overallState,
              note: planned.state.note,
              isFlare: planned.state.isFlare,
              suspectedTrigger: planned.state.suspectedTrigger,
            })
            .onConflictDoUpdate({
              target: skinState.observedOn,
              set: {
                overallState: planned.state.overallState,
                note: planned.state.note,
                isFlare: planned.state.isFlare,
                suspectedTrigger: planned.state.suspectedTrigger,
                updatedAt: sql`now()`,
                version: sql`${skinState.version} + 1`,
              },
            });

          const dayRows = await tx
            .select()
            .from(skinState)
            .where(eq(skinState.observedOn, planned.state.observedOn))
            .limit(1);
          const dayRow = dayRows[0];
          if (dayRow === undefined) {
            throw new TransactionAbort(
              conflictError('skin_state', 'invalid_state', {
                code: 'skin_state_not_written',
                message: 'The skin log could not be recorded.',
              }),
            );
          }

          for (const region of planned.state.regions) {
            await tx
              .insert(skinRegionState)
              .values({
                id: region.id,
                skinStateId: dayRow.id,
                region: region.region,
                state: region.state,
                activeLesionCount: region.activeLesionCount,
                scarringLevel: region.scarringLevel,
                inflammation: region.inflammation,
                dryness: region.dryness,
                oiliness: region.oiliness,
                note: region.note,
              })
              .onConflictDoUpdate({
                target: [skinRegionState.skinStateId, skinRegionState.region],
                set: {
                  state: region.state,
                  activeLesionCount: region.activeLesionCount,
                  scarringLevel: region.scarringLevel,
                  inflammation: region.inflammation,
                  dryness: region.dryness,
                  oiliness: region.oiliness,
                  note: region.note,
                  updatedAt: sql`now()`,
                  version: sql`${skinRegionState.version} + 1`,
                },
              });
          }

          if (prepared.value.observations.length > 0) {
            const appended = await createObservationRepository(tx).append(
              prepared.value.observations,
              prepared.value.supersessions,
            );
            if (!appended.ok) throw new TransactionAbort(appended.error);
          }

          const regionRows = await tx
            .select()
            .from(skinRegionState)
            .where(and(eq(skinRegionState.skinStateId, dayRow.id), isNull(skinRegionState.deletedAt)));

          return ok({
            state: toState(dayRow, regionRows.map(toRegion)),
            hlc: prepared.value.observations.at(-1)?.hlc ?? null,
          });
        });
      } catch (error) {
        const domainError = fromAbort(error);
        if (domainError === null) throw error;
        return err(domainError);
      }
    },

    async products() {
      const rows = await db
        .select()
        .from(skincareProduct)
        .where(isNull(skincareProduct.deletedAt))
        .orderBy(desc(skincareProduct.isActive), asc(skincareProduct.name));
      return ok(rows.map(toProduct));
    },

    async productEvents() {
      const rows = await db
        .select()
        .from(productEvent)
        .where(isNull(productEvent.deletedAt))
        .orderBy(asc(productEvent.occurredAt));
      return ok(rows.map(toProductEvent));
    },

    async refreshActiveProducts(dayKey, zone) {
      const [products, events] = await Promise.all([
        db.select().from(skincareProduct).where(isNull(skincareProduct.deletedAt)),
        db.select().from(productEvent).where(isNull(productEvent.deletedAt)),
      ]);

      const mapped = events.map(toProductEvent);
      let changed = 0;

      for (const row of products) {
        const active = isActiveOn(mapped, row.id, dayKey, zone);
        if (active === row.isActive) continue;
        await db
          .update(skincareProduct)
          .set({ isActive: active, updatedAt: sql`now()`, version: sql`${skincareProduct.version} + 1` })
          .where(eq(skincareProduct.id, row.id));
        changed += 1;
      }

      return ok(changed);
    },
  };
}
