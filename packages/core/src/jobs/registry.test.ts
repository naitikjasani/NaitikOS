/**
 * The nightly runner.
 *
 * §5.2 permits **exactly one** scheduled entry point, so this single function is
 * the whole background-processing story. That concentrates the risk: if it halts
 * early, or runs steps out of order, or fails to write its completion record, the
 * consequence is not a slow queue — it is that derivation, rollups, detectors, and
 * the media integrity sweep all silently stop happening, and §5.16's alert is the
 * only thing that would notice.
 *
 * So the assertions here are mostly about failure paths: what runs after a step
 * fails, and whether a record is written on every exit.
 */

import { describe, expect, it } from 'vitest';
import type { Result } from '@naitikos/shared';
import { err, ok } from '@naitikos/shared';

import type { DomainError } from '../errors/domain-error';
import { validationError } from '../errors/domain-error';
import { manualClock } from '../temporal/clock';
import {
  DEFAULT_RUN_BUDGET_MS,
  JOB_STEPS,
  TASK_KINDS,
  TASK_MAX_ATTEMPTS,
  backoffSeconds,
  runNightly,
} from './registry';
import type { JobRunRecorder, JobRunSummary, JobStep, JobStepName } from './registry';

const START = new Date('2026-08-04T03:00:00+05:30');

class FakeRecorder implements JobRecorderShape {
  readonly starts: { runId: string; isManual: boolean; startedAt: string }[] = [];
  readonly finishes: JobRunSummary[] = [];

  start(runId: string, isManual: boolean, startedAt: string): Promise<void> {
    this.starts.push({ runId, isManual, startedAt });
    return Promise.resolve();
  }

  finish(summary: JobRunSummary): Promise<void> {
    this.finishes.push(summary);
    return Promise.resolve();
  }
}

type JobRecorderShape = JobRunRecorder;

/**
 * A step that records when it ran.
 *
 * `advanceMs` moves the manual clock, which is how the budget tests simulate a
 * step taking a long time without actually taking one.
 */
function step(
  name: JobStepName,
  order: string[],
  options: {
    haltOnFailure?: boolean;
    fail?: boolean;
    throws?: boolean;
    rowsAffected?: number;
    advanceMs?: number;
    clock?: { advance(ms: number): void };
  } = {},
): JobStep {
  return {
    name,
    describes: `Test step ${name}.`,
    haltOnFailure: options.haltOnFailure ?? false,
    run(): Promise<Result<{ rowsAffected?: number }, DomainError>> {
      order.push(name);
      if (options.advanceMs !== undefined) options.clock?.advance(options.advanceMs);
      if (options.throws === true) throw new Error('step exploded');
      if (options.fail === true) return Promise.resolve(err(validationError('step_failed', 'Nope.')));
      return Promise.resolve(
        ok(options.rowsAffected === undefined ? {} : { rowsAffected: options.rowsAffected }),
      );
    },
  };
}

function deps(recorder: FakeRecorder, clock: ReturnType<typeof manualClock>, budgetMs?: number) {
  return {
    clock,
    recorder,
    newId: () => 'run-1',
    ...(budgetMs === undefined ? {} : { budgetMs }),
  };
}

/* =========================================================================
 * The step list
 * ====================================================================== */

describe('the step list', () => {
  it('has no duplicates', () => {
    // Names key the completion record §5.16 alerts on. A duplicate would make one
    // step's outcome overwrite the other's.
    expect(new Set(JOB_STEPS).size).toBe(JOB_STEPS.length);
  });

  it('puts derivation before rollups and rollups before detectors', () => {
    // Dependency order, not preference. A detector running before derivation sees
    // yesterday's data; a rollup before derivation aggregates rows that do not
    // exist yet.
    const index = (name: JobStepName): number => JOB_STEPS.indexOf(name);

    expect(index('derive-observations')).toBeLessThan(index('refresh-rollups'));
    expect(index('refresh-rollups')).toBeLessThan(index('run-detectors'));
  });

  it('drains the task queue last', () => {
    // So a task enqueued by an earlier step in the same run is picked up tonight
    // rather than tomorrow.
    expect(JOB_STEPS[JOB_STEPS.length - 1]).toBe('drain-task-queue');
  });

  it('has no duplicate task kinds', () => {
    expect(new Set(TASK_KINDS).size).toBe(TASK_KINDS.length);
  });
});

/* =========================================================================
 * Ordering
 * ====================================================================== */

describe('runNightly — ordering', () => {
  it('runs steps in JOB_STEPS order, not registration order', async () => {
    const clock = manualClock(START);
    const order: string[] = [];

    // Registered backwards on purpose.
    const summary = await runNightly(
      [
        step('drain-task-queue', order),
        step('refresh-rollups', order),
        step('derive-observations', order),
      ],
      deps(new FakeRecorder(), clock),
    );

    // Dependencies between steps are a property of the pipeline, not of which
    // module happened to import first.
    expect(order).toEqual(['derive-observations', 'refresh-rollups', 'drain-task-queue']);
    expect(summary.status).toBe('succeeded');
  });

  it('ignores a step name that is not in JOB_STEPS', async () => {
    const clock = manualClock(START);
    const order: string[] = [];

    const summary = await runNightly(
      [step('derive-observations', order), step('not-a-real-step' as JobStepName, order)],
      deps(new FakeRecorder(), clock),
    );

    expect(order).toEqual(['derive-observations']);
    expect(summary.steps).toHaveLength(1);
  });

  it('runs only the named steps when asked', async () => {
    const clock = manualClock(START);
    const order: string[] = [];

    // The `/settings/developer` case: re-run one step without the other eleven.
    await runNightly(
      [step('derive-observations', order), step('refresh-rollups', order)],
      deps(new FakeRecorder(), clock),
      { only: ['refresh-rollups'] },
    );

    expect(order).toEqual(['refresh-rollups']);
  });
});

/* =========================================================================
 * Failure
 * ====================================================================== */

describe('runNightly — failure', () => {
  it('continues past a non-halting failure', async () => {
    const clock = manualClock(START);
    const order: string[] = [];

    const summary = await runNightly(
      [
        step('generate-thumbnails', order, { fail: true, haltOnFailure: false }),
        step('verify-media-integrity', order),
      ],
      deps(new FakeRecorder(), clock),
    );

    // A thumbnail failure must not prevent the integrity check — they are
    // independent, and the integrity check is the one that matters more.
    expect(order).toEqual(['generate-thumbnails', 'verify-media-integrity']);
    expect(summary.status).toBe('failed');
    expect(summary.steps[0]?.status).toBe('failed');
    expect(summary.steps[0]?.errorCode).toBe('step_failed');
    expect(summary.steps[1]?.status).toBe('succeeded');
  });

  it('skips the rest after a halting failure', async () => {
    const clock = manualClock(START);
    const order: string[] = [];

    const summary = await runNightly(
      [
        step('derive-observations', order, { fail: true, haltOnFailure: true }),
        step('refresh-rollups', order),
        step('run-detectors', order),
      ],
      deps(new FakeRecorder(), clock),
    );

    // A failed derivation makes every rollup wrong. Continuing would write bad
    // aggregates that look like data.
    expect(order).toEqual(['derive-observations']);
    expect(summary.status).toBe('halted');
    expect(summary.steps.map((s) => s.status)).toEqual(['failed', 'skipped', 'skipped']);
  });

  it('records a skipped step rather than omitting it', async () => {
    const clock = manualClock(START);
    const order: string[] = [];

    const summary = await runNightly(
      [step('derive-observations', order, { fail: true, haltOnFailure: true }), step('refresh-rollups', order)],
      deps(new FakeRecorder(), clock),
    );

    // §5.16 alerts on absence. A skipped step that produced no row is
    // indistinguishable from a step that was never registered.
    expect(summary.steps).toHaveLength(2);
    expect(summary.steps[1]).toEqual({ name: 'refresh-rollups', status: 'skipped', durationMs: 0 });
  });

  it('captures a step that throws instead of returning Err', async () => {
    const clock = manualClock(START);
    const order: string[] = [];
    const recorder = new FakeRecorder();

    const summary = await runNightly(
      [step('derive-observations', order, { throws: true }), step('refresh-rollups', order)],
      deps(recorder, clock),
    );

    expect(summary.steps[0]?.errorCode).toBe('step_threw');
    expect(summary.status).toBe('failed');
    // The whole run still completes and still leaves a record — a thrown step must
    // not lose the record for the eleven that worked.
    expect(order).toContain('refresh-rollups');
    expect(recorder.finishes).toHaveLength(1);
  });
});

/* =========================================================================
 * The completion record
 * ====================================================================== */

describe('runNightly — the completion record', () => {
  it('writes a start and a finish on the success path', async () => {
    const clock = manualClock(START);
    const recorder = new FakeRecorder();

    await runNightly([step('derive-observations', [])], deps(recorder, clock));

    expect(recorder.starts).toHaveLength(1);
    expect(recorder.starts[0]?.runId).toBe('run-1');
    expect(recorder.starts[0]?.startedAt).toBe(START.toISOString());
    expect(recorder.finishes).toHaveLength(1);
  });

  it('writes a finish even when every step failed', async () => {
    const clock = manualClock(START);
    const recorder = new FakeRecorder();

    await runNightly(
      [step('derive-observations', [], { fail: true, haltOnFailure: true })],
      deps(recorder, clock),
    );

    // §5.16: "Absence of the record by 05:00 raises an alert." A run that fails
    // silently must still leave a record saying so, or the alert cannot distinguish
    // "failed" from "never ran" — and those need different responses.
    expect(recorder.finishes).toHaveLength(1);
    expect(recorder.finishes[0]?.status).toBe('halted');
  });

  it('writes a finish when no steps are registered at all', async () => {
    const clock = manualClock(START);
    const recorder = new FakeRecorder();

    const summary = await runNightly([], deps(recorder, clock));

    expect(recorder.finishes).toHaveLength(1);
    expect(summary.steps).toEqual([]);
    expect(summary.status).toBe('succeeded');
  });

  it('marks a manual run as manual', async () => {
    const clock = manualClock(START);
    const recorder = new FakeRecorder();

    await runNightly([step('derive-observations', [])], deps(recorder, clock), { isManual: true });

    // §5.2 requires the run be "manually triggerable from /settings/developer", and
    // an alert on a missing nightly run must not be satisfied by a manual one.
    expect(recorder.starts[0]?.isManual).toBe(true);
  });

  it('reports duration and rows affected', async () => {
    const clock = manualClock(START);

    const summary = await runNightly(
      [step('refresh-rollups', [], { rowsAffected: 412, advanceMs: 1500, clock })],
      deps(new FakeRecorder(), clock),
    );

    expect(summary.steps[0]?.rowsAffected).toBe(412);
    expect(summary.steps[0]?.durationMs).toBe(1500);
    expect(summary.durationMs).toBe(1500);
    expect(summary.finishedAt).toBe(new Date(START.getTime() + 1500).toISOString());
  });

  it('omits rowsAffected when a step does not report one', async () => {
    const clock = manualClock(START);
    const summary = await runNightly([step('derive-observations', [])], deps(new FakeRecorder(), clock));

    expect(summary.steps[0]).toEqual({ name: 'derive-observations', status: 'succeeded', durationMs: 0 });
  });
});

/* =========================================================================
 * The budget
 * ====================================================================== */

describe('runNightly — the wall-clock budget', () => {
  it('defaults to fifteen minutes', () => {
    expect(DEFAULT_RUN_BUDGET_MS).toBe(15 * 60 * 1000);
  });

  it('halts deliberately when the budget is exhausted', async () => {
    const clock = manualClock(START);
    const order: string[] = [];

    const summary = await runNightly(
      [
        step('derive-observations', order, { advanceMs: 5000, clock }),
        step('refresh-rollups', order),
        step('run-detectors', order),
      ],
      deps(new FakeRecorder(), clock, 1000),
    );

    // On a serverless platform an over-budget run is killed mid-step with no
    // record at all. Aborting deliberately leaves a `halted` record §5.16 can
    // alert on — the difference between a visible problem and an invisible one.
    expect(order).toEqual(['derive-observations']);
    expect(summary.status).toBe('halted');
    expect(summary.steps.map((s) => s.status)).toEqual(['succeeded', 'skipped', 'skipped']);
  });

  it('checks the budget before a step, not during it', async () => {
    const clock = manualClock(START);
    const order: string[] = [];

    // The first step alone blows the budget. It still runs to completion — there is
    // no way to interrupt an in-flight step without cooperative cancellation.
    const summary = await runNightly(
      [step('derive-observations', order, { advanceMs: 999_999, clock })],
      deps(new FakeRecorder(), clock, 1000),
    );

    expect(order).toEqual(['derive-observations']);
    expect(summary.status).toBe('succeeded');
  });
});

/* =========================================================================
 * Task retries
 * ====================================================================== */

describe('deferred task retries', () => {
  it('backs off coarsely: one hour, six hours, a day', async () => {
    // Coarse because the runner fires nightly — finer granularity would be
    // theatre. The point is a second chance tonight and a third tomorrow, rather
    // than three attempts in one run against the same broken dependency.
    expect(backoffSeconds(0)).toBe(3600);
    expect(backoffSeconds(1)).toBe(21_600);
    expect(backoffSeconds(2)).toBe(86_400);
  });

  it('caps the backoff rather than growing without bound', async () => {
    expect(backoffSeconds(3)).toBe(86_400);
    expect(backoffSeconds(99)).toBe(86_400);
  });

  it('gives up after three attempts, matching the event bus', async () => {
    // §5.16 alerts on the dead-letter table, so a task that fails three nights
    // running becomes visible rather than hiding a permanent failure behind a
    // growing queue.
    expect(TASK_MAX_ATTEMPTS).toBe(3);
  });
});
