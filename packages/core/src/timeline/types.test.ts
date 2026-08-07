/**
 * Query normalisation.
 *
 * Small, and load-bearing for a reason that is easy to miss: this runs before the
 * store sees a query, so it is the only thing stopping a caller from asking for
 * 100,000 rows. On a single-user deployment there is no read rate limit to fall
 * back on, and a five-year timeline loaded in one page is a memory exhaustion in
 * one request.
 */

import { describe, expect, it } from 'vitest';

import { TIMELINE_MAX_PAGE_SIZE, TIMELINE_PAGE_SIZE, normaliseQuery } from './types';

describe('normaliseQuery', () => {
  it('applies the defaults', () => {
    const query = normaliseQuery({});

    expect(query.limit).toBe(TIMELINE_PAGE_SIZE);
    // Newest first — the default view.
    expect(query.direction).toBe('backward');
    expect(query.grouping).toBe('none');
    // A workout of forty sets emits forty detail events; including them by default
    // buries the rest of the day.
    expect(query.includeDetail).toBe(false);
  });

  it('clamps an oversized limit', () => {
    expect(normaliseQuery({ limit: 100_000 }).limit).toBe(TIMELINE_MAX_PAGE_SIZE);
  });

  it('raises a non-positive limit to one', () => {
    // `LIMIT 0` returns nothing and looks to the caller like the end of the
    // timeline; a negative limit is a SQL error.
    expect(normaliseQuery({ limit: 0 }).limit).toBe(1);
    expect(normaliseQuery({ limit: -5 }).limit).toBe(1);
  });

  it('keeps a limit inside the range', () => {
    expect(normaliseQuery({ limit: 25 }).limit).toBe(25);
    expect(normaliseQuery({ limit: TIMELINE_MAX_PAGE_SIZE }).limit).toBe(TIMELINE_MAX_PAGE_SIZE);
  });

  it('preserves every filter it does not own', () => {
    const query = normaliseQuery({
      from: '2026-08-01T00:00:00Z',
      until: '2026-08-04T00:00:00Z',
      categories: ['clinical'],
      eventTypes: ['Medication.Taken'],
      clinicalOnly: true,
      withMediaOnly: true,
      search: 'dermatology',
      entity: { type: 'medication', id: 'med-1' },
      afterSequence: 4001,
    });

    expect(query.from).toBe('2026-08-01T00:00:00Z');
    expect(query.until).toBe('2026-08-04T00:00:00Z');
    expect(query.categories).toEqual(['clinical']);
    expect(query.eventTypes).toEqual(['Medication.Taken']);
    expect(query.clinicalOnly).toBe(true);
    expect(query.withMediaOnly).toBe(true);
    expect(query.search).toBe('dermatology');
    expect(query.entity).toEqual({ type: 'medication', id: 'med-1' });
    expect(query.afterSequence).toBe(4001);
  });

  it('respects explicit overrides of the defaults', () => {
    const query = normaliseQuery({ direction: 'forward', grouping: 'day', includeDetail: true });

    expect(query.direction).toBe('forward');
    expect(query.grouping).toBe('day');
    expect(query.includeDetail).toBe(true);
  });

  it('does not mutate the input', () => {
    const original = { limit: 100_000 };
    normaliseQuery(original);
    expect(original.limit).toBe(100_000);
  });

  it('keeps the page size well under the max, so the default is cheap', () => {
    expect(TIMELINE_PAGE_SIZE).toBeLessThan(TIMELINE_MAX_PAGE_SIZE);
  });
});
