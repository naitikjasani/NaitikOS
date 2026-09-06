import { describe, expect, it } from 'vitest';

import {
  findOverlaps,
  nightsAway,
  placeOnDay,
  resolveVisits,
  travelDays,
  validatePlace,
  validateTrip,
  validateVisit,
  visitCovers,
} from './place';
import type { Place, PlaceInput, Visit } from './place';

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function placeInput(over: Partial<PlaceInput> = {}): PlaceInput {
  return { id: 'pl1', name: 'London', kind: 'city', ...over };
}

function visit(id: string, placeId: string, arrivedOn: string, departedOn: string | null = null): Visit {
  return { id, placeId, tripId: null, arrivedOn, departedOn, notes: null };
}

const HOME: Place = {
  id: 'home',
  name: 'Bangalore',
  kind: 'home',
  countryCode: 'IN',
  zone: 'Asia/Kolkata',
  latitude: null,
  longitude: null,
  notes: null,
};

const AWAY: Place = { ...HOME, id: 'london', name: 'London', kind: 'city', countryCode: 'GB', zone: 'Europe/London' };

const PLACES = new Map([
  [HOME.id, HOME],
  [AWAY.id, AWAY],
]);

describe('validatePlace', () => {
  it('upper-cases a country code and refuses a wrong-shaped one', () => {
    expect(unwrap(validatePlace(placeInput({ countryCode: 'gb' }))).countryCode).toBe('GB');
    expect(validatePlace(placeInput({ countryCode: 'GBR' })).ok).toBe(false);
  });

  it('refuses a zone this system does not recognise', () => {
    // The zone is what lets a visit explain a run of foreign observation
    // offsets. A typo leaves the explanation silently unable to match, which
    // looks like missing data rather than like a bug.
    expect(validatePlace(placeInput({ zone: 'Europe/Londen' })).ok).toBe(false);
    expect(unwrap(validatePlace(placeInput({ zone: 'Europe/London' }))).zone).toBe('Europe/London');
  });

  it('bounds coordinates and insists on both or neither', () => {
    expect(validatePlace(placeInput({ latitude: '91', longitude: '0' })).ok).toBe(false);
    expect(validatePlace(placeInput({ latitude: '0', longitude: '181' })).ok).toBe(false);
    // Half a pin renders somewhere real and wrong.
    expect(validatePlace(placeInput({ latitude: '51.5' })).ok).toBe(false);
    expect(unwrap(validatePlace(placeInput({ latitude: '51.5072', longitude: '-0.1276' }))).latitude).toBe('51.5072');
  });

  it('requires a name', () => {
    expect(validatePlace(placeInput({ name: '  ' })).ok).toBe(false);
  });
});

describe('validateTrip', () => {
  const base = { id: 't1', title: 'London', purpose: 'work' as const, startedOn: '2026-09-01' };

  it('accepts an open-ended trip', () => {
    expect(unwrap(validateTrip(base)).endedOn).toBeNull();
  });

  it('refuses an end before the start', () => {
    expect(validateTrip({ ...base, endedOn: '2026-08-31' }).ok).toBe(false);
  });

  it('accepts a one-day trip', () => {
    expect(unwrap(validateTrip({ ...base, endedOn: '2026-09-01' })).endedOn).toBe('2026-09-01');
  });
});

describe('validateVisit', () => {
  const base = { id: 'v1', placeId: 'london', arrivedOn: '2026-09-01' };

  it('refuses a departure before the arrival', () => {
    expect(validateVisit({ ...base, departedOn: '2026-08-31' }).ok).toBe(false);
  });

  it('accepts a same-day visit, which a half-open range could not express', () => {
    expect(unwrap(validateVisit({ ...base, departedOn: '2026-09-01' })).departedOn).toBe('2026-09-01');
  });
});

describe('resolveVisits', () => {
  it('closes an open-ended visit at the next arrival', () => {
    // Home is open-ended by construction — nobody types a departure date for
    // their own house before a weekend away. Taken literally it would overlap
    // every trip ever recorded.
    const resolved = resolveVisits([visit('h', 'home', '2020-01-01'), visit('l', 'london', '2026-09-01', '2026-09-08')]);

    expect(resolved[0]?.to).toBe('2026-09-01');
    expect(resolved[1]?.to).toBe('2026-09-08');
  });

  it('leaves the genuinely current visit open', () => {
    const resolved = resolveVisits([visit('h', 'home', '2020-01-01')]);

    expect(resolved[0]?.to).toBeNull();
  });

  it('sorts by arrival regardless of input order', () => {
    const resolved = resolveVisits([visit('b', 'london', '2026-09-01'), visit('a', 'home', '2020-01-01')]);

    expect(resolved.map((r) => r.visit.id)).toEqual(['a', 'b']);
  });
});

describe('placeOnDay', () => {
  const visits = [
    visit('h1', 'home', '2020-01-01'),
    visit('l', 'london', '2026-09-01', '2026-09-08'),
    visit('h2', 'home', '2026-09-08'),
  ];

  it('answers with the place covering that day', () => {
    expect(placeOnDay(visits, '2026-09-04')?.placeId).toBe('london');
    expect(placeOnDay(visits, '2025-06-01')?.placeId).toBe('home');
  });

  it('gives the handover day to the place arrived at', () => {
    // You departed and arrived on the same day; the night was spent at home.
    expect(placeOnDay(visits, '2026-09-08')?.id).toBe('h2');
  });

  it('returns null for a day nothing covers', () => {
    expect(placeOnDay([visit('l', 'london', '2026-09-01', '2026-09-08')], '2019-01-01')).toBeNull();
  });
});

describe('travelDays', () => {
  it('counts only days covered by a visit to somewhere that is not home', () => {
    const visits = [
      visit('h1', 'home', '2020-01-01'),
      visit('l', 'london', '2026-09-01', '2026-09-03'),
      visit('h2', 'home', '2026-09-03'),
    ];
    const window = ['2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04'];

    // The 3rd is the handover, and home wins it.
    expect(travelDays(visits, PLACES, window)).toEqual(['2026-09-01', '2026-09-02']);
  });

  it('does not count a day nothing covers as travel', () => {
    // Absence of a record is not evidence of a journey. §8.9 applies to a count
    // as much as to a chart.
    expect(travelDays([], PLACES, ['2026-09-01', '2026-09-02'])).toEqual([]);
  });

  it('ignores a visit to a place that is not in the map', () => {
    const visits = [visit('x', 'deleted-place', '2026-09-01', '2026-09-03')];

    expect(travelDays(visits, PLACES, ['2026-09-02'])).toEqual([]);
  });
});

describe('findOverlaps', () => {
  it('does not report home against a trip, once open ends resolve', () => {
    // The case that would otherwise fill the list with the one arrangement
    // that is not a mistake.
    const overlaps = findOverlaps([
      visit('h', 'home', '2020-01-01'),
      visit('l', 'london', '2026-09-01', '2026-09-08'),
    ]);

    expect(overlaps).toEqual([]);
  });

  it('reports two closed visits that genuinely overlap', () => {
    const overlaps = findOverlaps([
      visit('a', 'london', '2026-09-01', '2026-09-10'),
      visit('b', 'paris', '2026-09-05', '2026-09-12'),
    ]);

    expect(overlaps).toHaveLength(1);
    expect(overlaps[0]?.earlier.id).toBe('a');
    expect(overlaps[0]?.later.id).toBe('b');
  });

  it('does not treat a shared handover day as an overlap', () => {
    // Departing and arriving on the same day is a travel day, and it is how
    // every journey with a connection looks.
    const overlaps = findOverlaps([
      visit('a', 'london', '2026-09-01', '2026-09-05'),
      visit('b', 'paris', '2026-09-05', '2026-09-09'),
    ]);

    expect(overlaps).toEqual([]);
  });

  it('reports a visit fully inside another', () => {
    const overlaps = findOverlaps([
      visit('a', 'london', '2026-09-01', '2026-09-20'),
      visit('b', 'paris', '2026-09-05', '2026-09-08'),
    ]);

    expect(overlaps).toHaveLength(1);
  });

  it('finds nothing in a clean sequence', () => {
    const overlaps = findOverlaps([
      visit('a', 'london', '2026-09-01', '2026-09-04'),
      visit('b', 'paris', '2026-09-06', '2026-09-09'),
      visit('c', 'home', '2026-09-11'),
    ]);

    expect(overlaps).toEqual([]);
  });
});

describe('visitCovers', () => {
  it('reads the stored dates literally, open end included', () => {
    // The raw predicate, for a page showing one visit with no list to resolve
    // against. `placeOnDay` is the one that answers "where was I".
    expect(visitCovers(visit('a', 'home', '2020-01-01'), '2099-01-01')).toBe(true);
    expect(visitCovers(visit('a', 'home', '2020-01-01', '2020-01-05'), '2020-01-06')).toBe(false);
    expect(visitCovers(visit('a', 'home', '2020-01-01', '2020-01-05'), '2020-01-05')).toBe(true);
  });
});

describe('nightsAway', () => {
  it('counts the days between arrival and departure', () => {
    expect(nightsAway(visit('a', 'london', '2026-09-01', '2026-09-08'))).toBe(7);
  });

  it('is zero for a day trip and null while open', () => {
    expect(nightsAway(visit('a', 'london', '2026-09-01', '2026-09-01'))).toBe(0);
    expect(nightsAway(visit('a', 'london', '2026-09-01'))).toBeNull();
  });
});
