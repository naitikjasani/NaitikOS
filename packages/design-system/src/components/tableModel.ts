import type { ReactNode } from 'react';

/**
 * The declarative column model behind `<Table>` — §8.11.
 *
 * Everything here is pure. The sort comparison, the direction cycle, and the
 * split of columns into card roles are the parts of a table that are actually
 * easy to get wrong, and none of them need a DOM to be wrong in — so they live
 * apart from the component and are tested directly, the way `charts/scales.ts`
 * sits apart from `TrendChart`.
 *
 * The other reason for the split is §8.11's real requirement:
 *
 *   "On mobile, tables become card lists. The same column definitions drive
 *    both renderings, so there is no second implementation to keep in sync."
 *
 * One column array, one model, two visual arrangements of the same DOM. If the
 * card rendering ever needs its own column type, that sentence has been
 * violated.
 */

/**
 * What a cell sorts and compares by.
 *
 * Deliberately narrower than what a cell can *display*: `render` may return any
 * node, but `value` must reduce to something orderable, because a column that
 * renders a badge still has to sort by the thing the badge means. Keeping the
 * two separate is what stops a table sorting by the alphabetical order of its
 * own formatting.
 */
export type TableCellValue = string | number | null;

/**
 * Where a column lands when the table renders as cards.
 *
 * `title` is the line a person scans down; the rest become labelled fields.
 * `hidden` drops the column on narrow screens — not from the table, from the
 * *cards*, which is the honest way to handle the seventh column of a lab panel
 * on a 360px phone.
 */
export type TableCardRole = 'title' | 'subtitle' | 'field' | 'hidden';

export type TableColumn<Row> = {
  readonly id: string;
  /** Visible header text. Also the label each cell carries in card mode. */
  readonly header: string;
  /** The orderable value. Return `null` for genuinely absent data, never 0. */
  readonly value: (row: Row) => TableCellValue;
  /** Display override. Defaults to the value, em-dashed when null. */
  readonly render?: (row: Row) => ReactNode;
  /**
   * Right-aligns and applies tabular figures (§8.11).
   *
   * Not inferred from the value's runtime type: a column of `null`s in the
   * first page would infer as text and then jump to right-aligned when a real
   * number arrives. The column declares what it is.
   */
  readonly numeric?: boolean;
  /** Display only. Values are stored canonically (§6.2, §8.10). */
  readonly unit?: string;
  readonly sortable?: boolean;
  readonly cardRole?: TableCardRole;
};

export type SortDirection = 'ascending' | 'descending';

/**
 * Sort state, kept outside the component on purpose.
 *
 * §8.11 wants sort state "in the URL so a view can be bookmarked and returned
 * to", and a design-system package that reached for a router would be a
 * layering violation (§6.2). So the state is liftable: pass `sort` and
 * `onSortChange` and the app owns the URL; pass neither and the table keeps it
 * internally for the throwaway case.
 */
export type TableSort = {
  readonly columnId: string;
  readonly direction: SortDirection;
};

/** `aria-sort` takes the same words, which is why these are the words. */
export function ariaSortFor(
  column: { readonly id: string },
  sort: TableSort | undefined,
): SortDirection | 'none' {
  return sort !== undefined && sort.columnId === column.id ? sort.direction : 'none';
}

/**
 * Compare two present values.
 *
 * `localeCompare` with `numeric: true` rather than `<`, so "Visit 2" sorts
 * before "Visit 10" — the ordering a human reading a list of labelled records
 * expects, and one that plain code-point comparison gets backwards.
 */
export function compareCells(a: string | number, b: string | number): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * Sort rows by a column.
 *
 * **Missing values sort last in both directions.** This is the table's version
 * of §8.9(3), "missing data is shown as missing": a null is an absence, not the
 * smallest number, and letting it sort to the top of an ascending weight column
 * would put "no reading" where "lowest reading" belongs. Reversing a comparator
 * would do exactly that, so the null partition is handled before the compare
 * rather than inside it.
 *
 * Stable, because `Array.prototype.sort` is, and a table whose rows shuffle
 * among equal values on re-sort looks like it lost data.
 */
export function sortRows<Row>(
  rows: readonly Row[],
  columns: readonly TableColumn<Row>[],
  sort: TableSort | undefined,
): readonly Row[] {
  if (sort === undefined) return rows;
  const column = columns.find((candidate) => candidate.id === sort.columnId);
  if (column === undefined) return rows;

  const sign = sort.direction === 'ascending' ? 1 : -1;

  return [...rows].sort((rowA, rowB) => {
    const a = column.value(rowA);
    const b = column.value(rowB);
    if (a === null && b === null) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    return sign * compareCells(a, b);
  });
}

/**
 * The next state of the sort control for a header press.
 *
 * Three states, not two: pressing a sorted column a third time returns to the
 * table's natural order. Insertion order is meaningful in this product — a
 * session history arrives in the order it happened — and a two-state toggle
 * makes that order unreachable once you have touched a header.
 *
 * Numeric columns open **descending**. The question asked of a numeric column
 * in a health record is almost always "what is the largest / most recent", and
 * opening ascending answers it only after a second press.
 */
export function nextSort(
  current: TableSort | undefined,
  column: { readonly id: string; readonly numeric?: boolean },
): TableSort | undefined {
  const opening: SortDirection = column.numeric === true ? 'descending' : 'ascending';
  const closing: SortDirection = opening === 'ascending' ? 'descending' : 'ascending';

  if (current === undefined || current.columnId !== column.id) {
    return { columnId: column.id, direction: opening };
  }
  if (current.direction === opening) return { columnId: column.id, direction: closing };
  return undefined;
}

/**
 * Split the columns into the roles the card rendering needs.
 *
 * Derived rather than declared, so a caller who never thinks about mobile still
 * gets a sensible card: the first column becomes the title, because the first
 * column of a table is almost always the thing the row *is*.
 */
export type CardLayout<Row> = {
  readonly title: TableColumn<Row> | undefined;
  readonly subtitles: readonly TableColumn<Row>[];
  readonly fields: readonly TableColumn<Row>[];
};

export function cardLayout<Row>(columns: readonly TableColumn<Row>[]): CardLayout<Row> {
  const visible = columns.filter((column) => column.cardRole !== 'hidden');
  const declaredTitle = visible.find((column) => column.cardRole === 'title');
  const title = declaredTitle ?? visible[0];

  return {
    title,
    subtitles: visible.filter((column) => column !== title && column.cardRole === 'subtitle'),
    fields: visible.filter(
      (column) => column !== title && column.cardRole !== 'subtitle',
    ),
  };
}

/**
 * The default cell text.
 *
 * An absent value is an em dash, never a zero and never an empty cell. An empty
 * cell reads as a rendering bug; a zero is a claim about the body that nobody
 * made.
 */
export function formatCell(value: TableCellValue, unit?: string): string {
  if (value === null) return '—';
  const text = typeof value === 'number' ? String(value) : value;
  return unit === undefined ? text : `${text} ${unit}`;
}
