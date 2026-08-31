import { describe, expect, it } from 'vitest';

import {
  SOON_DAYS,
  STALE_TASK_DAYS,
  bucketTasks,
  closedPerDay,
  staleTasks,
  validateTask,
  type Task,
} from './task';

const base: Task = {
  id: '01900000-0000-7000-8000-000000000001',
  title: 'Write the migration',
  note: null,
  status: 'open',
  projectId: null,
  goalId: null,
  linkedEntityType: null,
  linkedEntityId: null,
  dueDayKey: null,
  completedAt: null,
  completedDayKey: null,
  droppedReason: null,
  createdAt: '2026-08-01T09:00:00.000Z',
};

const task = (overrides: Partial<Task>): Task => ({ ...base, ...overrides });

describe('validateTask', () => {
  it('refuses an empty title', () => {
    const result = validateTask({ id: base.id, title: '   ' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('task_title_empty');
  });

  it('refuses a due day key that is not a day key', () => {
    const result = validateTask({ id: base.id, title: 'x', dueDayKey: '30-08-2026' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('task_due_invalid');
  });

  it('refuses half a link', () => {
    const result = validateTask({ id: base.id, title: 'x', linkedEntityId: base.id });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('task_link_partial');
  });

  it('accepts a whole link', () => {
    expect(
      validateTask({ id: base.id, title: 'x', linkedEntityType: 'appointment', linkedEntityId: base.id }).ok,
    ).toBe(true);
  });

  it('accepts no link at all', () => {
    expect(validateTask({ id: base.id, title: 'x' }).ok).toBe(true);
  });
});

describe('bucketTasks', () => {
  const today = '2026-08-30';

  it('separates overdue, today, soon and undated', () => {
    const buckets = bucketTasks(
      [
        task({ id: 'a', dueDayKey: '2026-08-28' }),
        task({ id: 'b', dueDayKey: today }),
        task({ id: 'c', dueDayKey: '2026-09-02' }),
        task({ id: 'd', dueDayKey: null }),
      ],
      today,
    );

    expect(buckets.overdue.map((t) => t.id)).toEqual(['a']);
    expect(buckets.today.map((t) => t.id)).toEqual(['b']);
    expect(buckets.soon.map((t) => t.id)).toEqual(['c']);
    expect(buckets.undated.map((t) => t.id)).toEqual(['d']);
  });

  it('puts a task beyond the soon horizon back into undated rather than inventing a fifth bucket', () => {
    const far = task({ id: 'far', dueDayKey: '2026-12-25' });
    const buckets = bucketTasks([far], today);
    expect(buckets.soon).toEqual([]);
    expect(buckets.undated.map((t) => t.id)).toEqual(['far']);
  });

  it('treats the last day of the soon window as soon', () => {
    const edge = task({ id: 'edge', dueDayKey: '2026-09-06' });
    expect(SOON_DAYS).toBe(7);
    expect(bucketTasks([edge], today).soon.map((t) => t.id)).toEqual(['edge']);
  });

  it('excludes closed tasks entirely', () => {
    const buckets = bucketTasks(
      [
        task({ id: 'done', status: 'done', completedAt: '2026-08-29T10:00:00.000Z', completedDayKey: '2026-08-29' }),
        task({ id: 'dropped', status: 'dropped' }),
      ],
      today,
    );
    expect([...buckets.overdue, ...buckets.today, ...buckets.soon, ...buckets.undated]).toEqual([]);
  });

  it('orders the undated bucket oldest first', () => {
    const buckets = bucketTasks(
      [
        task({ id: 'new', createdAt: '2026-08-20T09:00:00.000Z' }),
        task({ id: 'old', createdAt: '2026-01-04T09:00:00.000Z' }),
      ],
      today,
    );
    expect(buckets.undated.map((t) => t.id)).toEqual(['old', 'new']);
  });
});

describe('staleTasks', () => {
  const dayKeyOf = (t: Task): string => t.createdAt.slice(0, 10);

  it('finds an undated open task older than the threshold', () => {
    const old = task({ id: 'old', createdAt: '2026-01-01T09:00:00.000Z' });
    expect(staleTasks([old], '2026-08-30', dayKeyOf).map((t) => t.id)).toEqual(['old']);
  });

  it('ignores a dated task however old, because a date is an answer', () => {
    const dated = task({ id: 'dated', createdAt: '2026-01-01T09:00:00.000Z', dueDayKey: '2026-01-05' });
    expect(staleTasks([dated], '2026-08-30', dayKeyOf)).toEqual([]);
  });

  it('does not flag a task exactly one day short of the threshold', () => {
    const day = new Date(Date.UTC(2026, 7, 30) - (STALE_TASK_DAYS - 1) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const almost = task({ id: 'almost', createdAt: `${day}T09:00:00.000Z` });
    expect(staleTasks([almost], '2026-08-30', dayKeyOf)).toEqual([]);
  });
});

describe('closedPerDay', () => {
  it('counts closures against the day key and reports zero for empty days', () => {
    const rows = closedPerDay(
      [
        task({ id: '1', status: 'done', completedDayKey: '2026-08-29' }),
        task({ id: '2', status: 'done', completedDayKey: '2026-08-29' }),
        task({ id: '3', status: 'open' }),
      ],
      ['2026-08-28', '2026-08-29', '2026-08-30'],
    );
    expect(rows).toEqual([
      { dayKey: '2026-08-28', closed: 0 },
      { dayKey: '2026-08-29', closed: 2 },
      { dayKey: '2026-08-30', closed: 0 },
    ]);
  });

  it('ignores a dropped task even when it carries a completion day', () => {
    const rows = closedPerDay([task({ status: 'dropped', completedDayKey: '2026-08-29' })], ['2026-08-29']);
    expect(rows).toEqual([{ dayKey: '2026-08-29', closed: 0 }]);
  });
});
