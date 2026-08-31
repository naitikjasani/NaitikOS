import { describe, expect, it } from 'vitest';

import {
  describeProgress,
  learningProgress,
  queueOrder,
  skillCrossover,
  validateLearningItem,
  type LearningItem,
} from './learning';

const base: LearningItem = {
  id: '01900000-0000-7000-8000-000000000001',
  kind: 'book',
  title: 'Designing Data-Intensive Applications',
  author: 'Kleppmann',
  url: null,
  status: 'in_progress',
  totalUnits: 600,
  completedUnits: 150,
  unitLabel: 'pages',
  startedAt: '2026-06-01T12:00:00.000Z',
  finishedAt: null,
  abandonedReason: null,
  synthesis: null,
  skills: ['Postgres'],
};

const item = (overrides: Partial<LearningItem>): LearningItem => ({ ...base, ...overrides });

describe('validateLearningItem', () => {
  it('refuses an empty title', () => {
    const result = validateLearningItem({ id: base.id, kind: 'book', title: '  ' });
    expect(result.ok).toBe(false);
  });

  it('refuses a zero or negative total', () => {
    const result = validateLearningItem({ id: base.id, kind: 'book', title: 'x', totalUnits: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('learning_total_invalid');
  });

  it('accepts an item with no total at all', () => {
    expect(validateLearningItem({ id: base.id, kind: 'article', title: 'x' }).ok).toBe(true);
  });
});

describe('learningProgress', () => {
  it('is a fraction of the declared total', () => {
    expect(learningProgress(item({ totalUnits: 200, completedUnits: 50 }))).toBe(0.25);
  });

  it('is null — not zero — when no total was declared', () => {
    expect(learningProgress(item({ totalUnits: null, completedUnits: 40 }))).toBeNull();
  });

  it('clamps rather than exceeding one, so a miscount cannot draw past the end', () => {
    expect(learningProgress(item({ totalUnits: 100, completedUnits: 140 }))).toBe(1);
  });
});

describe('describeProgress', () => {
  it('never renders 0% for an unmeasured item', () => {
    expect(describeProgress(item({ totalUnits: null, completedUnits: null, status: 'in_progress' }))).toBe(
      'No progress recorded',
    );
  });

  it('reports raw units when there is a count but no total', () => {
    expect(describeProgress(item({ totalUnits: null, completedUnits: 40 }))).toBe('40 pages in');
  });

  it('falls back to the kind default when no unit label was set', () => {
    expect(describeProgress(item({ unitLabel: null, kind: 'course', totalUnits: null, completedUnits: 3 }))).toBe(
      '3 lessons in',
    );
  });

  it('says "not started" for a queued item rather than nothing', () => {
    expect(
      describeProgress(item({ status: 'queued', totalUnits: null, completedUnits: null })),
    ).toBe('Not started');
  });
});

describe('queueOrder', () => {
  it('puts in-progress first, then queued, then closed', () => {
    const ordered = queueOrder([
      item({ id: 'd', status: 'abandoned' }),
      item({ id: 'c', status: 'finished' }),
      item({ id: 'b', status: 'queued' }),
      item({ id: 'a', status: 'in_progress' }),
    ]);
    expect(ordered.map((entry) => entry.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('keeps insertion order within a group rather than resorting by recency', () => {
    const ordered = queueOrder([
      item({ id: '2', status: 'queued' }),
      item({ id: '1', status: 'queued' }),
    ]);
    expect(ordered.map((entry) => entry.id)).toEqual(['1', '2']);
  });
});

describe('skillCrossover', () => {
  it('does not count a queued item as study', () => {
    const crossover = skillCrossover([item({ status: 'queued', skills: ['Rust'] })], []);
    expect(crossover.studiedNotApplied).toEqual([]);
  });

  it('separates studied, applied, and both — case-insensitively', () => {
    const crossover = skillCrossover(
      [
        item({ id: 'a', status: 'finished', skills: ['Postgres', 'Rust'] }),
        item({ id: 'b', status: 'in_progress', skills: ['temporal modelling'] }),
      ],
      ['postgres', 'Kubernetes'],
    );

    expect(crossover.both).toEqual(['postgres']);
    expect(crossover.studiedNotApplied).toEqual(['rust', 'temporal modelling']);
    expect(crossover.appliedNotStudied).toEqual(['kubernetes']);
  });
});
