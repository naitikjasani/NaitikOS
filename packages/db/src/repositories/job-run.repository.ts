/**
 * The nightly run's completion record.
 *
 * §5.16 makes this the *only* thing standing between a silently dead background
 * pipeline and a maintainer noticing:
 *
 *   "Absence of the record by 05:00 raises an alert."
 *
 * That framing is what makes this file interesting. The alert is on **absence**,
 * which means a bug here fails in the worst possible direction: a recorder that
 * throws on `finish` produces a run that did all its work and left no record, and
 * the alert then reports a nightly run that never happened. So `finish` writes
 * whatever it has and swallows nothing quietly.
 *
 * ## The second thing `finish` does, and why it is here rather than in a step
 *
 * A run killed by a serverless timeout writes `start` and never `finish`, so it
 * sits in `running` for ever. Those rows are **evidence** — §5.16's alert is on
 * the absence of a completion record, and an unfinished row is that absence made
 * visible — so they are neither deleted nor counted as failures. They are
 * *adjudicated*: {@link markAbandonedJobRuns} marks the ones that are provably
 * dead and leaves the rest alone.
 *
 * The proof is generated right here. A run that has just recorded its ending is
 * itself the evidence that an older run of the same job is not still in flight,
 * so the sweep runs immediately after the completion write rather than a night
 * later inside a step — a step executes *during* a run, when no later
 * completion exists yet, and would therefore always be judging last night's
 * corpse with tonight's proof missing.
 */

import { and, desc, eq, gte, isNull, lt, sql } from 'drizzle-orm';
import type { Result } from '@naitikos/shared';
import { ok } from '@naitikos/shared';
import type { DomainError, JobRunRecorder, JobRunSummary } from '@naitikos/core';
import { ABANDONED_RUN_AFTER_MS, isoFromMillis, parseInstant } from '@naitikos/core';

import type { Database } from '../client';
import { jobRun } from '../schema/operations';

/** The job name a full nightly run records under. §5.16 alerts on this exact value. */
export const NIGHTLY_JOB_NAME = 'nightly';

/**
 * A recorder writing to `job_run`.
 *
 * @param jobName - defaults to {@link NIGHTLY_JOB_NAME}. A single step run alone
 * from `/settings/developer` records under its own name, so a manual re-run of
 * `refresh-rollups` does not satisfy the alert that watches for a full nightly.
 */
export function createJobRunRecorder(db: Database, jobName = NIGHTLY_JOB_NAME): JobRunRecorder {
  return {
    async start(runId, isManual, startedAt) {
      await db.insert(jobRun).values({
        id: runId,
        jobName,
        status: 'running',
        startedAt,
        isManual,
      });
    },

    async finish(summary: JobRunSummary) {
      const failedSteps = summary.steps.filter((step) => step.status === 'failed');

      await db
        .update(jobRun)
        .set({
          status: summary.status === 'succeeded' ? 'succeeded' : 'failed',
          finishedAt: summary.finishedAt,
          durationMs: summary.durationMs,
          /*
           * The per-step detail `/settings/developer` renders, including each
           * step's `note` — codes and counts only, because §5.11's "event names
           * and numeric measurements only" applies to anything a background job
           * writes about its own execution too. The runner clamps the note's
           * length (`JOB_STEP_NOTE_MAX_CHARS`), so this column cannot be grown
           * without bound by a step that composes a chatty one.
           *
           * No migration was needed to carry it: the column is `jsonb`, the
           * note is one more key inside an object already stored there, and
           * `toStepRecords` narrows what comes back rather than trusting a
           * shape. Rows written before the note existed carry none at all,
           * which is exactly the case that function already handles.
           */
          steps: summary.steps,
          rowsAffected: summary.steps.reduce((total, step) => total + (step.rowsAffected ?? 0), 0),
          errorMessage:
            failedSteps.length === 0
              ? null
              : // Step names and error codes, never a message from the failure
                // itself: a step that failed on a constraint violation would
                // otherwise write the offending row's values into this column.
                failedSteps
                  .map((step) => `${step.name}:${step.errorCode ?? 'unknown'}`)
                  .join(', '),
        })
        .where(eq(jobRun.id, summary.runId));

      /*
       * Adjudicate older stranded runs, after the write above and never before
       * it. This run's ending is the proof the sweep relies on, and the
       * completion record §5.16 alerts on must be on disk before anything
       * optional is attempted against the same table.
       *
       * The failure is swallowed, and it is the only thing in this file that is.
       * `finish` is declared as returning `void`, so there is nothing to hand a
       * count to; and a housekeeping statement that threw here would turn a run
       * that has already recorded itself into an unhandled 500, which makes cron
       * retry — a second run, not a retry (see the route). The cost of
       * swallowing is visible rather than silent: the rows stay unmarked and
       * keep appearing on `/settings/developer` as unadjudicated, which is the
       * direction that preserves the evidence.
       */
      try {
        await markAbandonedJobRuns(db, { jobName, asOf: summary.startedAt });
      } catch {
        // See above. Nothing to report to, and nothing lost but a label.
      }
    },
  };
}

/**
 * The most recent run of a job.
 *
 * `halted` is mapped to `failed` on write, so a caller distinguishing the two
 * reads `steps` — a halted run has `skipped` entries after a `failed` one.
 */
export async function lastJobRun(
  db: Database,
  jobName = NIGHTLY_JOB_NAME,
): Promise<{
  id: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  isManual: boolean;
  errorMessage: string | null;
} | null> {
  const rows = await db
    .select({
      id: jobRun.id,
      status: jobRun.status,
      startedAt: jobRun.startedAt,
      finishedAt: jobRun.finishedAt,
      durationMs: jobRun.durationMs,
      isManual: jobRun.isManual,
      errorMessage: jobRun.errorMessage,
    })
    .from(jobRun)
    .where(eq(jobRun.jobName, jobName))
    .orderBy(desc(jobRun.startedAt))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * Whether a successful, non-manual run has completed since `since`. §5.16's check.
 *
 * Non-manual specifically. A human pressing the button at 11pm must not satisfy an
 * alert that exists to detect the cron having stopped firing — otherwise debugging
 * the problem is what makes the symptom disappear.
 */
export async function hasCompletedRunSince(
  db: Database,
  since: string,
  jobName = NIGHTLY_JOB_NAME,
): Promise<boolean> {
  const rows = await db
    .select({ id: jobRun.id })
    .from(jobRun)
    .where(
      and(
        eq(jobRun.jobName, jobName),
        eq(jobRun.status, 'succeeded'),
        eq(jobRun.isManual, false),
        gte(jobRun.startedAt, since),
      ),
    )
    .limit(1);

  return rows.length > 0;
}

/**
 * The mark a provably dead run carries. See {@link markAbandonedJobRuns}.
 *
 * A code, not a sentence, and it goes in `error_message` — a column whose
 * stated contents are "step names and error codes only", which this is. That
 * placement is a small abuse of the column's name and it is recorded here
 * rather than hidden: the state being expressed belongs in `status`, and
 * `job_status` is a Postgres enum with no `abandoned` member, so putting it
 * there is a migration. §13.2 keeps migrations out of feature commits, and the
 * cost of waiting is one column reading slightly off — against the cost of a
 * schema change to add a label. When the enum catches up, this moves, and
 * {@link abandonedJobRuns} is the only reader to follow.
 *
 * An abandoned run is deliberately **not** given `status = 'failed'`: the work
 * may well have completed, and folding it into the failure count would make
 * that count mean "failed or possibly fine", which is to say nothing.
 */
export const ABANDONED_JOB_RUN_MARKER = 'abandoned:no_completion_record';

/**
 * Runs left in `running` from an invocation that was killed.
 *
 * A serverless platform terminates mid-step with no chance to write `finish`, so
 * these rows accumulate. They are not the same as a failure — the work may have
 * completed — and conflating them would make the failure count meaningless.
 *
 * Marked rows are still returned. The mark records that the row has been
 * *judged*, not that it has been dealt with, and hiding judged rows here would
 * quietly convert the sweep into the deletion it deliberately is not.
 */
export async function abandonedJobRuns(
  db: Database,
  olderThan: string,
): Promise<readonly { id: string; jobName: string; startedAt: string; adjudicated: boolean }[]> {
  const rows = await db
    .select({
      id: jobRun.id,
      jobName: jobRun.jobName,
      startedAt: jobRun.startedAt,
      errorMessage: jobRun.errorMessage,
    })
    .from(jobRun)
    .where(and(eq(jobRun.status, 'running'), sql`${jobRun.startedAt} < ${olderThan}`))
    .orderBy(desc(jobRun.startedAt));

  return rows.map((row) => ({
    id: row.id,
    jobName: row.jobName,
    startedAt: row.startedAt,
    /*
     * An *un*marked row past the cut-off is the more alarming of the two, and
     * the distinction is worth surfacing rather than flattening: it means no
     * later run of that job has recorded an ending since this one started — so
     * either the pipeline has been down since, or the row is the most recent
     * thing that happened. A marked row, by contrast, has been overtaken by a
     * run that finished.
     */
    adjudicated: row.errorMessage === ABANDONED_JOB_RUN_MARKER,
  }));
}

/**
 * Mark the runs that are provably abandoned, and touch nothing else.
 *
 * ## Why marking, and not deleting
 *
 * §5.16's alert fires on the **absence** of a completion record. An unfinished
 * `job_run` row is that absence in physical form: it is the only surviving
 * trace that an invocation started on a night nothing finished. Deleting it
 * destroys the evidence the alert exists to provide, and it does so in the
 * silent direction — the table would look tidy on exactly the mornings
 * something went wrong.
 *
 * Nor does deletion buy much. `job_run` has no retention policy at all: every
 * successful night keeps a row too, so the table grows by roughly 365 rows a
 * year whether or not anything is killed, and abandoned rows are a small
 * subset of that. Deleting them would therefore trade the whole of the signal
 * for a rounding error of the growth. If `job_run` needs bounding — and one day
 * it will — the honest fix is a retention sweep over the *whole* table under
 * §9.4's line between domain data and operational exhaust, decided once and
 * applied to succeeded rows first. That is a policy decision, not a tidy-up,
 * and it is not made here.
 *
 * What marking does bound is the set of rows a maintainer has to *think* about:
 * every stranded row is judged once, and `/settings/developer` can then say
 * which of them are explained and which are not.
 *
 * ## Why it cannot touch a run that is still in flight
 *
 * Three conditions, each independently sufficient to exclude a live run:
 *
 * 1. **It started more than {@link ABANDONED_RUN_AFTER_MS} before `asOf`.** The
 *    runner's own wall-clock budget is fifteen minutes and it aborts itself when
 *    the budget is spent, recording `halted`. A run with no ending recorded
 *    thirty minutes on cannot be one that is behaving.
 * 2. **It has recorded no ending** — `status = 'running'` and `finished_at IS
 *    NULL`. A run that ended, however badly, is out of scope by definition.
 * 3. **A later run of the same job has completed.** In practice this condition
 *    is supplied by the caller: `finish` invokes this immediately after writing
 *    its own completion record, so the proof is the calling run itself. An
 *    invocation that reached its end is evidence that the job is not blocked,
 *    and — with (1) — that anything older is not merely slow.
 *
 * Condition (1) is what makes the overlap case safe. A human pressing the
 * button while cron is mid-run produces two live invocations, and the manual
 * one finishing would otherwise judge the cron one; the cron run is minutes
 * old, so it is nowhere near the cut-off. `asOf` is the *start* of the
 * completing run rather than its finish for the same reason — the earlier
 * instant marks strictly fewer rows.
 *
 * And if all three were somehow satisfied by a run that is genuinely alive, the
 * mark is self-correcting: that run's own `finish` overwrites `status`,
 * `finished_at` and `error_message` with its account of itself. The mark is a
 * label on a row, never a claim on it.
 *
 * `finished_at` and `duration_ms` are left null. Nothing here knows when the
 * invocation died, and writing a plausible instant would put a fabricated fact
 * in a record §9.4 keeps for ever.
 *
 * @param asOf - the instant to judge from. The completing run's `startedAt`.
 * @param jobName - scoped to one job, defaulting to {@link NIGHTLY_JOB_NAME}. A
 * finished `nightly` says nothing about whether a single-step run started from
 * `/settings/developer` is still going, so it must not judge one. The
 * consequence is that a stranded single-step run stays unadjudicated until that
 * same step is next run alone — which is honest: nothing has proved it dead.
 */
export async function markAbandonedJobRuns(
  db: Database,
  options: { readonly asOf: string; readonly jobName?: string },
): Promise<Result<number, DomainError>> {
  const asOf = parseInstant(options.asOf);
  /*
   * An unparseable reference instant marks nothing. The tempting fallback —
   * treat it as the epoch — produces a cut-off that matches every unfinished
   * run in the table, including one that started a minute ago, which is the
   * one outcome this function is built to be incapable of.
   */
  if (asOf === null) return ok(0);

  const cutoff = isoFromMillis(asOf.getTime() - ABANDONED_RUN_AFTER_MS);

  const marked = await db
    .update(jobRun)
    .set({ errorMessage: ABANDONED_JOB_RUN_MARKER })
    .where(
      and(
        eq(jobRun.jobName, options.jobName ?? NIGHTLY_JOB_NAME),
        eq(jobRun.status, 'running'),
        isNull(jobRun.finishedAt),
        /* Idempotent, and it is also what keeps the sweep from overwriting a
         * row that already carries step names and error codes. */
        isNull(jobRun.errorMessage),
        lt(jobRun.startedAt, cutoff),
      ),
    )
    .returning({ id: jobRun.id });

  return ok(marked.length);
}

/* =========================================================================
 * Reading runs back — `/settings/developer`
 *
 * `lastJobRun` above answers the alert's question ("did a run finish?") and is
 * deliberately narrow: it omits `steps`, because §5.16's check has no use for
 * the blob and widening it would push a jsonb column into the alert path and
 * into every `GET /api/jobs/nightly` response.
 *
 * The dashboard asks a different question — *what did the run actually do, step
 * by step, over the last few nights* — so it gets its own read rather than a
 * widened one. Two small queries, each honest about its caller.
 * ====================================================================== */

/**
 * One step's outcome, as {@link createJobRunRecorder}'s `finish` wrote it.
 *
 * `note` used to be missing from this type, and its absence went further down
 * than the type: a step returned one in its `JobStepOutcome` — "3 recovered, 12
 * pending" — `docs/background-jobs.md` §10 stated it was surfaced on
 * `/settings/developer`, and `runNightly` built each entry of
 * `JobRunSummary['steps']` without it, so the note was discarded before the
 * recorder ever saw it. The summary now carries it and this type reads it back.
 * No migration was involved: `steps` is `jsonb`, and the note is another key in
 * an object it already stored.
 */
export type JobRunStepRecord = {
  readonly name: string;
  readonly status: string;
  readonly durationMs: number;
  /** Null when the step reported no row count, which is not the same as zero. */
  readonly rowsAffected: number | null;
  readonly errorCode: string | null;
  /**
   * The step's own account of what it did, or null.
   *
   * Null for three different reasons that look the same from here: the step had
   * nothing to say, the step failed (an `Err` carries a code, not an outcome),
   * or the row was written before the note was persisted at all. None of them
   * is worth inventing a distinction for on the page — a step with no note
   * shows its counts alone.
   */
  readonly note: string | null;
};

/** A run with its per-step detail. See {@link recentJobRuns}. */
export type JobRunDetail = {
  readonly id: string;
  readonly jobName: string;
  readonly status: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
  readonly isManual: boolean;
  readonly rowsAffected: number | null;
  readonly errorMessage: string | null;
  readonly steps: readonly JobRunStepRecord[];
};

/**
 * Narrow the `steps` jsonb, defensively.
 *
 * This column is written by our own recorder, so the shape *should* be known —
 * but it is `jsonb` on a table that will be read in year twelve, and a run
 * recorded by an older build of this application is exactly the row a cast
 * would render as `undefined` somewhere in a component tree. An entry that does
 * not parse is dropped rather than faked; a dashboard showing four steps from a
 * five-step run is wrong, and one showing `[object Object]` is worse.
 */
function toStepRecords(value: unknown): readonly JobRunStepRecord[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry: unknown): readonly JobRunStepRecord[] => {
    if (typeof entry !== 'object' || entry === null) return [];
    const record: Record<string, unknown> = { ...entry };

    const name = record['name'];
    const status = record['status'];
    if (typeof name !== 'string' || typeof status !== 'string') return [];

    const durationMs = record['durationMs'];
    const rowsAffected = record['rowsAffected'];
    const errorCode = record['errorCode'];
    const note = record['note'];

    return [
      {
        name,
        status,
        durationMs: typeof durationMs === 'number' ? durationMs : 0,
        rowsAffected: typeof rowsAffected === 'number' ? rowsAffected : null,
        errorCode: typeof errorCode === 'string' ? errorCode : null,
        /* Anything that is not a string is dropped rather than stringified. A
         * note is the one free-text field in the blob, so it is also the one a
         * malformed row is most likely to carry something unrenderable in. */
        note: typeof note === 'string' && note !== '' ? note : null,
      },
    ];
  });
}

/**
 * The most recent runs, newest first, with their steps.
 *
 * @param jobName - restrict to one job. Omitted means *every* job name, which
 * is the right default for a dashboard: the recorder takes a name so that a
 * single step re-run files under its own rather than satisfying §5.16's alert,
 * and a viewer filtered to `nightly` would be the one surface that could not
 * show the run somebody had just triggered by hand.
 */
export async function recentJobRuns(
  db: Database,
  options: { readonly limit: number; readonly jobName?: string } = { limit: 10 },
): Promise<Result<readonly JobRunDetail[], DomainError>> {
  const rows = await db
    .select({
      id: jobRun.id,
      jobName: jobRun.jobName,
      status: jobRun.status,
      startedAt: jobRun.startedAt,
      finishedAt: jobRun.finishedAt,
      durationMs: jobRun.durationMs,
      isManual: jobRun.isManual,
      rowsAffected: jobRun.rowsAffected,
      errorMessage: jobRun.errorMessage,
      steps: jobRun.steps,
    })
    .from(jobRun)
    .where(options.jobName === undefined ? undefined : eq(jobRun.jobName, options.jobName))
    .orderBy(desc(jobRun.startedAt))
    .limit(options.limit);

  return ok(rows.map((row) => ({ ...row, steps: toStepRecords(row.steps) })));
}
