import { describe, expect, it } from 'vitest';

import {
  ariaSortFor,
  cardLayout,
  compareCells,
  formatCell,
  nextSort,
  sortRows,
  type TableColumn,
} from './tableModel';

type Lab = { readonly id: string; readonly marker: string; readonly value: number | null };

const rows: readonly Lab[] = [
  { id: 'a', marker: 'Ferritin', value: 42 },
  { id: 'b', marker: 'Vitamin D', value: null },
  { id: 'c', marker: 'HbA1c', value: 5.4 },
  { id: 'd', marker: 'Visit 10', value: 5.4 },
  { id: 'e', marker: 'Visit 2', value: 1 },
];

const columns: readonly TableColumn<Lab>[] = [
  { id: 'marker', header: 'Marker', value: (row) => row.marker, sortable: true },
  { id: 'value', header: 'Value', value: (row) => row.value, numeric: true, sortable: true },
];

describe('compareCells', () => {
  it('orders numbers numerically rather than as text', () => {
    expect(compareCells(9, 10)).toBeLessThan(0);
  });

  /**
   * The reason `localeCompare` is used with `numeric: true` rather than `<`.
   * Code-point order puts "Visit 10" before "Visit 2", which is not the order
   * anyone reading a list of labelled records expects.
   */
  it('orders embedded numbers the way a reader does', () => {
    expect(compareCells('Visit 2', 'Visit 10')).toBeLessThan(0);
  });
});

describe('sortRows', () => {
  it('returns the rows untouched when nothing is sorted', () => {
    expect(sortRows(rows, columns, undefined)).toBe(rows);
  });

  it('ignores a sort on a column that is not there', () => {
    expect(sortRows(rows, columns, { columnId: 'gone', direction: 'ascending' })).toBe(rows);
  });

  /**
   * The invariant this module exists to hold.
   *
   * A missing value is an absence, not the smallest number. Reversing a
   * comparator would float "no reading" to the top of an ascending column,
   * where "lowest reading" belongs — the table's version of §8.9(3).
   */
  it('keeps missing values last in both directions', () => {
    const ascending = sortRows(rows, columns, { columnId: 'value', direction: 'ascending' });
    const descending = sortRows(rows, columns, { columnId: 'value', direction: 'descending' });
    expect(ascending.at(-1)?.id).toBe('b');
    expect(descending.at(-1)?.id).toBe('b');
  });

  it('sorts numerically, ascending and descending', () => {
    const ascending = sortRows(rows, columns, { columnId: 'value', direction: 'ascending' });
    expect(ascending.map((row) => row.value)).toEqual([1, 5.4, 5.4, 42, null]);

    const descending = sortRows(rows, columns, { columnId: 'value', direction: 'descending' });
    expect(descending.map((row) => row.value)).toEqual([42, 5.4, 5.4, 1, null]);
  });

  /** Rows that shuffle among equal values look like the table lost data. */
  it('is stable across equal values', () => {
    const ascending = sortRows(rows, columns, { columnId: 'value', direction: 'ascending' });
    expect(ascending.filter((row) => row.value === 5.4).map((row) => row.id)).toEqual(['c', 'd']);
  });

  it('does not mutate the input', () => {
    const before = rows.map((row) => row.id);
    sortRows(rows, columns, { columnId: 'value', direction: 'descending' });
    expect(rows.map((row) => row.id)).toEqual(before);
  });
});

describe('nextSort', () => {
  /**
   * Numeric columns open descending: the question asked of a number in a health
   * record is almost always "what is the largest / most recent".
   */
  it('opens numeric columns descending and text columns ascending', () => {
    expect(nextSort(undefined, { id: 'value', numeric: true })?.direction).toBe('descending');
    expect(nextSort(undefined, { id: 'marker' })?.direction).toBe('ascending');
  });

  it('cycles through both directions and back to unsorted', () => {
    const first = nextSort(undefined, { id: 'marker' });
    const second = nextSort(first, { id: 'marker' });
    const third = nextSort(second, { id: 'marker' });
    expect(first?.direction).toBe('ascending');
    expect(second?.direction).toBe('descending');
    // The third press restores insertion order, which is meaningful data in a
    // session history and unreachable under a two-state toggle.
    expect(third).toBeUndefined();
  });

  it('starts a fresh cycle when a different column is pressed', () => {
    const sorted = { columnId: 'marker', direction: 'descending' } as const;
    expect(nextSort(sorted, { id: 'value', numeric: true })).toEqual({
      columnId: 'value',
      direction: 'descending',
    });
  });
});

describe('ariaSortFor', () => {
  it('reports none for every column but the sorted one', () => {
    const sort = { columnId: 'value', direction: 'ascending' } as const;
    expect(ariaSortFor({ id: 'value' }, sort)).toBe('ascending');
    expect(ariaSortFor({ id: 'marker' }, sort)).toBe('none');
    expect(ariaSortFor({ id: 'value' }, undefined)).toBe('none');
  });
});

describe('cardLayout', () => {
  it('promotes the first column to the card title when none is declared', () => {
    const layout = cardLayout(columns);
    expect(layout.title?.id).toBe('marker');
    expect(layout.fields.map((column) => column.id)).toEqual(['value']);
  });

  it('honours a declared title wherever it sits', () => {
    const layout = cardLayout([
      { id: 'when', header: 'When', value: () => '2026-01-01' },
      { id: 'marker', header: 'Marker', value: () => 'Ferritin', cardRole: 'title' },
      { id: 'lab', header: 'Lab', value: () => 'Metropolis', cardRole: 'subtitle' },
    ]);
    expect(layout.title?.id).toBe('marker');
    expect(layout.subtitles.map((column) => column.id)).toEqual(['lab']);
    expect(layout.fields.map((column) => column.id)).toEqual(['when']);
  });

  /** Dropping a column from the cards must not drop it from the table. */
  it('drops card-hidden columns from every card role', () => {
    const layout = cardLayout([
      { id: 'marker', header: 'Marker', value: () => 'Ferritin' },
      { id: 'method', header: 'Method', value: () => 'ECLIA', cardRole: 'hidden' },
    ]);
    expect(layout.fields).toHaveLength(0);
  });

  it('never lists the title twice when the first column is a subtitle', () => {
    const layout = cardLayout([
      { id: 'lab', header: 'Lab', value: () => 'Metropolis', cardRole: 'subtitle' },
      { id: 'marker', header: 'Marker', value: () => 'Ferritin' },
    ]);
    expect(layout.title?.id).toBe('lab');
    expect(layout.subtitles).toHaveLength(0);
    expect(layout.fields.map((column) => column.id)).toEqual(['marker']);
  });
});

describe('formatCell', () => {
  /**
   * An absent value is an em dash, never a zero and never blank. A blank cell
   * reads as a rendering bug; a zero is a claim about the body nobody made.
   */
  it('renders an absence as an em dash', () => {
    expect(formatCell(null)).toBe('—');
    expect(formatCell(null, 'kg')).toBe('—');
    expect(formatCell(0, 'kg')).toBe('0 kg');
  });

  it('appends the unit as display only', () => {
    expect(formatCell(62.5, 'kg')).toBe('62.5 kg');
    expect(formatCell('Ferritin')).toBe('Ferritin');
  });
});
