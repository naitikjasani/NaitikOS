/**
 * The Daily Close, persisted.
 *
 * `core/close/plan.ts` decides *what* a submission means; this decides nothing
 * and writes what it is told, in one transaction. The split is deliberate and
 * it is what makes §4.0's rules testable without Postgres — every interesting
 * case (partial close, re-submission, unchanged answer, cleared note) is a
 * plan-level test, and this file's only job is atomicity.
 *
 * ## Why one transaction
 *
 * A Close writes up to seven observations, a supersession per revised answer,
 * a medication event per toggle, and a note. §5.7 lets the offline outbox
 * "replay any request any number of times", which is only safe if the request
 * is a single unit — a Close that committed its observations and then failed on
 * the note would, on replay, write the observations again as corrections of
 * themselves.
 */

import { and, desc, eq, gte, isNull, lt, sql } from 'drizzle-orm';
import type { Result } from '@naitikos/shared';
import { err, ok } from '@naitikos/shared';
import type {
  ClosePlan,
  DomainError,
  ExistingCloseState,
  HlcState,
  MetricRegistry,
  Observation,
} from '@naitikos/core';
import {
  CLOSE_COMPLETION_METRIC,
  addUtcDays,
  conflictError,
  dayKeyInZone,
  isDomainError,
  prepareObservations,
  utcDayKey,
  utcNoonOn,
  zonedDayBounds,
  zonedDayStart,
} from '@naitikos/core';

import type { Database } from '../client';
import { observation } from '../schema/substrate';
import { medicationEvent } from '../schema/medical';
import { note } from '../schema/crosscutting';
import { createObservationRepository } from './observation.repository';

export type DailyCloseRepository = {
  /** Everything the day already holds, for `planDailyClose`. */
  stateFor(dayKey: string, zone: string): Promise<Result<ExistingCloseState, DomainError>>;
  /** Execute a plan. Atomic; returns the observations actually written. */
  commit(plan: ClosePlan, context: CommitContext): Promise<Result<CommitResult, DomainError>>;
  /** Days closed in the trailing window — the North Star input (§1.5). */
  compoundingDays(fromDayKey: string, zone: string, days: number): Promise<Result<number, DomainError>>;
};

export type CommitContext = {
  readonly registry: MetricRegistry;
  readonly hlcState: HlcState;
  readonly recordedAt: string;
  readonly physicalMillis: number;
  readonly newId: () => string;
};

export type CommitResult = {
  readonly observations: readonly Observation[];
  readonly hlcState: HlcState;
  readonly medicationEventCount: number;
  readonly noteWritten: boolean;
};

/** The metrics a Close reads back. Includes the marker, which is not a form field. */
function closeMetricKeys(registry: MetricRegistry): readonly string[] {
  return [...registry.dailyClose().map((m) => m.key), CLOSE_COMPLETION_METRIC];
}

/**
 * Carries a `DomainError` out through a rolled-back transaction.
 *
 * Drizzle rolls a transaction back when its callback throws, and only when it
 * throws — returning an `Err` from inside would *commit* the partial write and
 * then report a failure, which is the worst of both. So a domain failure is
 * wrapped, thrown, and unwrapped by {@link fromTransactionAbort} outside.
 *
 * Written as a plain subclass with an explicit field assignment rather than a
 * constructor parameter property: `erasableSyntaxOnly` (§11.3) rejects
 * parameter properties because they are TypeScript syntax with a runtime
 * effect, which is exactly what type-stripping cannot handle.
 */
class TransactionAbort extends Error {
  readonly domainError: DomainError;

  constructor(domainError: DomainError) {
    super(domainError.message);
    this.name = 'TransactionAbort';
    this.domainError = domainError;
  }
}

/** The domain error a rollback was carrying, or `null` for a genuine bug. */
function fromTransactionAbort(error: unknown): DomainError | null {
  if (error instanceof TransactionAbort) return error.domainError;
  // A raw domain error can also arrive if a nested call threw one directly.
  return isDomainError(error) ? error : null;
}

/** `dayKey` shifted back by whole days, in the calendar sense. */
function dayKeyMinus(dayKey: string, days: number): string | null {
  const anchor = utcNoonOn(dayKey);
  // Anchored at UTC noon so the shift cannot slip a date at either end — the
  // same trick `timeline/grouping.ts` uses, and for the same reason.
  return anchor === null ? null : utcDayKey(addUtcDays(anchor, -days));
}

export function createDailyCloseRepository(db: Database, registry: MetricRegistry): DailyCloseRepository {
  const observations = createObservationRepository(db);

  return {
    async stateFor(dayKey, zone) {
      const bounds = zonedDayBounds(dayKey, zone);
      if (bounds === null) {
        return err(
          conflictError('daily_close', 'invalid_state', {
            code: 'close_day_unresolvable',
            message: 'Could not resolve that day in that time zone.',
          }),
        );
      }

      const dayObservations = await observations.forDay(dayKey, zone, closeMetricKeys(registry));
      if (!dayObservations.ok) return dayObservations;

      const completion = dayObservations.value.find((o) => o.metricKey === CLOSE_COMPLETION_METRIC) ?? null;

      /*
       * Medication events are found by `scheduled_for` inside the day's bounds.
       *
       * `taken_at` would be the intuitive column and it is wrong: a skipped
       * dose has no `taken_at` (the `medication_event_taken_paired` constraint
       * requires that), so filtering on it would make every skip invisible to
       * the next Close — which would then offer the toggle as unanswered and
       * write a duplicate.
       */
      const events = await db
        .select({
          id: medicationEvent.id,
          medicationId: medicationEvent.medicationId,
          kind: medicationEvent.kind,
        })
        .from(medicationEvent)
        .where(
          and(
            gte(medicationEvent.scheduledFor, bounds.start),
            lt(medicationEvent.scheduledFor, bounds.end),
          ),
        )
        .orderBy(desc(medicationEvent.scheduledFor));

      /*
       * The note hangs off the day's completion observation, so with no
       * completion there is no note to find. That is not a shortcut — it is the
       * anchor: one note per close, discoverable from the close, with no
       * separate "which note belongs to today?" query to get wrong.
       */
      let existingNote: ExistingCloseState['note'] = null;
      if (completion !== null) {
        const rows = await db
          .select({ id: note.id, content: note.content })
          .from(note)
          .where(
            and(
              eq(note.entityType, 'observation'),
              eq(note.entityId, completion.id),
              isNull(note.deletedAt),
            ),
          )
          .orderBy(desc(note.createdAt))
          .limit(1);
        existingNote = rows[0] ?? null;
      }

      return ok({
        observations: dayObservations.value.map((o) => ({
          id: o.id,
          metricKey: o.metricKey,
          value: o.value,
          valueText: o.valueText,
        })),
        medicationEvents: events.map((event) => ({
          id: event.id,
          medicationId: event.medicationId,
          kind: event.kind,
        })),
        note: existingNote,
      });
    },

    async commit(plan, context) {
      const sourceId = await observations.manualSourceId();
      if (!sourceId.ok) return sourceId;

      const prepared = prepareObservations(plan.observations, context.hlcState, {
        registry: context.registry,
        sourceId: sourceId.value as Observation['sourceId'],
        newId: context.newId,
        recordedAt: context.recordedAt,
        physicalMillis: context.physicalMillis,
      });
      if (!prepared.ok) return err(prepared.error);

      /*
       * `db.transaction` rather than a manual BEGIN/COMMIT, and every write
       * below goes through `tx` — including the nested repository, which is why
       * `createObservationRepository` takes an `Executor` rather than reading an
       * ambient one. A single stray `db` inside this block would silently
       * escape the transaction and commit on its own.
       */
      try {
        const outcome = await db.transaction(async (tx) => {
          const txObservations = createObservationRepository(tx);

          const appended = await txObservations.append(
            prepared.value.observations,
            prepared.value.supersessions,
          );
          if (!appended.ok) {
            /*
             * Thrown, not returned. Drizzle rolls a transaction back only when
             * the callback throws — returning an `Err` here would commit the
             * partial write *and* report a failure, which is the worst of both.
             */
            throw new TransactionAbort(appended.error);
          }

          for (const event of plan.medicationEvents) {
            if (event.replaces !== null) {
              /*
               * Marked, not deleted. §9.4: nothing is hard-deleted, and a
               * changed adherence answer is a state transition with a history —
               * "I marked it taken at 21:00 and corrected it at 23:00" is a
               * different fact from "I marked it skipped".
               *
               * `medication_event` has no `deleted_at` (it is not an entity),
               * so the replaced row is annotated in its note field, which is
               * the only place available. Recorded here because it is a
               * compromise: the right fix is a `superseded_by` column, and that
               * is a migration this milestone is not making.
               */
              await tx
                .update(medicationEvent)
                .set({ note: `Superseded by a later Daily Close on ${plan.dayKey}.` })
                .where(eq(medicationEvent.id, event.replaces));
            }

            await tx
              .insert(medicationEvent)
              .values({
                id: event.id,
                medicationId: event.medicationId,
                kind: event.kind,
                scheduledFor: plan.observedAt,
                takenAt: event.takenAt,
                zone: event.zone,
              })
              .onConflictDoNothing({ target: medicationEvent.id });
          }

          if (plan.noteRemovalId !== null) {
            await tx
              .update(note)
              .set({ deletedAt: context.recordedAt, deleteReason: 'Cleared in a later Daily Close.' })
              .where(and(eq(note.id, plan.noteRemovalId), isNull(note.deletedAt)));
          }

          if (plan.note !== null) {
            if (plan.note.isNew) {
              await tx
                .insert(note)
                .values({
                  id: plan.note.id,
                  entityType: plan.note.entityType,
                  entityId: plan.note.entityId,
                  content: plan.note.content,
                })
                .onConflictDoNothing({ target: note.id });
            } else {
              await tx
                .update(note)
                .set({
                  content: plan.note.content,
                  updatedAt: context.recordedAt,
                  // §9.4's optimistic-concurrency counter. Incremented in SQL
                  // rather than read-then-write, so two devices draining at
                  // once cannot both land on version 2.
                  version: sql`${note.version} + 1`,
                })
                .where(eq(note.id, plan.note.id));
            }
          }

          return {
            observations: prepared.value.observations,
            hlcState: prepared.value.hlcState,
            medicationEventCount: plan.medicationEvents.length,
            noteWritten: plan.note !== null,
          } satisfies CommitResult;
        });

        return ok(outcome);
      } catch (error: unknown) {
        const domainError = fromTransactionAbort(error);
        // A genuine bug is rethrown. §5.12: "Exceptions are reserved for genuine
        // bugs, not for expected outcomes" — swallowing a connection failure
        // into a Result would hide it behind a message about the Daily Close.
        if (domainError === null) throw error;
        return err(domainError);
      }
    },

    async compoundingDays(fromDayKey, zone, days) {
      const bounds = zonedDayBounds(fromDayKey, zone);
      if (bounds === null) {
        return err(
          conflictError('daily_close', 'invalid_state', {
            code: 'close_day_unresolvable',
            message: 'Could not resolve that day in that time zone.',
          }),
        );
      }

      /*
       * Counted as *distinct local days*, not as marker rows.
       *
       * §1.5 defines the North Star as "the count of days in the trailing 90 on
       * which a Daily Close was completed", and a day is a day however many
       * times it was closed. The plan already refuses to write a second marker,
       * so this is belt-and-braces — but the metric that decides whether the
       * whole product is working is not one to leave to a single mechanism.
       */
      const firstDayKey = dayKeyMinus(fromDayKey, days - 1);
      const windowStart = firstDayKey === null ? null : zonedDayStart(firstDayKey, zone);
      if (windowStart === null) {
        return err(
          conflictError('daily_close', 'invalid_state', {
            code: 'close_window_unresolvable',
            message: 'Could not resolve the trailing window in that time zone.',
          }),
        );
      }

      const rows = await db
        .select({ observedAt: observation.observedAt, zone: observation.observedZone })
        .from(observation)
        .where(
          and(
            eq(observation.metricKey, CLOSE_COMPLETION_METRIC),
            gte(observation.observedAt, windowStart),
            lt(observation.observedAt, bounds.end),
            isNull(observation.supersededById),
          ),
        );

      /*
       * Bucketed by the zone each row was *captured* in, not by the zone the
       * caller asked about. §5.3: "A workout at '7am' during travel is a
       * materially different fact from one at 7am at home." A close written at
       * 23:00 in Kolkata and read back from London is still that day's close,
       * and re-bucketing it into the reader's zone would move it — occasionally
       * onto a day that already had one, quietly deleting a Compounding Day.
       */
      const distinctDays = new Set(rows.map((row) => dayKeyInZone(row.observedAt, row.zone)));
      return ok(distinctDays.size);
    },
  };
}
