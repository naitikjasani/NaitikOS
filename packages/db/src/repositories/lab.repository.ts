/**
 * Lab panels and results — and the place where §4.11's provenance promise is
 * either kept or quietly broken.
 *
 *   "a lab PDF dropped into the vault becomes structured lab observations with
 *    the source document permanently attached as evidence — so the number in
 *    your chart can always be traced back to the piece of paper it came from.
 *    Provenance is not optional in a medical record."
 *
 * A recorded panel writes three things per result, in one transaction:
 *
 *   1. a `lab_result` row holding the value **and the range exactly as printed**
 *   2. an `observation` against `health.lab.<analyte>`, so it trends (P3)
 *   3. `lab_result.observation_id`, which is the link that makes the number on
 *      a chart clickable back to the document it came from
 *
 * Break any one of those and the record still looks fine. That is why they are
 * one transaction rather than three calls.
 *
 * ## The range is written, never looked up
 *
 * §9.2: "ranges vary by laboratory and change over time, and a 2027 result
 * compared against a 2035 range is a clinical error." So `referenceLow`,
 * `referenceHigh` and `flag` are copied from the report and this file has no
 * table of canonical ranges to consult.
 *
 * ## A result whose unit will not convert still gets a row
 *
 * `toCanonical` fails for an unregistered unit, an unconvertible dimension, or
 * an implausible value. In every one of those cases the `lab_result` row is
 * still written — the record is the record — and only the *observation* is
 * skipped. The consequence is visible rather than silent: the value appears in
 * the panel and has no trend, which is exactly true.
 */

import { and, count, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { Result } from '@naitikos/shared';
import { ok } from '@naitikos/shared';
import type { DomainError, LabFlag, Observation, ObservationInput } from '@naitikos/core';
import {
  analyteBySlug,
  formatDecimal,
  labMetricKey,
  normaliseUnit,
  prepareObservations,
  quantity as makeQuantity,
  toCanonical,
} from '@naitikos/core';

import type { Database } from '../client';
import { labPanel, labResult, medicalEvent } from '../schema/medical';
import { createObservationRepository } from './observation.repository';
import type { WriteContext } from './workout.repository';

export type LabResultRow = {
  readonly id: string;
  readonly labPanelId: string;
  readonly analyte: string;
  readonly value: string | null;
  readonly valueText: string | null;
  readonly unit: string | null;
  readonly referenceLow: string | null;
  readonly referenceHigh: string | null;
  readonly referenceText: string | null;
  readonly flag: LabFlag | null;
  readonly observationId: string | null;
};

export type LabPanelRow = {
  readonly id: string;
  readonly panelName: string;
  readonly laboratory: string | null;
  readonly collectedAt: string | null;
  readonly reportedAt: string | null;
  readonly documentId: string | null;
};

export type PanelWithResults = {
  readonly panel: LabPanelRow;
  readonly results: readonly LabResultRow[];
};

export type RecordResultInput = {
  readonly id: string;
  /** Catalogued slug, or `null` for a result this system has no metric for. */
  readonly analyteSlug: string | null;
  /** The analyte name as the report printed it. Stored verbatim. */
  readonly printedName: string;
  readonly value: string | null;
  readonly valueText?: string | null;
  readonly unit: string | null;
  readonly referenceLow?: string | null;
  readonly referenceHigh?: string | null;
  readonly referenceText?: string | null;
  readonly flag?: LabFlag | null;
  /** 0–1. `1` for a typed value, the parse score for an accepted extraction. */
  readonly confidence: number;
};

export type RecordPanelInput = {
  readonly id: string;
  readonly panelName: string;
  readonly laboratory?: string | null;
  readonly orderedBy?: string | null;
  readonly collectedAt: string;
  readonly reportedAt?: string | null;
  readonly zone: string;
  /** Set when the panel came from a document — the provenance link. */
  readonly documentId?: string | null;
  readonly results: readonly RecordResultInput[];
};

export type RecordPanelOutcome = {
  readonly panelId: string;
  readonly resultsWritten: number;
  /**
   * Results stored structurally but with no observation, and why.
   *
   * Reported back so the confirmation screen can say "recorded, but this one
   * will not appear on a chart" — the alternative is a value the operator
   * believes is being tracked and is not.
   */
  readonly withoutTrend: readonly { readonly analyte: string; readonly reason: string }[];
};

export type LabRepository = {
  panels(limit?: number): Promise<Result<readonly LabPanelRow[], DomainError>>;
  panelById(id: string): Promise<Result<PanelWithResults | null, DomainError>>;
  /** Every result for one analyte, oldest first — the per-analyte trend (§4.4). */
  resultsForAnalyte(slug: string): Promise<Result<readonly (LabResultRow & { readonly collectedAt: string | null })[], DomainError>>;
  /** The analytes that have at least one result, for the labs index. */
  trackedAnalytes(): Promise<Result<readonly { readonly slug: string; readonly count: number }[], DomainError>>;
  recordPanel(input: RecordPanelInput, context: WriteContext): Promise<Result<RecordPanelOutcome, DomainError>>;
};

function toPanel(row: typeof labPanel.$inferSelect): LabPanelRow {
  return {
    id: row.id,
    panelName: row.panelName,
    laboratory: row.laboratory,
    collectedAt: row.collectedAt,
    reportedAt: row.reportedAt,
    documentId: row.documentId,
  };
}

function toResult(row: typeof labResult.$inferSelect): LabResultRow {
  return {
    id: row.id,
    labPanelId: row.labPanelId,
    analyte: row.analyte,
    value: row.value,
    valueText: row.valueText,
    unit: row.unit,
    referenceLow: row.referenceLow,
    referenceHigh: row.referenceHigh,
    referenceText: row.referenceText,
    flag: row.flag as LabFlag | null,
    observationId: row.observationId,
  };
}

export function createLabRepository(db: Database): LabRepository {
  const observations = createObservationRepository(db);

  return {
    async panels(limit = 50) {
      const rows = await db
        .select()
        .from(labPanel)
        .where(and(isNull(labPanel.deletedAt), isNull(labPanel.recordedTo)))
        .orderBy(desc(labPanel.collectedAt))
        .limit(limit);
      return ok(rows.map(toPanel));
    },

    async panelById(id) {
      const panels = await db.select().from(labPanel).where(eq(labPanel.id, id)).limit(1);
      const panel = panels[0];
      if (panel === undefined) return ok(null);

      const results = await db
        .select()
        .from(labResult)
        .where(eq(labResult.labPanelId, id))
        .orderBy(labResult.analyte);

      return ok({ panel: toPanel(panel), results: results.map(toResult) });
    },

    async resultsForAnalyte(slug) {
      const rows = await db
        .select({ result: labResult, collectedAt: labPanel.collectedAt })
        .from(labResult)
        .innerJoin(labPanel, eq(labResult.labPanelId, labPanel.id))
        .where(and(eq(labResult.analyte, slug), isNull(labPanel.deletedAt), isNull(labPanel.recordedTo)))
        /* Oldest first: this feeds a trend line and a range-shift check, and
         * both read forwards through time. */
        .orderBy(labPanel.collectedAt);

      return ok(rows.map((row) => ({ ...toResult(row.result), collectedAt: row.collectedAt })));
    },

    async trackedAnalytes() {
      const rows = await db
        .select({ slug: labResult.analyte, total: count() })
        .from(labResult)
        .innerJoin(labPanel, eq(labResult.labPanelId, labPanel.id))
        .where(and(isNull(labPanel.deletedAt), isNull(labPanel.recordedTo)))
        .groupBy(labResult.analyte);
      return ok(rows.map((row) => ({ slug: row.slug, count: Number(row.total) })));
    },

    async recordPanel(input, context) {
      /*
       * The observations are planned *before* the transaction opens, so a
       * metric that is not registered fails the whole write rather than leaving
       * a panel with half its results trending. §9.2 rejects unregistered keys
       * on write and this is where that rejection has to land.
       */
      const planned: ObservationInput[] = [];
      const plannedFor = new Map<string, string>();
      const withoutTrend: { analyte: string; reason: string }[] = [];

      for (const result of input.results) {
        const definition = result.analyteSlug === null ? null : analyteBySlug(result.analyteSlug);
        if (definition === null) {
          withoutTrend.push({ analyte: result.printedName, reason: 'not_catalogued' });
          continue;
        }
        if (result.value === null) {
          withoutTrend.push({ analyte: definition.displayName, reason: 'no_numeric_value' });
          continue;
        }

        const unitCode = result.unit === null ? definition.canonicalUnit : normaliseUnit(result.unit);
        if (unitCode === null) {
          withoutTrend.push({ analyte: definition.displayName, reason: 'unknown_unit' });
          continue;
        }

        const asQuantity = makeQuantity(result.value, unitCode);
        if (asQuantity === null) {
          withoutTrend.push({ analyte: definition.displayName, reason: 'unreadable_value' });
          continue;
        }

        const canonical = toCanonical(definition, asQuantity);
        if (!canonical.ok) {
          withoutTrend.push({ analyte: definition.displayName, reason: canonical.reason });
          continue;
        }

        const observationId = context.newId();
        plannedFor.set(result.id, observationId);
        planned.push({
          id: observationId,
          metricKey: labMetricKey(definition.slug),
          value: {
            kind: 'number',
            value: formatDecimal(canonical.value.quantity.value),
            unit: definition.canonicalUnit,
          },
          observedAt: input.collectedAt,
          observedZone: input.zone,
          subject: { type: 'lab_result', id: result.id },
          /* §9.9 keeps the confidence rather than discarding it after the
           * extraction. A `1` here means a person typed it. */
          confidence: result.confidence >= 1 ? null : result.confidence.toFixed(2),
        });
      }

      const sourceId =
        input.documentId === undefined || input.documentId === null
          ? await observations.manualSourceId()
          : await observations.extractionSourceId(input.documentId, 'naitikos/lab-parser', '1');
      if (!sourceId.ok) return sourceId;

      const prepared = prepareObservations(planned, context.hlcState, {
        registry: context.registry,
        sourceId: sourceId.value as Observation['sourceId'],
        recordedAt: context.recordedAt,
        physicalMillis: context.physicalMillis,
        newId: context.newId,
      });
      if (!prepared.ok) return prepared;

      const eventId = context.newId();
      await db.transaction(async (tx) => {
        await tx.insert(medicalEvent).values({
          id: eventId,
          type: 'lab_panel',
          title: input.panelName,
          validFrom: input.collectedAt,
          recordedFrom: context.recordedAt,
          ...(input.documentId === undefined || input.documentId === null
            ? {}
            : { documentId: input.documentId, sourceDescription: 'Lab report, imported from the document vault.' }),
          zone: input.zone,
        });

        await tx
          .insert(labPanel)
          .values({
            id: input.id,
            medicalEventId: eventId,
            panelName: input.panelName,
            laboratory: input.laboratory ?? null,
            orderedBy: input.orderedBy ?? null,
            collectedAt: input.collectedAt,
            reportedAt: input.reportedAt ?? null,
            documentId: input.documentId ?? null,
            validFrom: input.collectedAt,
            recordedFrom: context.recordedAt,
          })
          .onConflictDoNothing();

        for (const result of input.results) {
          await tx
            .insert(labResult)
            .values({
              id: result.id,
              labPanelId: input.id,
              /* The slug where the catalogue knows it — so a trend is a
               * straight equality — and the printed name where it does not. */
              analyte: result.analyteSlug ?? result.printedName,
              value: result.value,
              valueText: result.valueText ?? null,
              unit: result.unit,
              referenceLow: result.referenceLow ?? null,
              referenceHigh: result.referenceHigh ?? null,
              referenceText: result.referenceText ?? null,
              flag: result.flag ?? null,
              observationId: plannedFor.get(result.id) ?? null,
            })
            .onConflictDoNothing();
        }
      });

      const appended = await observations.append(prepared.value.observations, prepared.value.supersessions);
      if (!appended.ok) return appended;

      return ok({ panelId: input.id, resultsWritten: input.results.length, withoutTrend });
    },
  };
}

/** Kept so callers filtering a set of panels have one spelling for it. */
export function panelsIn(ids: readonly string[]) {
  return inArray(labPanel.id, ids);
}
