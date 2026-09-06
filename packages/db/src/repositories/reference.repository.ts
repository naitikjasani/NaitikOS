/**
 * The lookups behind §10.10's references.
 *
 * §10.10: "The model emits an observation ID; the application renders the
 * number from the database. The model is never the source of a figure the user
 * reads." This is the read half of that sentence.
 *
 * ## Why this speaks in ids rather than in `Reference`s
 *
 * The obvious shape is a method taking `readonly Reference[]` and returning a
 * map keyed by `referenceKey`. It would be shorter at the call site and it
 * would require `db` to import `@naitikos/ai` — and §5.0 puts `ai` *above*
 * `db`, so that dependency runs backwards. The lint boundaries would catch it;
 * the reason it would be wrong anyway is that a reference is a fact about a
 * model's output format, and the database layer has no business knowing that
 * format exists.
 *
 * So this takes five sets of identifiers and returns five maps. The app layer
 * owns the translation, which is where the `ai` types already live.
 *
 * ## One query per kind, never one per reference
 *
 * An eight-paragraph answer can name a dozen references. Awaiting each in turn
 * would put a dozen serial round trips on a page the operator is waiting on.
 * Each kind costs one `inArray`, and the five are issued together because none
 * depends on another's result.
 *
 * ## The superseded case is reported, not followed
 *
 * §9.1 makes a correction a supersession rather than an edit. This returns the
 * row that was pointed at, and says separately whether it has since been
 * corrected. Silently following the chain would make a saved answer render a
 * figure the model never saw — and the answer was true when it was written.
 */

import { inArray } from 'drizzle-orm';
import type { Result } from '@naitikos/shared';
import { ok } from '@naitikos/shared';
import type { DomainError } from '@naitikos/core';
import { formatDecimal, parseDecimal } from '@naitikos/core';

import type { Database } from '../client';
import { document, insight } from '../schema/crosscutting';
import { graphNode } from '../schema/ai';
import { metric, observation } from '../schema/substrate';

/** What to look up. Every set may be empty; an empty set costs no query. */
export type ReferenceLookup = {
  readonly observationIds?: readonly string[];
  readonly metricKeys?: readonly string[];
  readonly nodeIds?: readonly string[];
  readonly documentIds?: readonly string[];
  readonly findingIds?: readonly string[];
};

/** One observation, rendered as the operator would read it. */
export type ObservationDisplay = {
  /** `"74.2 kg"`, or the free text for an observation that has some. */
  readonly text: string;
  /** True when this has been corrected since (§9.1). */
  readonly superseded: boolean;
};

/**
 * A finding's stored statistics.
 *
 * **Only two of `statisticRefSchema`'s six fields exist here.** That schema
 * permits `r`, `n`, `p`, `effectSize`, `lagDays` and `windowDays`; the
 * `insight` table has `p_value` and `effect_size`. The other four cannot be
 * rendered and come back absent, which the renderer turns into a visible gap.
 *
 * That is the honest behaviour and not the right long-term answer — the schema
 * promises a vocabulary the database cannot supply, which is §6.2's failure
 * mode: two files that both look correct on their own. It is recorded here
 * rather than fixed by narrowing the schema, because narrowing it is a decision
 * about what a detector is allowed to report and belongs with the detectors.
 */
export type FindingStatistics = {
  readonly p: string | null;
  readonly effectSize: string | null;
};

export type ReferenceRows = {
  readonly observations: ReadonlyMap<string, ObservationDisplay>;
  /** Metric key → display name, for a slot that names a measure. */
  readonly metrics: ReadonlyMap<string, string>;
  /** Graph node id → label. */
  readonly entities: ReadonlyMap<string, string>;
  /** Document id → title. */
  readonly documents: ReadonlyMap<string, string>;
  readonly findings: ReadonlyMap<string, FindingStatistics>;
};

/** A stored `numeric` as display text. Trims trailing zeros; never rounds. */
function formatStored(value: string): string {
  const parsed = parseDecimal(value);
  return parsed === null ? value : formatDecimal(parsed, { trim: true });
}

export type ReferenceRepository = {
  lookup(request: ReferenceLookup): Promise<Result<ReferenceRows, DomainError>>;
};

export function createReferenceRepository(db: Database): ReferenceRepository {
  return {
    async lookup(request) {
      const observationIds = request.observationIds ?? [];
      const metricKeys = request.metricKeys ?? [];
      const nodeIds = request.nodeIds ?? [];
      const documentIds = request.documentIds ?? [];
      const findingIds = request.findingIds ?? [];

      const [observationRows, metricRows, nodeRows, documentRows, findingRows] = await Promise.all([
        observationIds.length === 0 ?
          []
        : db
            .select({
              id: observation.id,
              value: observation.value,
              valueText: observation.valueText,
              unit: observation.unit,
              supersededById: observation.supersededById,
            })
            .from(observation)
            .where(inArray(observation.id, [...observationIds])),

        metricKeys.length === 0 ?
          []
        : db
            .select({ key: metric.key, displayName: metric.displayName })
            .from(metric)
            .where(inArray(metric.key, [...metricKeys])),

        nodeIds.length === 0 ?
          []
        : db
            .select({ id: graphNode.id, label: graphNode.label })
            .from(graphNode)
            .where(inArray(graphNode.id, [...nodeIds])),

        documentIds.length === 0 ?
          []
        : db
            .select({ id: document.id, title: document.title })
            .from(document)
            .where(inArray(document.id, [...documentIds])),

        findingIds.length === 0 ?
          []
        : db
            .select({ id: insight.id, pValue: insight.pValue, effectSize: insight.effectSize })
            .from(insight)
            .where(inArray(insight.id, [...findingIds])),
      ]);

      const observations = new Map<string, ObservationDisplay>();
      for (const row of observationRows) {
        /*
         * `valueText` wins when present. A journal line stores a numeric
         * `value` of zero standing in for "not a number", and rendering that
         * zero would put a figure on the page that means nothing at all.
         */
        const text =
          row.valueText !== null && row.valueText !== '' ? row.valueText
          : row.unit === '' ? formatStored(row.value)
          : `${formatStored(row.value)} ${row.unit}`;

        observations.set(row.id, { text, superseded: row.supersededById !== null });
      }

      return ok({
        observations,
        metrics: new Map(metricRows.map((row) => [row.key, row.displayName])),
        entities: new Map(nodeRows.map((row) => [row.id, row.label])),
        documents: new Map(documentRows.map((row) => [row.id, row.title])),
        findings: new Map(
          findingRows.map((row) => [row.id, { p: row.pValue, effectSize: row.effectSize }] as const),
        ),
      });
    },
  };
}
