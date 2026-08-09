/**
 * Reading the whole record out, for §9.10's export.
 *
 * ## Every table, discovered rather than listed
 *
 * The table list comes from the schema module itself, not from an array
 * somebody maintains beside it. That is the load-bearing decision here: §9.10
 * promises "every table", and a hand-written list is one that silently stops
 * being complete the first time a table is added. Over twenty years it would
 * stop being complete many times, and each omission would only be discovered by
 * a person who no longer had the application.
 *
 * The cost is that a *new* table appears in the export the moment it exists,
 * before anybody has written a description for it. That is the right direction
 * to fail in — a table with a placeholder description beats a table that is not
 * there.
 */

import { getTableName, sql } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import type { Result } from '@naitikos/shared';
import { ok } from '@naitikos/shared';
import type { DomainError, ExportTable } from '@naitikos/core';

import type { Executor } from '../client';
import * as schema from '../schema';

/**
 * What each table holds, in a sentence, for a reader who has never seen the
 * system. Data, like `metric.description` — it travels in `schema.json`.
 *
 * A table with no entry gets a generated placeholder rather than being omitted.
 */
const TABLE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  observation:
    'The spine of the record. Every measured or reported fact, append-only: a correction is a new row and the old one points at it via superseded_by_id. Join metric_key against metrics.json to learn what each number means.',
  metric:
    'The registry of everything that can be measured. This is what makes the archive self-describing — without it a bare 74.2 has no meaning.',
  observation_source:
    'Where each observation came from: typed by hand, imported from a device, derived by a nightly job, extracted from a document, or inferred by a model. A derived value is distinguishable from a measured one forever.',
  sample: 'High-frequency device samples, kept apart from the human record because of their volume.',
  metric_rollup: 'Daily and weekly aggregates, recomputed nightly. Derived — every value here is reproducible from observation.',
  note: 'Free-text notes attached to anything, including the one line of a Daily Close.',
  journal_entry: 'Journal entries. The most sensitive text in the record.',
  medication: 'The medication register, with the reason each was started and stopped.',
  medication_schedule: 'Dosing schedules, each with its own validity interval, so a dose change is a new schedule rather than an edit that erases the old dose.',
  medication_event: 'Individual doses taken, skipped or delayed. The input to adherence.',
  media_object: 'Photographs and documents. The bytes are under media/ in this archive, decrypted.',
  audit_log: 'The permanent audit trail: who changed what, when, and what it was before.',
  domain_event: 'The integration log. Events reference rows rather than restating them, so this is not a second copy of the record.',
  timeline_entry: 'The rendered timeline, projected from domain_event. Fully derived — it can be rebuilt from the events.',
  idempotency_record: 'Bookkeeping for offline write deduplication. Operational, not part of the record.',
  job_run: 'A log of nightly job runs. Operational.',
};

/** Tables whose contents are operational noise rather than record. */
const OPERATIONAL_TABLES: ReadonlySet<string> = new Set([
  'idempotency_record',
  'schema_migration',
  'app_event',
]);

/** Every physical table the schema declares. */
export function allTableNames(): readonly string[] {
  const names: string[] = [];
  for (const value of Object.values(schema)) {
    // `instanceof PgTable` rather than a duck-typed check: the schema module
    // also exports enums, column helpers and types, and a structural test would
    // eventually admit one of them.
    if (value instanceof PgTable) names.push(getTableName(value));
  }
  return [...new Set(names)].sort();
}

export type ExportOptions = {
  /**
   * Include operational tables. Off by default.
   *
   * §9.10's export is of *the record*, and an idempotency key is not a fact
   * about the person. The flag exists because a full-fidelity backup drill
   * wants everything, and that is a different job from an export.
   */
  readonly includeOperational?: boolean;
  /** Hard cap per table, so one runaway table cannot exhaust memory. */
  readonly maxRowsPerTable?: number;
};

export type ExportRepository = {
  tables(options?: ExportOptions): Promise<Result<readonly ExportTable[], DomainError>>;
  /** The §9.10 Markdown rendering of the clinical history. */
  medicalTimelineMarkdown(): Promise<Result<string, DomainError>>;
};

const DEFAULT_MAX_ROWS = 500_000;

export function createExportRepository(db: Executor): ExportRepository {
  return {
    async tables(options = {}) {
      const limit = options.maxRowsPerTable ?? DEFAULT_MAX_ROWS;
      const names = allTableNames().filter(
        (name) => options.includeOperational === true || !OPERATIONAL_TABLES.has(name),
      );

      const out: ExportTable[] = [];

      for (const name of names) {
        /*
         * `sql.identifier`, not interpolation.
         *
         * The names come from our own schema module and cannot be attacker-
         * controlled, so this is not closing a live hole — it is refusing to
         * write the pattern at all. A `select * from ${name}` here is the exact
         * shape that becomes an injection the day somebody makes the list
         * configurable, and §5.14 treats that as a design rule rather than a
         * case-by-case judgement.
         */
        const rows = await db.execute(
          sql`select * from ${sql.identifier(name)} limit ${limit}`,
        );

        out.push({
          name,
          description:
            TABLE_DESCRIPTIONS[name] ??
            `The ${name.replace(/_/g, ' ')} table. No description was written for it; see the application source.`,
          rows: [...rows] as Record<string, unknown>[],
        });
      }

      return ok(out);
    },

    async medicalTimelineMarkdown() {
      /*
       * Rendered from `timeline_entry`, filtered to clinical events.
       *
       * §9.10 asks for "a human-readable Markdown rendering of the medical
       * timeline", and the timeline projection already *is* that content in
       * structured form — rendering it here rather than re-querying the clinical
       * tables means the export and the application agree about what the
       * clinical history is. A second traversal would eventually disagree.
       */
      const rows = await db
        .select({
          occurredOn: schema.timelineEntry.occurredOn,
          title: schema.timelineEntry.title,
          detail: schema.timelineEntry.detail,
          eventType: schema.timelineEntry.eventType,
        })
        .from(schema.timelineEntry)
        .where(sql`${schema.timelineEntry.clinical} = true`)
        .orderBy(schema.timelineEntry.occurredOn);

      if (rows.length === 0) {
        return ok(
          '# Medical timeline\n\nNothing clinical has been recorded yet.\n\n' +
            'This file is generated from the timeline projection, filtered to clinically\n' +
            'significant events. When it is empty, it is empty because the record is —\n' +
            'not because the export omitted anything.\n',
        );
      }

      const lines: string[] = [
        '# Medical timeline',
        '',
        'Clinically significant events, in order. Generated from the record; every',
        'entry here also appears in tables/timeline_entry.ndjson with its identifiers.',
        '',
      ];

      let currentDay = '';
      for (const row of rows) {
        if (row.occurredOn !== currentDay) {
          currentDay = row.occurredOn;
          lines.push('', `## ${currentDay}`, '');
        }
        lines.push(`- **${row.title}**${row.detail === null ? '' : ` — ${row.detail}`}`);
      }

      return ok(`${lines.join('\n')}\n`);
    },
  };
}
