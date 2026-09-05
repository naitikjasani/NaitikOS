/**
 * The Life Timeline's geometry (§10.8).
 *
 * The interesting cases are all about *not* asserting things: an open chapter
 * must not acquire an end date, an empty record must not acquire an axis, and
 * two overlapping chapters must not be collapsed onto one line where one hides
 * the other.
 */

import { describe, expect, it } from 'vitest';

import type { LifeEvent, LifeSpan } from './span';
import { boundsFor, layoutSpans, positionOf, spanExtent, validateEvent, validateSpan } from './span';

const NOW = '2026-09-05T12:00:00.000Z';

function span(overrides: Partial<LifeSpan> & { readonly id: string; readonly startedAt: string }): LifeSpan {
  return {
    kind: 'chapter',
    title: overrides.id,
    description: null,
    endedAt: null,
    parentId: null,
    slot: null,
    ...overrides,
  };
}

function event(id: string, occurredAt: string): LifeEvent {
  return { id, title: id, description: null, occurredAt, spanId: null, significance: null };
}

describe('validateSpan', () => {
  it('refuses a span that ends before it starts', () => {
    const result = validateSpan({
      id: 'a',
      kind: 'chapter',
      title: 'Backwards',
      startedAt: '2024-01-01T00:00:00.000Z',
      endedAt: '2023-01-01T00:00:00.000Z',
    });
    expect(result.ok).toBe(false);
  });

  it('accepts a span with no end — that is the current chapter, not an error', () => {
    const result = validateSpan({
      id: 'a',
      kind: 'chapter',
      title: 'Ongoing',
      startedAt: '2024-01-01T00:00:00.000Z',
    });
    expect(result.ok).toBe(true);
  });

  it('refuses a palette slot outside the eight the theme defines', () => {
    const result = validateSpan({
      id: 'a',
      kind: 'chapter',
      title: 'Nine',
      startedAt: '2024-01-01T00:00:00.000Z',
      slot: 9,
    });
    expect(result.ok).toBe(false);
  });

  it('refuses a nested era', () => {
    const result = validateSpan({
      id: 'a',
      kind: 'era',
      title: 'Inside another',
      startedAt: '2024-01-01T00:00:00.000Z',
      parentId: 'b',
    });
    expect(result.ok).toBe(false);
    /* A chapter inside an era is the whole point of `parentId`, so the rule has
     * to be about the kind rather than about the column. */
    expect(validateSpan({ id: 'c', kind: 'chapter', title: 'In', startedAt: '2024-01-01T00:00:00.000Z', parentId: 'b' }).ok).toBe(true);
  });

  it('refuses an empty name', () => {
    expect(validateSpan({ id: 'a', kind: 'era', title: '   ', startedAt: NOW }).ok).toBe(false);
  });
});

describe('validateEvent', () => {
  it('refuses a significance outside 1–5', () => {
    expect(validateEvent({ id: 'e', title: 'Huge', occurredAt: NOW, significance: 7 }).ok).toBe(false);
    expect(validateEvent({ id: 'e', title: 'Huge', occurredAt: NOW, significance: 5 }).ok).toBe(true);
  });

  it('refuses a non-instant', () => {
    expect(validateEvent({ id: 'e', title: 'When?', occurredAt: 'last spring' }).ok).toBe(false);
  });
});

describe('spanExtent', () => {
  it('runs an open span to now without giving it an end date', () => {
    const open = span({ id: 'open', startedAt: '2024-01-01T00:00:00.000Z' });
    const extent = spanExtent(open, NOW);

    expect(extent.open).toBe(true);
    expect(extent.endsAt).toBe(NOW);
    /* The record is unchanged. `endedAt` is a fact this row does not have, and
     * the layout borrowing today's date must not write it back. */
    expect(open.endedAt).toBeNull();
  });

  it('leaves a closed span alone', () => {
    const closed = span({
      id: 'closed',
      startedAt: '2024-01-01T00:00:00.000Z',
      endedAt: '2025-01-01T00:00:00.000Z',
    });
    expect(spanExtent(closed, NOW)).toEqual({
      startedAt: '2024-01-01T00:00:00.000Z',
      endsAt: '2025-01-01T00:00:00.000Z',
      open: false,
    });
  });
});

describe('layoutSpans', () => {
  it('puts two overlapping chapters in different lanes', () => {
    /* The case §10.8 is built around: a job and a relationship that ran at the
     * same time. One line would hide one of them. */
    const job = span({
      id: 'job',
      title: 'The job',
      startedAt: '2021-03-01T00:00:00.000Z',
      endedAt: '2025-06-30T00:00:00.000Z',
    });
    const relationship = span({
      id: 'relationship',
      title: 'The relationship',
      startedAt: '2023-01-15T00:00:00.000Z',
      endedAt: '2026-02-01T00:00:00.000Z',
    });

    const lanes = layoutSpans([job, relationship], NOW);

    expect(lanes).toHaveLength(2);
    expect(lanes[0]?.spans.map((s) => s.id)).toEqual(['job']);
    expect(lanes[1]?.spans.map((s) => s.id)).toEqual(['relationship']);
  });

  it('reuses a lane for spans that do not overlap', () => {
    const first = span({
      id: 'first',
      startedAt: '2018-01-01T00:00:00.000Z',
      endedAt: '2020-01-01T00:00:00.000Z',
    });
    const second = span({
      id: 'second',
      startedAt: '2021-01-01T00:00:00.000Z',
      endedAt: '2023-01-01T00:00:00.000Z',
    });

    const lanes = layoutSpans([second, first], NOW);
    expect(lanes).toHaveLength(1);
    expect(lanes[0]?.spans.map((s) => s.id)).toEqual(['first', 'second']);
  });

  it('holds a lane open to now for a span with no end', () => {
    const ongoing = span({ id: 'ongoing', startedAt: '2024-01-01T00:00:00.000Z' });
    const later = span({ id: 'later', startedAt: '2025-01-01T00:00:00.000Z' });

    const lanes = layoutSpans([ongoing, later], NOW);
    /* `later` cannot share `ongoing`'s lane, because `ongoing` has not finished
     * — that is exactly what an open span means. */
    expect(lanes).toHaveLength(2);
  });

  it('never mixes an era and a chapter in one lane', () => {
    const era = span({
      id: 'era',
      kind: 'era',
      startedAt: '2010-01-01T00:00:00.000Z',
      endedAt: '2020-01-01T00:00:00.000Z',
    });
    const chapter = span({
      id: 'chapter',
      startedAt: '2021-01-01T00:00:00.000Z',
      endedAt: '2022-01-01T00:00:00.000Z',
    });

    const lanes = layoutSpans([era, chapter], NOW);
    expect(lanes).toHaveLength(2);
    expect(lanes[0]?.spans.map((s) => s.kind)).toEqual(['era']);
    expect(lanes[1]?.spans.map((s) => s.kind)).toEqual(['chapter']);
    // Lane numbers stay contiguous across the two groups.
    expect(lanes.map((lane) => lane.lane)).toEqual([0, 1]);
  });

  it('orders by the instant rather than by the text of it', () => {
    /* `2024-01-01T00:00:00Z` is lexically before `2023-12-31T20:00:00-05:00`
     * and chronologically after it. A string sort gets this backwards. */
    const earlier = span({ id: 'zzz-earlier', startedAt: '2023-12-31T20:00:00-05:00', endedAt: '2024-06-01T00:00:00.000Z' });
    const later = span({ id: 'aaa-later', startedAt: '2024-07-01T00:00:00.000Z', endedAt: '2024-08-01T00:00:00.000Z' });

    const lanes = layoutSpans([later, earlier], NOW);
    expect(lanes).toHaveLength(1);
    expect(lanes[0]?.spans.map((s) => s.id)).toEqual(['zzz-earlier', 'aaa-later']);
  });

  it('returns nothing for nothing', () => {
    expect(layoutSpans([], NOW)).toEqual([]);
  });
});

describe('boundsFor', () => {
  it('invents no range when there is nothing to draw', () => {
    expect(boundsFor([], [], NOW)).toBeNull();
  });

  it('stretches to now for an open span', () => {
    const bounds = boundsFor([span({ id: 'a', startedAt: '2020-01-01T00:00:00.000Z' })], [], NOW);
    expect(bounds?.fromDayKey).toBe('2020-01-01');
    expect(bounds?.toDayKey).toBe('2026-09-05');
    expect(bounds?.years).toBeCloseTo(6.68, 1);
  });

  it('widens for an event outside every span', () => {
    const bounds = boundsFor(
      [span({ id: 'a', startedAt: '2020-01-01T00:00:00.000Z', endedAt: '2021-01-01T00:00:00.000Z' })],
      [event('birth', '1996-04-02T00:00:00.000Z')],
      NOW,
    );
    expect(bounds?.fromDayKey).toBe('1996-04-02');
    expect(bounds?.toDayKey).toBe('2021-01-01');
  });
});

describe('positionOf', () => {
  const bounds = { fromDayKey: '2020-01-01', toDayKey: '2030-01-01', years: 10 };

  it('places the ends at 0 and 1', () => {
    expect(positionOf('2020-01-01T00:00:00.000Z', bounds)).toBe(0);
    expect(positionOf('2030-01-01T00:00:00.000Z', bounds)).toBe(1);
  });

  it('places the middle in the middle', () => {
    expect(positionOf('2025-01-01T00:00:00.000Z', bounds)).toBeCloseTo(0.5, 2);
  });

  it('clamps rather than refusing outside the window', () => {
    expect(positionOf('1990-01-01T00:00:00.000Z', bounds)).toBe(0);
    expect(positionOf('2040-01-01T00:00:00.000Z', bounds)).toBe(1);
  });

  it('returns null only when the instant is not a date at all', () => {
    expect(positionOf('sometime in the nineties', bounds)).toBeNull();
  });

  it('puts everything at the start of a single-day window', () => {
    const point = { fromDayKey: '2026-09-05', toDayKey: '2026-09-05', years: 0 };
    expect(positionOf('2026-09-05T18:00:00.000Z', point)).toBe(0);
  });
});
