/**
 * §5.16's standing assertions over the record, as read-only queries.
 *
 * §5.16 asks for them by name:
 *
 *   "**Data-integrity assertions**, run nightly: no observation dated in the
 *    future; no medication with an end date before its start; no orphaned media
 *    rows; no observation referencing an unregistered metric key. These catch
 *    the class of bug that silently corrupts a longitudinal record and is
 *    otherwise discovered years later."
 *
 * ## This file reads. It never writes, and that is the whole design
 *
 * There is no UPDATE, no DELETE and no INSERT below, and there must never be
 * one. §9.1 makes the observation log append-only — "if a weight from 2027 can
 * be silently edited in 2031, then no number in the system can be relied upon
 * and the entire premise fails" — and a nightly job that *repaired* what it
 * found would be the single most dangerous piece of code in the system: it
 * would rewrite the record at 03:00, unattended, on the strength of a heuristic,
 * and the evidence of what it changed would be the thing it destroyed. A
 * violation is a fact to be surfaced to a human, not a task to be dispatched.
 *
 * Migration 0001's trigger already refuses most of the repairs anyone would be
 * tempted to write, which is reassuring rather than sufficient — `medication`
 * and the clinical subtypes carry no such trigger.
 *
 * ## What is asserted here, and what is deliberately not
 *
 * The brief for this file is narrower than "check everything", because a
 * constraint beats a query. A CHECK or a foreign key is enforced at write time,
 * on every path, by the one component that cannot be bypassed; a nightly query
 * finds the same corruption up to twenty-four hours later and only if the job
 * ran. So an assertion earns its place here **only if the schema cannot express
 * it**. Re-checking a constraint nightly is theatre — it can only ever pass, and
 * a suite of assertions that always passes teaches the operator to stop reading
 * it.
 *
 * Dropped after checking the live catalogue (`pg_constraint`), each with the
 * constraint that already covers it:
 *
 * - **An observation referencing an unregistered metric key**, which §5.16 asks
 *   for explicitly. `observation_metric_key_metric_key_fk` makes it impossible.
 *   §9.3(1)'s "no free-floating numbers" is already a write-time guarantee.
 * - **`upload_outbox.media_object_id` pointing at a non-existent object.**
 *   `upload_outbox_media_object_id_media_object_id_fk` exists. It was reported
 *   missing; `events.ts` does carry `.references()` and the catalogue agrees.
 *   What the foreign key cannot say is that the column is *populated*, which is
 *   {@link INTEGRITY_ASSERTIONS} `upload_outbox.uploaded_without_object` below.
 * - **Two overlapping believed schedules for one medication.**
 *   `medication_schedule_no_overlap`, a GiST exclusion constraint from
 *   migration 0002. The same shape *is* checked on the eight clinical subtypes
 *   that have no equivalent — see `clinical.believed_interval_overlap`.
 * - **`medical_event`'s reversed validity or transaction intervals.**
 *   `medical_event_valid_ordered` and `medical_event_recorded_ordered`.
 * - **`observation.unit` disagreeing with `metric.canonical_unit`.** Not
 *   corruption. The column is denormalised on purpose — `substrate.ts` calls it
 *   "deliberate redundancy", so that a registry whose canonical unit changed in
 *   year eight does not retroactively relabel year three. A mismatch is history
 *   working correctly, and asserting over it would produce a nightly alert for
 *   the system behaving as designed.
 * - **Reversed intervals on the clinical subtypes** — `valid_to < valid_from`,
 *   `recorded_to < recorded_from`. These are real gaps: the eight subtypes
 *   share §9.5's `bitemporal` block but only `medical_event` received the two
 *   CHECKs. They are omitted here precisely *because* they are expressible: the
 *   honest fix is a migration adding sixteen CHECK constraints, not a query
 *   that finds the damage a day late. Recorded in `docs/background-jobs.md` as
 *   outstanding. `medication`'s `stopped_at`/`started_at` pair is in the same
 *   family and *is* asserted below, for the single reason that §5.16 names it.
 * - **A storage object with no row, or a row with no object** (§9.8). Owned by
 *   `verify-media-integrity`, which is a different step for a reason: it needs
 *   the storage driver, and this file needs nothing but a connection.
 * - **§5.16's "no orphaned media rows"**, in the direction the foreign key
 *   cannot cover — `media_attachment.entity_type` / `entity_id`, which is
 *   polymorphic like §9.3(3). Nothing in shipped code inserts
 *   `media_attachment`, so its entity-type vocabulary does not yet exist. An
 *   assertion over an empty table against an invented vocabulary would report
 *   zero every night for years and read as assurance. It arrives with the first
 *   writer.
 * - **A Daily Close disagreeing with the observations it wrote.** There is no
 *   `daily_close` row to disagree with: `daily-close.repository.ts` writes the
 *   Close *as* observations plus a completion marker, so there is no
 *   denormalised count anywhere for the log to contradict. The absence of that
 *   table is the reason the assertion is unnecessary rather than the reason it
 *   is hard.
 * - **`metric_rollup.sample_count` against the observations in its bucket.**
 *   Tempting, and wrong twice over. `refresh-rollups` recomputes the same
 *   trailing window from the same log twenty minutes earlier in the same run,
 *   so a disagreement would be a bug in code that just ran; and expressing the
 *   comparison means restating the day-bucketing in SQL, which
 *   `rollup.repository.ts` argues at length must exist exactly once ("a `GROUP
 *   BY` here would be a second implementation of the rule, free to disagree
 *   with the first").
 *
 * ## Cost
 *
 * Every query below is a sequential or index scan over a table §9.7 sizes at
 * "under 400,000 rows" across twenty years, and each stops at
 * {@link INTEGRITY_ROW_ID_CAP}. `sample`, the only table that reaches tens of
 * millions, is deliberately untouched — device data under a ninety-day
 * retention has no correction chain, no polymorphic subject and no tombstone,
 * so there is nothing here for it to violate.
 */

import type { SQL } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import type { Result } from '@naitikos/shared';
import { err, ok } from '@naitikos/shared';
import type { DomainError } from '@naitikos/core';
import {
  EPISODE_SUBJECT_TYPE,
  PRACTICE_SUBJECT_TYPE,
  SESSION_SUBJECT_TYPE,
  SET_SUBJECT_TYPE,
  SKIN_REGION_SUBJECT_TYPE,
  SKIN_STATE_SUBJECT_TYPE,
  SYMPTOM_SUBJECT_TYPE,
  VITAL_READING_SUBJECT_TYPE,
  preconditionFailedError,
} from '@naitikos/core';

import type { Database } from '../client';
import { MEAL_SUBJECT_TYPE } from './meal.repository';

/**
 * Every assertion this reader can report, as stable identifiers.
 *
 * Stable for the same reason `JOB_STEPS`'s names are: one of these lands in
 * `job_run.steps[].note` and in the `code` field of a log line, so renaming one
 * silently breaks whatever an operator has learned to grep for. Prefixed by the
 * table so a report of eleven names is scannable in the order the tables matter.
 */
export const INTEGRITY_ASSERTIONS = Object.freeze([
  'observation.future_dated',
  'observation.orphaned_subject',
  'observation.unknown_subject_type',
  'observation.supersession_dangling',
  'observation.supersession_cross_metric',
  'observation.supersession_fan_in',
  'observation.supersession_cycle',
  'medication.stopped_before_started',
  'clinical.orphaned_by_tombstone',
  'clinical.believed_interval_overlap',
  'upload_outbox.uploaded_without_object',
] as const);

export type IntegrityAssertion = (typeof INTEGRITY_ASSERTIONS)[number];

/**
 * How many offending row ids each assertion carries back.
 *
 * Twenty, because the number is chosen for the human at the other end and not
 * for the query. §5.16's purpose is to "catch the class of bug that silently
 * corrupts a longitudinal record" — the response to a violation is to open a
 * psql session and look, and the first twenty ids are enough to start. An
 * unbounded list would put an unbounded value into a log line, and
 * `JOB_STEP_NOTE_MAX_CHARS` exists to stop exactly that.
 *
 * No exact count is taken alongside. A second `count(*)` per assertion doubles
 * the queries to distinguish "nineteen" from "several thousand", and neither
 * answer changes what anyone does next: {@link IntegrityViolation.truncated}
 * says whether there is more, which is the only part of the magnitude that is
 * actionable.
 */
export const INTEGRITY_ROW_ID_CAP = 20;

/**
 * How far ahead of `now` an observation may be dated before it is a violation.
 *
 * Five minutes, and the tolerance is not an excuse for a bad row. §5.7 makes
 * capture offline-first and client-timestamped: `observed_at` is whatever the
 * phone believed the time was, and a handset a minute or two ahead of NTP is
 * ordinary rather than corrupt. Zero tolerance would therefore fire on a
 * perfectly good Daily Close submitted at 23:59 by a slightly fast clock, and
 * §5.16's own framing — an alert that cries wolf once gets muted — is the
 * argument against that.
 *
 * Five minutes is far below the granularity of anything the record answers
 * questions at (a day key), and far above plausible handset drift. The bug this
 * assertion exists for — an import that mistook a Unix millisecond field for
 * seconds, a timezone applied twice — misses by hours, months or decades.
 */
export const OBSERVATION_FUTURE_GRACE_SECONDS = 300;

/**
 * §9.3(3)'s polymorphic observation subjects, mapped to the tables they name.
 *
 * `observation.subject_type` + `subject_id` are "deliberately **not** a foreign
 * key" (`substrate.ts`), and §9.3 gives the reason: enforcement is "by
 * application-level validation per metric rather than by database
 * polymorphism, which Postgres handles badly". That decision is right and it
 * leaves exactly one hole no constraint can close — a subject that was never
 * written, or a subject row that has since gone. This map is what makes that
 * hole checkable, and it is the reason this assertion is the most valuable one
 * in the file.
 *
 * The map is here rather than in `core` because it names *physical tables*,
 * which is a `db` concern; the type strings come from `core`, which owns the
 * vocabulary, so the two halves cannot drift into inventing a subject type
 * nothing writes.
 */
const SUBJECT_TABLES: Readonly<Record<string, string>> = Object.freeze({
  [SET_SUBJECT_TYPE]: 'workout_set',
  [SESSION_SUBJECT_TYPE]: 'workout_session',
  [SKIN_STATE_SUBJECT_TYPE]: 'skin_state',
  [SKIN_REGION_SUBJECT_TYPE]: 'skin_region_state',
  [EPISODE_SUBJECT_TYPE]: 'anxiety_episode',
  [PRACTICE_SUBJECT_TYPE]: 'practice_session',
  [SYMPTOM_SUBJECT_TYPE]: 'symptom',
  [MEAL_SUBJECT_TYPE]: 'meal',
  /* `lab.repository.ts` writes this one as a bare literal rather than through a
   * `*_SUBJECT_TYPE` constant. Restated rather than fixed — moving it is a
   * change to a file another agent owns — and it is the one entry here that a
   * rename could break silently. */
  lab_result: 'lab_result',
});

/**
 * Subject types that intentionally name no table.
 *
 * `vital_reading` is the whole list, and it exists so a blood pressure is not
 * reported as corruption every night. `health/vitals.ts` uses the subject only
 * to bind the two halves of one reading together — "what binds the two halves
 * of a blood pressure together" — so a systolic and its diastolic share a
 * subject id that is a grouping key and never a row. Checking it against a
 * `vital_reading` table would flag every reading the system has ever taken;
 * omitting it from {@link SUBJECT_TABLES} without saying so would make it
 * indistinguishable from a subject type someone forgot to register, which is
 * what `observation.unknown_subject_type` reports.
 */
const TABLELESS_SUBJECT_TYPES: readonly string[] = Object.freeze([VITAL_READING_SUBJECT_TYPE]);

/**
 * §9.3's clinical subtypes — every table carrying `medical_event_id`.
 *
 * The supertype is what makes the medical timeline "a query over one table
 * rather than a ten-way union" (`medical.ts`), and the two assertions that walk
 * this list are the price of that: the join is not a join the database can
 * police in the directions that matter. `medication_schedule` is absent because
 * it hangs off `medication` rather than off the event, and because its overlap
 * rule already has a constraint.
 */
const CLINICAL_SUBTYPES: readonly string[] = Object.freeze([
  'appointment',
  'condition',
  'lab_panel',
  'medication',
  'procedure',
  'side_effect',
  'symptom',
  'treatment_course',
]);

/**
 * One assertion that found something.
 *
 * There may be several per assertion name — the two clinical assertions run
 * once per subtype table and report the table they found it in, because
 * "somewhere in eight tables" is not actionable and "in `condition`" is.
 */
export type IntegrityViolation = {
  readonly assertion: IntegrityAssertion;
  /** The physical table the offending rows are in. */
  readonly table: string;
  /**
   * Primary keys of offending rows, capped at {@link INTEGRITY_ROW_ID_CAP}.
   *
   * Identifiers only. §5.11 holds "event names and numeric measurements only",
   * and a violation report is a job's account of itself — so what travels is
   * the id of the row to go and look at, never the value that made it wrong.
   */
  readonly rowIds: readonly string[];
  /** True when the cap was reached and there are more rows than are listed. */
  readonly truncated: boolean;
  /**
   * A bounded, non-content discriminator where the id alone is not enough —
   * the unrecognised `subject_type` values, say. Never a measured value.
   */
  readonly detail?: string;
};

export type IntegrityReport = {
  /** Every assertion that found something. Empty is the healthy result. */
  readonly violations: readonly IntegrityViolation[];
  /** How many queries ran, so a clean report is distinguishable from no report. */
  readonly assertionsRun: number;
  /** Offending rows listed across every violation. Bounded by the cap. */
  readonly rowsFlagged: number;
};

export type IntegrityReader = {
  /**
   * Run every assertion and report what failed.
   *
   * `nowIso` rather than the database's `now()`, so a test can name the instant
   * it is asserting against instead of racing the clock, and so the one
   * time-dependent assertion reads from the same injected clock as the rest of
   * the nightly run (§11.3).
   */
  assert(nowIso: string): Promise<Result<IntegrityReport, DomainError>>;
};

/** A row of ids, as `db.execute` hands them back from a raw query. */
type IdRow = { readonly id: string };

export function createIntegrityReader(db: Database): IntegrityReader {
  /**
   * Run one assertion and shape the result.
   *
   * The queries are raw rather than composed, and for once that is not laziness:
   * two of them join a table chosen at runtime from a frozen list of physical
   * names, one is a recursive CTE, and Drizzle expresses neither. Table names
   * reach SQL through `sql.identifier`, so they are quoted rather than
   * interpolated, and they come from {@link SUBJECT_TABLES} and
   * {@link CLINICAL_SUBTYPES} — module constants, never from a request.
   *
   * Nothing here reads a timestamp column back, which is why there is no
   * `parseSqlTimestamp` in this file: a raw query returns Postgres's own text
   * form rather than ISO 8601 (see `enquiry.repository.ts`), and the way to not
   * get that wrong is to select ids and let the offending row's dates be read
   * by whoever goes to look.
   */
  const found = async (
    assertion: IntegrityAssertion,
    table: string,
    query: SQL,
    detail?: string,
  ): Promise<IntegrityViolation | null> => {
    const rows = (await db.execute(query)) as unknown as readonly IdRow[];
    if (rows.length === 0) return null;
    return {
      assertion,
      table,
      rowIds: rows.map((row) => row.id),
      truncated: rows.length >= INTEGRITY_ROW_ID_CAP,
      ...(detail === undefined ? {} : { detail }),
    };
  };

  return {
    async assert(nowIso) {
      const violations: IntegrityViolation[] = [];
      let assertionsRun = 0;

      const push = async (
        assertion: IntegrityAssertion,
        table: string,
        query: SQL,
        detail?: string,
      ): Promise<void> => {
        assertionsRun += 1;
        const violation = await found(assertion, table, query, detail);
        if (violation !== null) violations.push(violation);
      };

      try {
        /* ------------------------------------------------------------------
         * §5.16, verbatim: "no observation dated in the future"
         *
         * Not expressible as a CHECK, and not because nobody wrote one:
         * `now()` is STABLE rather than IMMUTABLE, so Postgres refuses it in a
         * constraint expression — the same reason `substrate.ts` cannot have
         * the date-truncated index §9.6 asks for. This is one of the two
         * assertions in the file that a constraint could never replace.
         *
         * What it catches is a unit or zone error in an importer: seconds read
         * as milliseconds puts a 2026 reading in the year 57000, and every
         * trend chart in the system then has a twenty-year x-axis with one
         * point on it.
         * --------------------------------------------------------------- */
        await push(
          'observation.future_dated',
          'observation',
          sql`
            select id::text as id
              from observation
             where observed_at > ${nowIso}::timestamptz
                                 + ${sql.raw(String(OBSERVATION_FUTURE_GRACE_SECONDS))} * interval '1 second'
             order by observed_at desc
             limit ${INTEGRITY_ROW_ID_CAP}
          `,
        );

        /* ------------------------------------------------------------------
         * §9.3(3): the polymorphic subject that no foreign key can police.
         *
         * One query per known subject type rather than one query with a
         * runtime-built union, because the second is unreadable and this is
         * nine index-supported anti-joins over a table §9.7 caps at 400,000
         * rows. `observation_subject_idx` leads on `subject_type`.
         * --------------------------------------------------------------- */
        for (const [subjectType, table] of Object.entries(SUBJECT_TABLES)) {
          await push(
            'observation.orphaned_subject',
            table,
            sql`
              select o.id::text as id
                from observation o
               where o.subject_type = ${subjectType}
                 and not exists (
                   select 1 from ${sql.identifier(table)} s where s.id = o.subject_id
                 )
               limit ${INTEGRITY_ROW_ID_CAP}
            `,
            subjectType,
          );
        }

        /*
         * A subject type this file has never heard of.
         *
         * Reported as its own violation rather than folded into the above,
         * because the two mean opposite things. An orphaned subject is
         * corruption in the *data*; an unrecognised `subject_type` is a gap in
         * *this file* — a domain shipped a new subject vocabulary and the map
         * above was not extended, so those rows are silently unchecked. Left
         * unreported it would be the worst kind of green: the assertion would
         * pass by not looking.
         */
        const knownSubjectTypes = [...Object.keys(SUBJECT_TABLES), ...TABLELESS_SUBJECT_TYPES];
        assertionsRun += 1;
        const unknownRows = (await db.execute(sql`
          select o.id::text as id, o.subject_type as subject_type
            from observation o
           where o.subject_type is not null
             and o.subject_type not in (${sql.join(
               knownSubjectTypes.map((type) => sql`${type}`),
               sql`, `,
             )})
           limit ${INTEGRITY_ROW_ID_CAP}
        `)) as unknown as readonly { readonly id: string; readonly subject_type: string }[];
        if (unknownRows.length > 0) {
          violations.push({
            assertion: 'observation.unknown_subject_type',
            table: 'observation',
            rowIds: unknownRows.map((row) => row.id),
            truncated: unknownRows.length >= INTEGRITY_ROW_ID_CAP,
            /* The type strings, deduplicated. A `subject_type` is a vocabulary
             * token chosen by a developer — `workout_set`, `meal` — so it is
             * safe to carry where a value would not be. */
            detail: [...new Set(unknownRows.map((row) => row.subject_type))].sort().join(','),
          });
        }

        /* ------------------------------------------------------------------
         * §9.1's correction chain, in the four shapes it can be broken.
         *
         * The database holds three of the rules already: `superseded_by_id` and
         * `superseded_at` are set together, a row may not supersede itself, and
         * migration 0001 makes the pointer write-once. There is deliberately no
         * self-referential foreign key — the trigger permits the UPDATE that
         * sets the pointer, but nothing checks the target — so the rest is
         * unguarded.
         *
         * This matters more than it looks. `rollup.repository.ts` filters
         * `superseded_by_id IS NULL` to get "current" readings, and every trend
         * chart goes through it. A broken chain therefore does not produce an
         * error; it produces a chart. Its own header makes the point: a
         * bodyweight corrected from 84 to 74 double-counts to 79, "which is a
         * number a person might well weigh. Nothing would ever flag it."
         * --------------------------------------------------------------- */

        /* A pointer at a row that does not exist. The successor was never
         * written, or was written to a database this one was not restored
         * from — in either case the correction is lost and the *superseded*
         * reading is now invisible to every current-only read. */
        await push(
          'observation.supersession_dangling',
          'observation',
          sql`
            select o.id::text as id
              from observation o
             where o.superseded_by_id is not null
               and not exists (select 1 from observation s where s.id = o.superseded_by_id)
             limit ${INTEGRITY_ROW_ID_CAP}
          `,
        );

        /* A correction that changed the metric. §9.1's supersession means "this
         * reading, restated" — a bodyweight cannot be corrected by a mood
         * score. Where this happens the old metric silently loses a reading and
         * the new one silently gains one. */
        await push(
          'observation.supersession_cross_metric',
          'observation',
          sql`
            select o.id::text as id
              from observation o
              join observation s on s.id = o.superseded_by_id
             where o.metric_key <> s.metric_key
             limit ${INTEGRITY_ROW_ID_CAP}
          `,
        );

        /* Two rows superseded by the same successor. A chain is a list, not a
         * tree: one replacement standing in for two readings means one of them
         * has been retracted without a replacement, and no current-only read
         * will ever show it again. The ids reported are the contested
         * successors, because that is the row to look at first. */
        await push(
          'observation.supersession_fan_in',
          'observation',
          sql`
            select o.superseded_by_id::text as id
              from observation o
             where o.superseded_by_id is not null
             group by o.superseded_by_id
            having count(*) > 1
             limit ${INTEGRITY_ROW_ID_CAP}
          `,
          'ids are the contested successors',
        );

        /*
         * A chain that returns to where it started.
         *
         * `observation_no_self_supersede` rules out a one-row cycle and nothing
         * rules out a two-row one: A superseded by B and B superseded by A
         * satisfies every constraint on the table and every assertion above it,
         * including fan-in, since each row is named exactly once. Every
         * current-only read then omits both, so a pair of readings simply
         * vanishes from the record while remaining perfectly present in it.
         *
         * The walk is bounded at 64 hops. A real chain is one or two links —
         * a Close revised twice — and a bound is what keeps a cycle from
         * turning this query into an infinite one. A legitimate chain longer
         * than 64 corrections to a single reading would be missed by this
         * assertion and is not a case worth widening for.
         */
        await push(
          'observation.supersession_cycle',
          'observation',
          sql`
            with recursive walk as (
              select id as root, superseded_by_id as next, 1 as depth
                from observation
               where superseded_by_id is not null
              union all
              select w.root, o.superseded_by_id, w.depth + 1
                from walk w
                join observation o on o.id = w.next
               where o.superseded_by_id is not null
                 and w.depth < 64
                 and w.next <> w.root
            )
            select distinct root::text as id from walk where next = root limit ${INTEGRITY_ROW_ID_CAP}
          `,
        );

        /* ------------------------------------------------------------------
         * §5.16, verbatim: "no medication with an end date before its start"
         *
         * The one assertion here that a CHECK could carry and does not.
         * `medication` has `medication_stop_paired` and nothing about ordering,
         * where six other tables in the schema got their `*_ordered` check —
         * `workout_session`, `sleep_night`, `trip`, `visit`, `life_span`,
         * `financial_account`. It is asserted rather than skipped only because
         * §5.16 names it, and the gap is recorded in `docs/background-jobs.md`
         * as a migration to write.
         *
         * §4.4 is what makes it worth naming: the register is "the
         * authoritative source consumed by Mind, Skin, and adherence detection
         * across the system", and a reversed interval makes a course of
         * medication that ended before it began — which every adherence figure
         * derived from it will divide by.
         * --------------------------------------------------------------- */
        await push(
          'medication.stopped_before_started',
          'medication',
          sql`
            select id::text as id
              from medication
             where started_at is not null
               and stopped_at is not null
               and stopped_at < started_at
             limit ${INTEGRITY_ROW_ID_CAP}
          `,
        );

        /* ------------------------------------------------------------------
         * §9.4's tombstones, across §9.3's supertype join.
         *
         * §9.4 hard-deletes nothing, so removal is a `deleted_at`, and §9.6
         * requires every hot-path query to filter it. Each clinical subtype
         * filters *its own* `deleted_at` — `condition_status_idx` and
         * `medication_active_idx` are both partial on it — and none of them
         * checks the supertype's. A `medical_event` tombstoned without its
         * subtype therefore leaves a medication in the active register and in
         * the Consultation Pack (§2.2) while the timeline that event drives has
         * dropped it. The record disagrees with itself about whether the fact
         * was deleted, and both halves look healthy in isolation.
         *
         * No constraint can express this: it is a condition across two rows,
         * which is what CHECK cannot see and what a foreign key does not
         * describe. Per subtype table, so the report names the one to look in.
         * --------------------------------------------------------------- */
        for (const table of CLINICAL_SUBTYPES) {
          await push(
            'clinical.orphaned_by_tombstone',
            table,
            sql`
              select c.id::text as id
                from ${sql.identifier(table)} c
                join medical_event e on e.id = c.medical_event_id
               where c.deleted_at is null
                 and e.deleted_at is not null
               limit ${INTEGRITY_ROW_ID_CAP}
            `,
          );
        }

        /* ------------------------------------------------------------------
         * §9.5's transaction axis: two believed rows for one fact, at once.
         *
         * §9.5's rule is that "a row is superseded by closing `recordedTo` and
         * inserting a successor, never by an UPDATE", which is what makes "as
         * known on date X" answerable — filter `recorded_from <= X <
         * recorded_to`. `medication.repository.ts` relies on exactly that:
         * every read filters `recorded_to IS NULL`.
         *
         * So two rows for one `medical_event_id`, both believed, whose validity
         * intervals *intersect*, are a fact the record holds two answers to and
         * a register that double-counts. This is precisely the shape migration
         * 0002's GiST exclusion constraint forbids for `medication_schedule`,
         * and the eight subtypes here have no equivalent.
         *
         * Overlap rather than mere multiplicity, deliberately. Two believed
         * rows with *disjoint* intervals are the history this schema exists to
         * keep — `medication_schedule`'s own comment defends it at length: 75mg
         * then 150mg is "two rows with adjacent, non-overlapping intervals",
         * and a rule that rejected the second "forbids the history this table
         * exists to keep". `a.id < b.id` reports each pair once.
         * --------------------------------------------------------------- */
        for (const table of CLINICAL_SUBTYPES) {
          await push(
            'clinical.believed_interval_overlap',
            table,
            sql`
              select a.id::text as id
                from ${sql.identifier(table)} a
                join ${sql.identifier(table)} b
                  on b.medical_event_id = a.medical_event_id
                 and a.id < b.id
               where a.recorded_to is null and a.deleted_at is null
                 and b.recorded_to is null and b.deleted_at is null
                 and tstzrange(a.valid_from, a.valid_to, '[)')
                     && tstzrange(b.valid_from, b.valid_to, '[)')
               limit ${INTEGRITY_ROW_ID_CAP}
            `,
          );
        }

        /* ------------------------------------------------------------------
         * §5.7: an outbox row that reached its terminal state with nothing in
         * it.
         *
         * The foreign key guarantees that `media_object_id`, when set, points
         * at a real object. It says nothing about the column being set, and
         * `uploaded` is the status that claims the bytes have landed —
         * `events.ts` marks the column "set once the object exists and the row
         * is written". A row in that state with a null object is §5.7's
         * nightmare stated exactly: "losing a logged workout because the drain
         * failed quietly would end the user's trust in the system, and trust is
         * the whole product." Worse than a failed upload, because the failed
         * one is still in `upload_outbox_age_idx` and this one has left the
         * alert's field of view by declaring success.
         * --------------------------------------------------------------- */
        await push(
          'upload_outbox.uploaded_without_object',
          'upload_outbox',
          sql`
            select id::text as id
              from upload_outbox
             where status = 'uploaded'
               and media_object_id is null
             limit ${INTEGRITY_ROW_ID_CAP}
          `,
        );
      } catch {
        /*
         * A query that would not run is not a violation, and conflating the two
         * would be the worst possible failure of this file: "the record is
         * broken" and "we could not tell" must never arrive as the same report.
         *
         * `precondition_failed` because the input is well-formed and the system
         * is not in a state where the read can be answered (§5.12). The message
         * carries the assertion count and nothing from the driver — a
         * constraint violation's text contains the offending row's values, and
         * §5.13 keeps those out of a log line as firmly as out of a response.
         */
        return err(
          preconditionFailedError(
            'integrity_queries_readable',
            `Data-integrity assertions could not be completed; ${String(assertionsRun)} of them ran.`,
            'integrity_query_failed',
          ),
        );
      }

      return ok({
        violations,
        assertionsRun,
        rowsFlagged: violations.reduce((total, violation) => total + violation.rowIds.length, 0),
      });
    },
  };
}

/**
 * A violation report, as one line for `job_run.steps[].note`.
 *
 * Lives here rather than in `core/jobs/registry.ts` because it is about the
 * shape of *this* reader's output, not about how a step is run — the registry
 * is the durable contract every step shares, and a formatter for one step's
 * findings is not part of it.
 *
 * Bounded by construction rather than by `clampNote`'s truncation. There are
 * eleven assertion names and each is under forty characters, so listing three
 * and counting the rest keeps the line inside
 * `JOB_STEP_NOTE_MAX_CHARS` without the ellipsis landing mid-identifier — a
 * clipped assertion name is a name an operator cannot grep for.
 */
export function summariseIntegrity(report: IntegrityReport): string {
  if (report.violations.length === 0) {
    return `${String(report.assertionsRun)} assertions, no violations`;
  }

  const byAssertion = new Map<IntegrityAssertion, number>();
  for (const violation of report.violations) {
    byAssertion.set(violation.assertion, (byAssertion.get(violation.assertion) ?? 0) + violation.rowIds.length);
  }

  const ranked = [...byAssertion.entries()].sort((a, b) => b[1] - a[1]);
  const listed = ranked.slice(0, 3).map(([name, rows]) => `${name} ×${String(rows)}`);
  const remainder = ranked.length - listed.length;

  return [
    `${String(report.rowsFlagged)} rows across ${String(ranked.length)} assertions: `,
    listed.join(', '),
    remainder > 0 ? `, +${String(remainder)} more` : '',
  ].join('');
}
