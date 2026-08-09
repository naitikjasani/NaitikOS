import { describe, expect, it } from 'vitest';

import type { Routine, RoutineLog, RoutineStep } from './adherence';
import {
  dayAdherence,
  isRoutineDue,
  requiredSteps,
  windowAdherence,
  windowDayKeys,
} from './adherence';

const routine: Routine = {
  id: 'rt-pm',
  kind: 'skincare',
  period: 'pm',
  name: 'Evening routine',
  isActive: true,
  expectedAt: '22:00',
};

const steps: RoutineStep[] = [
  { id: 's1', routineId: 'rt-pm', orderIndex: 0, label: 'Cleanse', productId: null, medicationId: null, isOptional: false, instructions: null },
  { id: 's2', routineId: 'rt-pm', orderIndex: 1, label: 'Treat', productId: null, medicationId: null, isOptional: false, instructions: null },
  { id: 's3', routineId: 'rt-pm', orderIndex: 2, label: 'Moisturise', productId: null, medicationId: null, isOptional: false, instructions: null },
  { id: 's4', routineId: 'rt-pm', orderIndex: 3, label: 'Lip balm', productId: null, medicationId: null, isOptional: true, instructions: null },
];

function log(stepId: string | null, dayKey: string, status: RoutineLog['status'] = 'done'): RoutineLog {
  return {
    id: `${stepId ?? 'all'}-${dayKey}`,
    routineId: 'rt-pm',
    stepId,
    occurredOn: dayKey,
    completedAt: `${dayKey}T16:30:00.000Z`,
    zone: 'Asia/Kolkata',
    status,
    note: null,
  };
}

describe('requiredSteps', () => {
  it('drops optional steps from both sides of the ratio', () => {
    expect(requiredSteps(steps).map((step) => step.id)).toEqual(['s1', 's2', 's3']);
  });
});

describe('dayAdherence', () => {
  it('counts a partial step as completed and reports it separately', () => {
    const day = dayAdherence(routine, steps, [log('s1', '2026-08-24'), log('s2', '2026-08-24', 'partial')], '2026-08-24');
    expect(day.completed).toBe(2);
    expect(day.partial).toBe(1);
    expect(day.ratio).toBeCloseTo(2 / 3, 10);
  });

  it('has no ratio on an unlogged day', () => {
    const day = dayAdherence(routine, steps, [], '2026-08-24');
    expect(day.recorded).toBe(false);
    expect(day.ratio).toBeNull();
    expect(day.unlogged).toEqual(['s1', 's2', 's3']);
  });

  it('counts a skipped step but does not credit it', () => {
    const day = dayAdherence(routine, steps, [log('s1', '2026-08-24'), log('s2', '2026-08-24', 'skipped')], '2026-08-24');
    expect(day.completed).toBe(1);
    expect(day.skipped).toBe(1);
  });

  it('ignores an optional step’s log entirely', () => {
    const day = dayAdherence(routine, steps, [log('s4', '2026-08-24')], '2026-08-24');
    expect(day.completed).toBe(0);
    // The day still counts as recorded — something was logged.
    expect(day.recorded).toBe(true);
  });

  it('does not double-count a step logged twice', () => {
    const day = dayAdherence(
      routine,
      steps,
      [log('s1', '2026-08-24'), { ...log('s1', '2026-08-24'), id: 'dup' }],
      '2026-08-24',
    );
    expect(day.completed).toBe(1);
  });

  it('ignores a whole-routine log for the step ratio', () => {
    const day = dayAdherence(routine, steps, [log(null, '2026-08-24')], '2026-08-24');
    expect(day.completed).toBe(0);
    expect(day.recorded).toBe(true);
  });

  it('has no ratio for a routine with no required steps', () => {
    const optionalOnly = steps.filter((step) => step.isOptional);
    expect(dayAdherence(routine, optionalOnly, [log('s4', '2026-08-24')], '2026-08-24').ratio).toBeNull();
  });
});

describe('windowAdherence', () => {
  const dayKeys = windowDayKeys('2026-08-24', 10);

  it('never treats an unlogged day as a miss', () => {
    const logs = dayKeys.slice(0, 3).flatMap((day) => [log('s1', day), log('s2', day), log('s3', day)]);
    const result = windowAdherence(routine, steps, logs, dayKeys);

    expect(result.recordedDays).toBe(3);
    expect(result.unrecordedDays).toBe(7);
    expect(result.ratio).toBe(1);
    expect(result.sentence).toContain('7 days have no log either way');
  });

  it('has no ratio when nothing was logged at all', () => {
    const result = windowAdherence(routine, steps, [], dayKeys);
    expect(result.ratio).toBeNull();
    expect(result.sentence).toBe('No steps logged for Evening routine in the last 10 days.');
  });

  it('says so when every day has a log', () => {
    const logs = dayKeys.flatMap((day) => [log('s1', day), log('s2', day), log('s3', day)]);
    expect(windowAdherence(routine, steps, logs, dayKeys).sentence).toContain('Every day in the window has a log');
  });

  it('ends the streak on an unlogged day, unlike the ratio', () => {
    // Complete on every day except the third-from-last.
    const logs = dayKeys
      .filter((day) => day !== dayKeys[dayKeys.length - 3])
      .flatMap((day) => [log('s1', day), log('s2', day), log('s3', day)]);

    const result = windowAdherence(routine, steps, logs, dayKeys);
    expect(result.currentStreak).toBe(2);
    // The ratio is untouched by the gap.
    expect(result.ratio).toBe(1);
  });

  it('has a zero streak when the most recent day is incomplete', () => {
    const logs = dayKeys.flatMap((day) => [log('s1', day)]);
    expect(windowAdherence(routine, steps, logs, dayKeys).currentStreak).toBe(0);
  });
});

describe('windowDayKeys', () => {
  it('returns the window oldest first, inclusive of the end day', () => {
    expect(windowDayKeys('2026-03-02', 4)).toEqual(['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02']);
  });

  it('is empty for a non-positive window or a bad key', () => {
    expect(windowDayKeys('2026-03-02', 0)).toEqual([]);
    expect(windowDayKeys('nope', 5)).toEqual([]);
  });
});

describe('isRoutineDue', () => {
  it('is due within the tolerance either side', () => {
    expect(isRoutineDue(routine, '21:30')).toBe(true);
    expect(isRoutineDue(routine, '23:30')).toBe(true);
    expect(isRoutineDue(routine, '18:00')).toBe(false);
  });

  it('is never due when inactive, as-needed, or without an expected time', () => {
    expect(isRoutineDue({ ...routine, isActive: false }, '22:00')).toBe(false);
    expect(isRoutineDue({ ...routine, period: 'as_needed' }, '22:00')).toBe(false);
    expect(isRoutineDue({ ...routine, expectedAt: null }, '22:00')).toBe(false);
  });

  it('is not due for an unparseable time on either side', () => {
    expect(isRoutineDue({ ...routine, expectedAt: '10pm' }, '22:00')).toBe(false);
    expect(isRoutineDue(routine, '99:99')).toBe(false);
  });
});
