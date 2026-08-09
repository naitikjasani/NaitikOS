import { describe, expect, it } from 'vitest';

import { createMetricRegistry } from '../observations/metric';
import { MVP_METRICS } from '../observations/mvp-metrics';
import {
  CLOSE_COMPLETION_METRIC,
  CLOSE_REVISION_REASON,
  type ClosePlanContext,
  type CloseSubmission,
  type ExistingCloseState,
  isEmptyPlan,
  planDailyClose,
  resolveObservedAt,
} from './plan';

const registry = createMetricRegistry(MVP_METRICS);

const ZONE = 'Asia/Kolkata';
/** 2026-08-03 21:00 IST. Comfortably inside the local day, in the evening. */
const NOW = '2026-08-03T15:30:00.000Z';
const TODAY = '2026-08-03';

let ids = 0;
function context(overrides: Partial<ClosePlanContext> = {}): ClosePlanContext {
  return { registry, now: NOW, newId: () => `new-${String((ids += 1))}`, ...overrides };
}

const EMPTY: ExistingCloseState = { observations: [], medicationEvents: [], note: null };

function submission(overrides: Partial<CloseSubmission> = {}): CloseSubmission {
  return { dayKey: TODAY, zone: ZONE, answers: [], ...overrides };
}

describe('resolveObservedAt', () => {
  /**
   * §9.5 splits "when it happened" from "when the system was told", and the
   * Close is where they routinely differ — a close submitted at 00:40 is
   * usually about yesterday.
   */
  it('uses now when closing the current local day', () => {
    expect(resolveObservedAt(TODAY, ZONE, NOW)).toBe(NOW);
  });

  /**
   * The 00:30 case, which is the common one: the operator closes yesterday
   * after midnight. `observedAt` must land inside yesterday, or the timeline
   * files a whole day's answers under the wrong date.
   */
  it('uses the last instant of the day when back-filling', () => {
    // 19:00 UTC is 00:30 IST on the 4th, so this is a close of the 3rd.
    const afterMidnight = '2026-08-03T19:00:00.000Z';
    expect(resolveObservedAt('2026-08-03', ZONE, afterMidnight)).toBe('2026-08-03T18:29:59.999Z');

    // Back-filling the day before last: the last millisecond of that day.
    expect(resolveObservedAt('2026-08-02', ZONE, NOW)).toBe('2026-08-02T18:29:59.999Z');
  });

  it('never claims a future instant', () => {
    const future = resolveObservedAt('2026-08-09', ZONE, NOW);
    expect(future).toBe(NOW);
  });

  it('refuses an unresolvable day', () => {
    expect(resolveObservedAt('not-a-day', ZONE, NOW)).toBeNull();
    expect(resolveObservedAt(TODAY, 'IST', NOW)).toBeNull();
  });
});

describe('planDailyClose — the first close of a day', () => {
  it('writes an observation per answer plus the completion marker', () => {
    const result = planDailyClose(
      submission({
        answers: [
          { kind: 'metric', metricKey: 'mind.mood', value: { kind: 'integer', value: 4 } },
          { kind: 'metric', metricKey: 'body.sleep.duration', value: { kind: 'number', value: '7.5' } },
        ],
      }),
      EMPTY,
      context(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.isFirstCloseOfDay).toBe(true);
    expect(result.value.observations.map((o) => o.metricKey)).toEqual([
      'mind.mood',
      'body.sleep.duration',
      CLOSE_COMPLETION_METRIC,
    ]);
    expect(result.value.observations.every((o) => o.observedAt === NOW)).toBe(true);
    expect(result.value.observations.every((o) => o.observedZone === ZONE)).toBe(true);
    expect(result.value.unchanged).toEqual([]);
  });

  /**
   * §4.0: "Every field is optional. A partial close counts as a close... a
   * system that rejects incomplete data trains you to skip it entirely on a bad
   * day, and bad days are the most clinically interesting days you have."
   */
  it('accepts a close with no answers at all', () => {
    const result = planDailyClose(submission(), EMPTY, context());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.observations).toHaveLength(1);
    expect(result.value.observations[0]?.metricKey).toBe(CLOSE_COMPLETION_METRIC);
    expect(isEmptyPlan(result.value)).toBe(false);
  });

  it('attaches the note to the day’s completion marker', () => {
    const result = planDailyClose(
      submission({ answers: [{ kind: 'note', text: '  woke at 3am, chest tight  ' }] }),
      EMPTY,
      context(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.note).toMatchObject({
      content: 'woke at 3am, chest tight',
      entityType: 'observation',
      entityId: result.value.completionObservationId,
      isNew: true,
    });
  });
});

describe('planDailyClose — re-submitting the same day', () => {
  const existingMood: ExistingCloseState = {
    observations: [
      { id: 'obs-mood', metricKey: 'mind.mood', value: '4.000000', valueText: null },
      { id: 'obs-closed', metricKey: CLOSE_COMPLETION_METRIC, value: '1.000000', valueText: null },
    ],
    medicationEvents: [],
    note: null,
  };

  /**
   * The 21:00-then-23:30 case. §9.1 makes the second submission a supersession
   * — new row, old row pointing at it, both surviving — rather than an edit.
   */
  it('supersedes a changed answer instead of editing it', () => {
    const result = planDailyClose(
      submission({
        answers: [{ kind: 'metric', metricKey: 'mind.mood', value: { kind: 'integer', value: 2 } }],
      }),
      existingMood,
      context(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.observations).toHaveLength(1);
    expect(result.value.observations[0]?.supersedes).toEqual({
      id: 'obs-mood',
      reason: CLOSE_REVISION_REASON,
    });
  });

  /**
   * Without this, a replayed outbox entry would build a correction chain of
   * identical numbers — noise in the append-only log, and a "how many times did
   * I revise this?" answer that means nothing.
   */
  it('writes nothing for an answer that has not changed', () => {
    const result = planDailyClose(
      submission({
        answers: [{ kind: 'metric', metricKey: 'mind.mood', value: { kind: 'integer', value: 4 } }],
      }),
      existingMood,
      context(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.observations).toEqual([]);
    expect(result.value.unchanged).toEqual(['mind.mood']);
    expect(isEmptyPlan(result.value)).toBe(true);
  });

  /**
   * The comparison has to be by decimal value, not by string: `numeric(20,6)`
   * reads a stored `1` back as `1.000000`. A string comparison would find every
   * boolean "changed" on every re-submission.
   */
  it('compares by value rather than by string representation', () => {
    const oddlyScaled: ExistingCloseState = {
      ...existingMood,
      observations: [{ id: 'obs-mood', metricKey: 'mind.mood', value: '4', valueText: null }],
    };
    const result = planDailyClose(
      submission({
        answers: [{ kind: 'metric', metricKey: 'mind.mood', value: { kind: 'integer', value: 4 } }],
      }),
      oddlyScaled,
      context(),
    );
    expect(result.ok && result.value.unchanged).toEqual(['mind.mood']);
  });

  /**
   * §1.5: "Compounding Days is the count of these in the trailing 90." A second
   * marker on the same day would double-count that day forever.
   */
  it('does not write a second completion marker', () => {
    const result = planDailyClose(
      submission({
        answers: [{ kind: 'metric', metricKey: 'mind.energy', value: { kind: 'integer', value: 3 } }],
      }),
      existingMood,
      context(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.isFirstCloseOfDay).toBe(false);
    expect(result.value.observations.map((o) => o.metricKey)).toEqual(['mind.energy']);
    expect(result.value.completionObservationId).toBe('obs-closed');
  });

  it('edits an existing note in place rather than superseding it', () => {
    const withNote: ExistingCloseState = { ...existingMood, note: { id: 'note-1', content: 'old line' } };
    const result = planDailyClose(
      submission({ answers: [{ kind: 'note', text: 'new line' }] }),
      withNote,
      context(),
    );

    expect(result.ok && result.value.note).toMatchObject({ id: 'note-1', content: 'new line', isNew: false });
  });

  it('leaves an unchanged note alone', () => {
    const withNote: ExistingCloseState = { ...existingMood, note: { id: 'note-1', content: 'same line' } };
    const result = planDailyClose(
      submission({ answers: [{ kind: 'note', text: 'same line' }] }),
      withNote,
      context(),
    );
    expect(result.ok && result.value.note).toBeNull();
    expect(result.ok && result.value.noteRemovalId).toBeNull();
  });

  it('tombstones a note the operator cleared', () => {
    const withNote: ExistingCloseState = { ...existingMood, note: { id: 'note-1', content: 'old line' } };
    const result = planDailyClose(submission({ answers: [{ kind: 'note', text: '   ' }] }), withNote, context());

    expect(result.ok && result.value.noteRemovalId).toBe('note-1');
    expect(result.ok && result.value.note).toBeNull();
  });
});

describe('planDailyClose — medication toggles', () => {
  it('records an adherence event per toggle', () => {
    const result = planDailyClose(
      submission({
        answers: [
          { kind: 'medication', medicationId: 'med-1', taken: true },
          { kind: 'medication', medicationId: 'med-2', taken: false },
        ],
      }),
      EMPTY,
      context(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.medicationEvents).toHaveLength(2);
    expect(result.value.medicationEvents[0]).toMatchObject({
      medicationId: 'med-1',
      kind: 'taken',
      takenAt: NOW,
      zone: ZONE,
      replaces: null,
    });
    // `medication_event_taken_paired` requires a null takenAt for a skip.
    expect(result.value.medicationEvents[1]).toMatchObject({ kind: 'skipped', takenAt: null });
  });

  it('replaces an event whose answer changed and skips one that did not', () => {
    const existing: ExistingCloseState = {
      ...EMPTY,
      medicationEvents: [
        { id: 'evt-1', medicationId: 'med-1', kind: 'taken' },
        { id: 'evt-2', medicationId: 'med-2', kind: 'skipped' },
      ],
    };

    const result = planDailyClose(
      submission({
        answers: [
          { kind: 'medication', medicationId: 'med-1', taken: true },
          { kind: 'medication', medicationId: 'med-2', taken: true },
        ],
      }),
      existing,
      context(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.medicationEvents).toHaveLength(1);
    expect(result.value.medicationEvents[0]).toMatchObject({ medicationId: 'med-2', replaces: 'evt-2' });
  });
});

describe('planDailyClose — refusals', () => {
  it('refuses a zone that is not an IANA name', () => {
    const result = planDailyClose(submission({ zone: 'IST' }), EMPTY, context());
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('close_zone_invalid');
  });

  it('refuses a malformed day key', () => {
    const result = planDailyClose(submission({ dayKey: '3 August' }), EMPTY, context());
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('close_day_invalid');
  });

  /**
   * §9.1's append-only record has no mechanism for un-recording a day that has
   * not happened, and the plausible cause is a phone with a wrong clock — the
   * same fault the HLC's drift ceiling guards against.
   */
  it('refuses to close a day that has not happened', () => {
    const result = planDailyClose(submission({ dayKey: '2026-08-09' }), EMPTY, context());
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.kind).toBe('precondition_failed');
    expect(!result.ok && result.error.code).toBe('close_future_day');
  });

  it('refuses an unregistered metric', () => {
    const result = planDailyClose(
      submission({
        answers: [{ kind: 'metric', metricKey: 'invented.metric', value: { kind: 'integer', value: 1 } }],
      }),
      EMPTY,
      context(),
    );
    expect(!result.ok && result.error.code).toBe('metric_not_registered');
  });

  /**
   * The Close writes Close metrics. Letting any metric in through the same door
   * would make the eleven-element budget meaningless — the form would stay
   * small while the endpoint stayed wide open.
   */
  it('refuses a metric that is not part of the Close', () => {
    const result = planDailyClose(
      submission({
        answers: [{ kind: 'metric', metricKey: 'body.weight', value: { kind: 'number', value: '74.2' } }],
      }),
      EMPTY,
      context(),
    );
    expect(result.ok).toBe(false);
    if (result.ok || result.error.kind !== 'validation') throw new Error('expected a validation error');
    expect(result.error.issues[0]?.message).toMatch(/not a Daily Close metric/);
  });

  it('refuses the same metric answered twice', () => {
    const result = planDailyClose(
      submission({
        answers: [
          { kind: 'metric', metricKey: 'mind.mood', value: { kind: 'integer', value: 4 } },
          { kind: 'metric', metricKey: 'mind.mood', value: { kind: 'integer', value: 2 } },
        ],
      }),
      EMPTY,
      context(),
    );
    expect(result.ok).toBe(false);
  });

  it('refuses more than one note line', () => {
    const result = planDailyClose(
      submission({
        answers: [
          { kind: 'note', text: 'first' },
          { kind: 'note', text: 'second' },
        ],
      }),
      EMPTY,
      context(),
    );
    expect(result.ok).toBe(false);
  });

  it('accumulates value problems rather than reporting one per round trip', () => {
    const result = planDailyClose(
      submission({
        answers: [
          { kind: 'metric', metricKey: 'mind.mood', value: { kind: 'integer', value: 9 } },
          { kind: 'metric', metricKey: 'mind.energy', value: { kind: 'integer', value: 0 } },
        ],
      }),
      EMPTY,
      context(),
    );
    expect(result.ok).toBe(false);
    if (result.ok || result.error.kind !== 'validation') throw new Error('expected a validation error');
    expect(result.error.issues).toHaveLength(2);
  });
});
