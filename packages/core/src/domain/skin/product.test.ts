import { describe, expect, it } from 'vitest';

import type { ProductEvent } from './product';
import {
  changesBefore,
  daysSinceIntroduction,
  isActiveOn,
  productLabel,
  reactionHistory,
  usePeriods,
} from './product';

const ZONE = 'Asia/Kolkata';

function event(
  kind: ProductEvent['kind'],
  dayKey: string,
  overrides: Partial<ProductEvent> = {},
): ProductEvent {
  return {
    id: `${kind}-${dayKey}`,
    productId: 'p1',
    kind,
    occurredAt: `${dayKey}T06:00:00.000Z`,
    zone: ZONE,
    reactionDescription: null,
    reactionSeverity: null,
    note: null,
    ...overrides,
  };
}

describe('productLabel', () => {
  it('joins brand and name, and copes without a brand', () => {
    expect(
      productLabel({ id: 'p1', name: 'Moisturising Lotion', brand: 'CeraVe', category: null, keyIngredients: [], isActive: true, notes: null }),
    ).toBe('CeraVe · Moisturising Lotion');
    expect(
      productLabel({ id: 'p1', name: 'Own blend', brand: null, category: null, keyIngredients: [], isActive: false, notes: null }),
    ).toBe('Own blend');
  });
});

describe('isActiveOn', () => {
  const events = [
    event('introduced', '2026-03-01'),
    event('discontinued', '2026-04-15'),
    event('repurchased', '2026-06-01'),
  ];

  it('replays the events rather than trusting a cached flag', () => {
    expect(isActiveOn(events, 'p1', '2026-02-28', ZONE)).toBe(false);
    expect(isActiveOn(events, 'p1', '2026-03-02', ZONE)).toBe(true);
    expect(isActiveOn(events, 'p1', '2026-05-01', ZONE)).toBe(false);
    expect(isActiveOn(events, 'p1', '2026-07-01', ZONE)).toBe(true);
  });

  it('does not infer a discontinuation from a reaction', () => {
    const withReaction = [...events.slice(0, 1), event('reaction', '2026-03-10')];
    expect(isActiveOn(withReaction, 'p1', '2026-03-20', ZONE)).toBe(true);
  });

  it('ignores other products entirely', () => {
    expect(isActiveOn(events, 'p2', '2026-07-01', ZONE)).toBe(false);
  });

  it('falls back to the supplied zone for an event that carries none', () => {
    expect(isActiveOn([event('introduced', '2026-03-01', { zone: null })], 'p1', '2026-03-02', ZONE)).toBe(true);
  });

  it('orders two events on the same day by their instants', () => {
    // Introduced at 06:00 and discontinued at 18:00 on the same day: the
    // discontinuation has to win, and it only does if the tie-break looks past
    // the day key.
    const sameDay = [
      event('discontinued', '2026-03-01', { occurredAt: '2026-03-01T18:00:00.000Z' }),
      event('introduced', '2026-03-01', { occurredAt: '2026-03-01T06:00:00.000Z' }),
    ];
    expect(isActiveOn(sameDay, 'p1', '2026-03-05', ZONE)).toBe(false);
  });
});

describe('usePeriods', () => {
  it('produces one period per introduce/stop pair, with the last left open', () => {
    const periods = usePeriods(
      [
        event('introduced', '2026-03-01'),
        event('finished', '2026-04-15'),
        event('repurchased', '2026-06-01'),
      ],
      'p1',
      ZONE,
    );
    expect(periods).toEqual([
      { productId: 'p1', fromDayKey: '2026-03-01', toDayKey: '2026-04-15' },
      { productId: 'p1', fromDayKey: '2026-06-01', toDayKey: null },
    ]);
  });

  it('ignores a stop with no matching start', () => {
    expect(usePeriods([event('discontinued', '2026-04-01')], 'p1', ZONE)).toEqual([]);
  });

  it('does not restart an already-open period', () => {
    const periods = usePeriods(
      [event('introduced', '2026-03-01'), event('repurchased', '2026-03-20')],
      'p1',
      ZONE,
    );
    expect(periods).toEqual([{ productId: 'p1', fromDayKey: '2026-03-01', toDayKey: null }]);
  });
});

describe('daysSinceIntroduction', () => {
  it('counts from the current period’s start', () => {
    expect(daysSinceIntroduction([event('introduced', '2026-08-15')], 'p1', '2026-08-24', ZONE)).toBe(9);
  });

  it('is null once the product has been stopped', () => {
    expect(
      daysSinceIntroduction(
        [event('introduced', '2026-03-01'), event('discontinued', '2026-04-01')],
        'p1',
        '2026-08-24',
        ZONE,
      ),
    ).toBeNull();
  });

  it('is null when it was never introduced', () => {
    expect(daysSinceIntroduction([], 'p1', '2026-08-24', ZONE)).toBeNull();
  });

  it('is null for a day before the introduction', () => {
    expect(daysSinceIntroduction([event('introduced', '2026-08-15')], 'p1', '2026-08-01', ZONE)).toBeNull();
  });
});

describe('reactionHistory', () => {
  it('returns reactions only, most recent first', () => {
    const history = reactionHistory(
      [
        event('introduced', '2026-03-01'),
        event('reaction', '2026-03-10', { reactionDescription: 'stinging', reactionSeverity: 'mild' }),
        event('reaction', '2026-05-02', { reactionDescription: 'redness', reactionSeverity: 'moderate' }),
      ],
      ZONE,
    );
    expect(history.map((item) => item.dayKey)).toEqual(['2026-05-02', '2026-03-10']);
    expect(history[0]?.severity).toBe('moderate');
  });

  it('falls back to the supplied zone when the event has none', () => {
    const history = reactionHistory([event('reaction', '2026-03-10', { zone: null })], ZONE);
    expect(history[0]?.dayKey).toBe('2026-03-10');
  });
});

describe('changesBefore', () => {
  it('lists what changed in the window, nearest first, with no ranking', () => {
    const changes = changesBefore(
      [
        event('introduced', '2026-08-20'),
        event('discontinued', '2026-08-10', { productId: 'p2' }),
        event('introduced', '2026-06-01', { productId: 'p3' }),
        event('reaction', '2026-08-22'),
      ],
      '2026-08-24',
      ZONE,
    );

    expect(changes.map((change) => [change.productId, change.daysBefore])).toEqual([
      ['p1', 4],
      ['p2', 14],
    ]);
    // No score, no rank, no suspicion — see the header of product.ts.
    expect(Object.keys(changes[0] ?? {}).sort()).toEqual(['dayKey', 'daysBefore', 'kind', 'productId']);
  });

  it('excludes changes after the anchor day', () => {
    expect(changesBefore([event('introduced', '2026-08-30')], '2026-08-24', ZONE)).toEqual([]);
  });

  it('is empty for a malformed anchor', () => {
    expect(changesBefore([event('introduced', '2026-08-20')], 'not-a-day', ZONE)).toEqual([]);
  });

  it('honours a custom window', () => {
    expect(changesBefore([event('introduced', '2026-08-20')], '2026-08-24', ZONE, 3)).toEqual([]);
  });
});
