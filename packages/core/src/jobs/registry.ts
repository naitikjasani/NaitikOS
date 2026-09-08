/**
 * Background job infrastructure.
 *
 * ## The constraint that shapes everything here
 *
 * §5.2 permits **exactly one** scheduled entry point:
 *
 *   "Exactly one scheduled entry point — a nightly job at 03:00 local — which
 *    runs derivation, detectors, and rollups in sequence. One cron, idempotent,
 *    safe to re-run, and manually triggerable from `/settings/developer`. Every
 *    additional scheduled job must justify itself against C3."
 *
 * So this is **not a queue with workers.** It is an ordered list of steps that
 * one cron invocation walks, plus a table of deferred work that the same
 * invocation drains. There is no second scheduler, no worker pool, and no
 * polling loop.
 *
 * That is a real constraint rather than a simplification. At n=1 with ~50 actions
 * a day there is no throughput problem, and C3 says the system "must survive
 * three-week gaps in attention" — a queue is a second piece of infrastructure to
 * operate, and §5.2 is explicit that every scheduled job "is a liability that
 * must justify itself".
 *
 * ## Idempotency is required, not encouraged
 *
 * §5.2 says the nightly run is "idempotent, safe to re-run". Every step must
 * therefore produce the same result when run twice on the same day — because it
 * *will* be, by the manual trigger, by a retry, and by an operator debugging at
 * 11pm.
 */

import type { Result } from '@naitikos/shared';

import type { DomainError } from '../errors/domain-error';
import type { Clock } from '../temporal/clock';

/* =========================================================================
 * Steps
 * ====================================================================== */

/**
 * A unit of nightly work.
 *
 * Names are stable identifiers: they key the completion record §5.16 alerts on,
 * so renaming one makes the alert fire for a step that no longer exists and stay
 * silent for the one that replaced it.
 */
export const JOB_STEPS = [
  /**
   * Derived observations from raw ones — session volume, adherence ratios.
   *
   * First because everything downstream reads what it writes. A detector running
   * before derivation sees yesterday's data.
   */
  'derive-observations',

  /** Daily and weekly rollups per metric (§5.6, §9.7). */
  'refresh-rollups',

  /**
   * A dated record of what each goal's trajectory looked like tonight (§4.10).
   *
   * After rollups, because the projection is fitted over them. §9.2 gives the
   * reason the row exists at all, despite §4.10's "goals own no progress data":
   * "Snapshots exist so the *trajectory as it was believed at the time* is
   * preserved even after the underlying data is corrected." Progress is still
   * derived on every read; this is history, not state.
   *
   * Nightly rather than on read, because "what did I believe on the 3rd" is a
   * daily question, and a snapshot per page view would make the table a log of
   * page views.
   */
  'snapshot-goal-progress',

  /**
   * Score every prediction whose horizon has arrived (§10.9).
   *
   * **Before `make-predictions`, and the order is load-bearing.** Tonight's new
   * prediction for a metric is fitted over a window that includes today's
   * reading; yesterday's prediction *about* today must be scored against that
   * same reading first. Reversed, a run could resolve a prediction against a
   * series the same run had already extended, which is not the comparison
   * §10.9 asks for.
   *
   * Idempotent because `resolve` refuses a prediction that already carries a
   * verdict — a re-run finds nothing left to score rather than re-scoring
   * against a later reading.
   */
  'resolve-predictions',

  /**
   * Tonight's predictions (§10.9).
   *
   * After rollups, because every method here is fitted over them, and after
   * resolution for the reason above. The id is derived from the subject and the
   * day so a re-run writes the same row twice and lands on one — without that,
   * a retried evening would double the denominator of every calibration figure.
   */
  'make-predictions',

  /**
   * Deterministic detectors (§10.6).
   *
   * V2. Registered here so the ordering is settled: after rollups, because a
   * detector reading a trend needs the trend to exist.
   */
  'run-detectors',

  /** Local embeddings for semantic search (§10). V2, and local-only (P7). */
  'generate-embeddings',

  /** Thumbnails for objects that arrived without them. */
  'generate-thumbnails',

  /**
   * §9.8: "a nightly integrity check asserts that every storage object has a row
   * and every row has an object, because a photo series with silent gaps is worse
   * than one with none."
   */
  'verify-media-integrity',

  /**
   * §5.16's data-integrity assertions.
   *
   * "No observation dated in the future; no medication with an end date before
   * its start; no orphaned media rows; no observation referencing an unregistered
   * metric key. These catch the class of bug that silently corrupts a
   * longitudinal record and is otherwise discovered years later."
   */
  'assert-data-integrity',

  /** Enqueue tomorrow's notifications (§5.9). No separate scheduler. */
  'schedule-notifications',

  /** Rebuild the timeline projection when a version bump requires it. */
  'rebuild-timeline',

  /**
   * Make sure the month ahead has a `sample` partition to land in.
   *
   * Before `downsample-samples`, and the order is not arbitrary: both touch the
   * same table, and creating a partition takes a brief `ACCESS EXCLUSIVE` lock
   * on the parent. Doing that first means the lock is taken against a quiet
   * table rather than queued behind a collapse that is deleting a month of rows.
   *
   * A step rather than a database cron for the reason §5.2 gives: this is the
   * only scheduler. A partition that failed to appear must show up in `job_run`
   * beside everything else, because the symptom otherwise is an import failing
   * at midnight on the first of a month with a constraint error.
   */
  'maintain-partitions',

  /** Downsample device samples past 90 days (§9.7). */
  'downsample-samples',

  /** Prune expired idempotency records. */
  'prune-idempotency',

  /**
   * §5.11's telemetry retention: "Ninety-day retention, then aggregate and
   * discard."
   *
   * A nightly step rather than a database cron so the deletion appears in
   * `job_run` like every other scheduled effect — a sweep nobody can see the
   * result of is a sweep nobody notices has stopped running.
   */
  'prune-telemetry',

  /**
   * Deferred work enqueued by event handlers.
   *
   * Last, so a task enqueued by an earlier step in the same run is picked up
   * tonight rather than tomorrow.
   */
  'drain-task-queue',
] as const;

export type JobStepName = (typeof JOB_STEPS)[number];

export type JobStepContext = {
  readonly clock: Clock;
  /** The run this step belongs to, for logging and the completion record. */
  readonly runId: string;
  /** True when a human pressed the button rather than cron firing. */
  readonly isManual: boolean;
  /** Cooperative cancellation, so a long step can stop at a timeout. */
  readonly signal?: AbortSignal;
};

export type JobStepOutcome = {
  readonly rowsAffected?: number;
  /**
   * Surfaced in `/settings/developer`. Never user content (§5.11).
   *
   * Carried into the completion record by the runner and clamped to
   * {@link JOB_STEP_NOTE_MAX_CHARS} on the way, so a step is free to compose
   * one without knowing how wide the column it lands in is.
   */
  readonly note?: string;
};

export type JobStep = {
  readonly name: JobStepName;
  readonly describes: string;
  /**
   * Whether a failure here should stop the run.
   *
   * `true` for steps later steps depend on — a failed derivation makes every
   * rollup wrong, so continuing would write bad aggregates. `false` for
   * independent steps: a thumbnail failure must not prevent the integrity check.
   */
  readonly haltOnFailure: boolean;
  run(context: JobStepContext): Promise<Result<JobStepOutcome, DomainError>>;
};

/* =========================================================================
 * Deferred tasks
 * ====================================================================== */

/**
 * Work an event handler defers to the nightly run.
 *
 * The bus dispatches synchronously (see `events/bus.ts`), so anything slow —
 * thumbnailing a 12 MB photo, generating an embedding — becomes a row here rather
 * than blocking the request that emitted it.
 */
export const TASK_KINDS = [
  'thumbnail.generate',
  'embedding.generate',
  'document.extract-text',
  'timeline.reproject',
  'notification.send',
  /** Declared for §10's narration path. No AI in this milestone. */
  'ai.summarise',
] as const;

export type TaskKind = (typeof TASK_KINDS)[number];

export type DeferredTask = {
  readonly id: string;
  readonly kind: TaskKind;
  /**
   * What to act on. A reference, never a payload.
   *
   * Same reasoning as ADR 0005: a task carrying a copy of the data would be a
   * copy that can drift, and a task table is exactly where a stale copy sits
   * unnoticed for a week.
   */
  readonly subject: { readonly type: string; readonly id: string };
  readonly enqueuedAt: string;
  readonly attempts: number;
  /** Not before this instant. Used for backoff and for notification scheduling. */
  readonly notBefore?: string;
  /** The event that caused this task, for tracing (§5.13). */
  readonly causationEventId?: string;
};

/**
 * Attempts before a task is dead-lettered.
 *
 * Three, matching the event bus. §5.16 alerts on the dead-letter table, so a
 * task that fails three nights running becomes visible rather than retrying
 * forever and hiding a permanent failure behind a growing queue.
 */
export const TASK_MAX_ATTEMPTS = 3;

/**
 * Backoff before the next attempt.
 *
 * Coarse — 1h, 6h, 24h — because the runner fires nightly and finer granularity
 * would be theatre. The point is that a transient failure gets a second chance
 * tonight and a third tomorrow, rather than three attempts in the same run
 * against the same broken dependency.
 */
export function backoffSeconds(attempt: number): number {
  const schedule = [3600, 21_600, 86_400];
  return schedule[Math.min(attempt, schedule.length - 1)] ?? 86_400;
}

/* =========================================================================
 * The runner
 * ====================================================================== */

/**
 * The longest `note` that reaches the recorder.
 *
 * A note is counts and codes — "3 recovered, 12 pending" — and every registered
 * step's is comfortably inside two hundred characters, so this is a bound
 * rather than a formatter. It exists because the note is the one part of a
 * step's outcome that is free text: a step interpolating an unbounded value
 * into it — every metric key it skipped, a driver's error string — would put
 * that value in a record §5.11 says holds "event names and numeric
 * measurements only", and `job_run` is never pruned, so the row would keep it.
 *
 * Truncation is marked rather than silent, and a long note is clipped rather
 * than dropped: a clipped note still shows which step spoke and prompts a look
 * at it, whereas dropping it loses the step's own account of what it did.
 */
export const JOB_STEP_NOTE_MAX_CHARS = 200;

export type JobRunSummary = {
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly status: 'succeeded' | 'failed' | 'halted';
  readonly steps: readonly {
    readonly name: JobStepName;
    readonly status: 'succeeded' | 'failed' | 'skipped';
    readonly durationMs: number;
    readonly rowsAffected?: number;
    readonly errorCode?: string;
    /**
     * The step's own one-line account of what it did, clamped to
     * {@link JOB_STEP_NOTE_MAX_CHARS}.
     *
     * Carried through to the completion record because a row count alone does
     * not say what the run *found*: "0 pending, 0 failed" and "no reading
     * taken" are the same `rowsAffected: 0`, and only one of them is healthy.
     * Counts and codes only, never user content (§5.11) — the note travels into
     * `job_run.steps`, which §9.4 keeps as long as the row.
     *
     * Absent for a `failed` step (an `Err` carries a code, not an outcome) and
     * for a `skipped` one (it never ran, so it has nothing to say).
     */
    readonly note?: string;
  }[];
};

/** Persists the completion record §5.16 alerts on. */
export type JobRunRecorder = {
  start(runId: string, isManual: boolean, startedAt: string): Promise<void>;
  finish(summary: JobRunSummary): Promise<void>;
};

export type RunnerDependencies = {
  readonly clock: Clock;
  readonly recorder: JobRunRecorder;
  readonly newId: () => string;
  /**
   * Wall-clock budget for the whole run.
   *
   * Default 15 minutes. A run that has not finished by then is stuck, and on a
   * serverless platform it will be killed mid-step anyway — better to abort
   * deliberately and write a `halted` record §5.16 can alert on than to be
   * terminated with no record at all.
   */
  readonly budgetMs?: number;
};

export const DEFAULT_RUN_BUDGET_MS = 15 * 60 * 1000;

/**
 * How long a run may sit unfinished before it is presumed dead.
 *
 * Twice {@link DEFAULT_RUN_BUDGET_MS}. A healthy run cannot exceed the budget —
 * it aborts itself and records `halted` — so a run with no ending recorded
 * after double it was killed mid-step by the platform with no chance to write
 * `finish`.
 *
 * Deliberately far shorter than `drain-task-queue`'s six-hour task threshold,
 * and the asymmetry is not an oversight. Recovering a *task* releases a claim
 * another invocation may still be holding, so stealing one too early produces
 * two workers on the same subject — a correctness failure, priced with a
 * six-hour margin. A `job_run` row is written and owned by exactly one
 * invocation and read by nobody else, so the cost of judging one too early is a
 * mislabelled row rather than duplicated work. Keeping it in minutes is what
 * makes last night's corpse visible over breakfast instead of the following
 * evening.
 *
 * It is defined here, beside the budget it is derived from, so that the sweep
 * that acts on it and the dashboard that reports it cannot drift apart.
 */
export const ABANDONED_RUN_AFTER_MS = 2 * DEFAULT_RUN_BUDGET_MS;

/**
 * Run the registered steps in order.
 *
 * The order is `JOB_STEPS`, not registration order — dependencies between steps
 * are a property of the pipeline, not of which module happened to import first.
 * A step that is registered but not in `JOB_STEPS` is a programming error.
 */
export async function runNightly(
  steps: readonly JobStep[],
  deps: RunnerDependencies,
  options: { readonly isManual?: boolean; readonly only?: readonly JobStepName[] } = {},
): Promise<JobRunSummary> {
  const runId = deps.newId();
  const startedAt = deps.clock.now();
  const isManual = options.isManual ?? false;
  const budgetMs = deps.budgetMs ?? DEFAULT_RUN_BUDGET_MS;

  await deps.recorder.start(runId, isManual, startedAt.toISOString());

  const byName = new Map(steps.map((step) => [step.name, step]));
  // Mutable local; the readonly array in JobRunSummary is the *published*
  // shape, not the one being built.
  const results: JobRunSummary['steps'][number][] = [];
  let halted = false;
  let anyFailed = false;

  for (const name of JOB_STEPS) {
    const step = byName.get(name);
    if (step === undefined) continue;
    if (options.only !== undefined && !options.only.includes(name)) continue;

    if (halted) {
      results.push({ name, status: 'skipped', durationMs: 0 });
      continue;
    }

    const elapsed = deps.clock.nowMillis() - startedAt.getTime();
    if (elapsed > budgetMs) {
      results.push({ name, status: 'skipped', durationMs: 0 });
      halted = true;
      continue;
    }

    const stepStart = deps.clock.nowMillis();
    let outcome: Result<JobStepOutcome, DomainError>;

    try {
      outcome = await step.run({ clock: deps.clock, runId, isManual });
    } catch (thrown: unknown) {
      // A step that throws rather than returning Err is a bug (§5.12), but it
      // must not lose the completion record for the whole run.
      outcome = {
        ok: false,
        error: {
          kind: 'validation',
          code: 'step_threw',
          message: `Step "${name}" threw: ${thrown instanceof Error ? thrown.message : 'unknown'}`,
          issues: [],
        },
      };
    }

    const durationMs = deps.clock.nowMillis() - stepStart;

    if (outcome.ok) {
      // The note is carried into the summary, not dropped here. It used to be:
      // every step returned one, `docs/background-jobs.md` §10 promised
      // `/settings/developer` showed it, and the runner built this entry
      // without it — so the promise was unkeepable three layers below the page
      // that made it. Spread conditionally rather than assigned, because
      // `exactOptionalPropertyTypes` distinguishes an absent note from an
      // explicit `undefined`, and the second would serialise into the jsonb.
      const note = clampNote(outcome.value.note);

      results.push({
        name,
        status: 'succeeded',
        durationMs,
        ...(outcome.value.rowsAffected === undefined ? {} : { rowsAffected: outcome.value.rowsAffected }),
        ...(note === undefined ? {} : { note }),
      });
    } else {
      anyFailed = true;
      results.push({ name, status: 'failed', durationMs, errorCode: outcome.error.code });
      if (step.haltOnFailure) halted = true;
    }
  }

  const finishedAt = deps.clock.now();
  const summary: JobRunSummary = {
    runId,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    status: halted ? 'halted' : anyFailed ? 'failed' : 'succeeded',
    steps: results,
  };

  // Always written, on every path. §5.16: "Absence of the record by 05:00 raises
  // an alert" — so a run that fails silently must still leave a record saying so,
  // or the alert cannot distinguish "failed" from "never ran".
  await deps.recorder.finish(summary);

  return summary;
}

/**
 * Bound a step's note, or report that there is nothing to record.
 *
 * An empty string is treated as absent. A step that returns `note: ''` has said
 * nothing, and persisting the empty string would put a blank line under that
 * step on `/settings/developer` that reads as a missing value rather than as no
 * value.
 */
function clampNote(note: string | undefined): string | undefined {
  if (note === undefined || note === '') return undefined;
  if (note.length <= JOB_STEP_NOTE_MAX_CHARS) return note;

  // The ellipsis replaces a character rather than being appended, so the stored
  // note never exceeds the bound this function exists to enforce.
  return `${note.slice(0, JOB_STEP_NOTE_MAX_CHARS - 1)}…`;
}
