'use client';

import { useId, useState, type ReactNode } from 'react';

import { cn } from '../lib/cn';
import { Icon } from '../icons/Icon';
import { EmptyState, type EmptyStateProps } from './States';
import {
  ariaSortFor,
  cardLayout,
  formatCell,
  nextSort,
  sortRows,
  type TableColumn,
  type TableSort,
} from './tableModel';

/**
 * Table — §8.11.
 *
 *   "For dense historical data: labs, transactions, session history. Column
 *    definitions are declarative and typed. Sticky headers and a sticky first
 *    column. Numeric columns right-aligned with tabular figures. Sortable…
 *    Row density follows the global density setting.
 *
 *    **On mobile, tables become card lists.** A horizontally scrolling table on
 *    a phone is a table nobody reads. The same column definitions drive both
 *    renderings, so there is no second implementation to keep in sync."
 *
 * ## How the two renderings stay one implementation
 *
 * There is **one** DOM tree — a real `<table>` — and a container query rearranges
 * it. Cards are the default and the table layout is the enhancement, because
 * §8.4 is "mobile-first without qualification" and because a component that
 * renders wide and then collapses flashes a horizontal scrollbar on every phone
 * load.
 *
 * Three approaches were considered and two rejected:
 *
 * - *Two components behind a breakpoint hook.* Rejected outright: that is the
 *   "second implementation to keep in sync" the blueprint names.
 * - *Both DOM trees rendered, one `display:none`.* Rejected: it doubles the row
 *   count in the accessibility tree's source, doubles the cost of a
 *   ten-thousand-row history, and lets the two drift anyway because nothing
 *   forces a change to touch both.
 * - *One `<table>`, restyled.* Chosen. The cost is that changing `display` on
 *   table elements drops their implicit roles in every engine, so the roles are
 *   restated explicitly — `role="table"`, `role="row"`, `role="cell"`. That
 *   looks redundant on the wide layout and is the only reason the narrow layout
 *   is still a table to a screen reader.
 *
 * Each cell carries its column header as an `aria-hidden` label, revealed only
 * in card mode. It is aria-hidden because `scope`/`headers` already associate
 * the cell with its column — showing it to assistive technology as well would
 * announce every header twice.
 *
 * ## What this component deliberately does not do
 *
 * - **No row-level click handler.** A clickable `<tr>` is not focusable, not
 *   announced as actionable, and not middle-clickable. A column whose `render`
 *   returns a real link does all three, so that is the supported route.
 * - **No windowing yet.** §8.11 calls for virtualised pagination for
 *   ten-thousand-row histories. Windowing a table whose row height follows a
 *   density token means measuring rows at runtime, and it is worth building
 *   against a real dataset rather than a guess — `rows` is already the sliced
 *   page, so pagination composes above this component today and windowing slots
 *   in underneath it later without a signature change.
 */

export type TableProps<Row> = {
  /**
   * Required. Renders as the table's `<caption>`.
   *
   * A table with no accessible name is a table a screen-reader user meets as
   * "table, 9 columns" with no idea which one. Making it required is cheaper
   * than auditing for it later.
   */
  readonly caption: string;
  /** Hide the caption visually. It stays in the accessibility tree. */
  readonly captionHidden?: boolean;
  readonly columns: readonly TableColumn<Row>[];
  readonly rows: readonly Row[];
  /** Stable identity per row. Index keys reorder wrongly on sort. */
  readonly rowKey: (row: Row) => string;
  /** Controlled sort. Pair with `onSortChange` to keep it in the URL (§8.11). */
  readonly sort?: TableSort;
  readonly defaultSort?: TableSort;
  readonly onSortChange?: (sort: TableSort | undefined) => void;
  /**
   * Pin the first column while the rest scroll horizontally.
   *
   * On by default: the first column is what identifies the row, and a wide
   * table scrolled two columns to the right without it is a grid of anonymous
   * numbers.
   */
  readonly stickyFirstColumn?: boolean;
  /**
   * Required, per §8.8: "an empty card is a designed state, not a blank
   * rectangle." A table with a header row and nothing under it is the table
   * equivalent, and it is worse — it looks like a failed fetch.
   */
  readonly empty: EmptyStateProps;
  readonly className?: string;
};

export function Table<Row>({
  caption,
  captionHidden = false,
  columns,
  rows,
  rowKey,
  sort,
  defaultSort,
  onSortChange,
  stickyFirstColumn = true,
  empty,
  className,
}: TableProps<Row>): ReactNode {
  const captionId = useId();
  const [internalSort, setInternalSort] = useState<TableSort | undefined>(defaultSort);
  const activeSort = sort ?? internalSort;

  const applySort = (column: TableColumn<Row>): void => {
    const next = nextSort(activeSort, column);
    setInternalSort(next);
    onSortChange?.(next);
  };

  const ordered = sortRows(rows, columns, activeSort);
  const layout = cardLayout(columns);

  if (ordered.length === 0) {
    return (
      <div className={cn('nos-table-wrap', className)}>
        {/* The caption still renders, so the empty state is attached to a named
            thing rather than floating in the page. */}
        <p className={cn('nos-table__caption', captionHidden && 'nos-visually-hidden')}>{caption}</p>
        <EmptyState size="sm" {...empty} />
      </div>
    );
  }

  return (
    <div className={cn('nos-table-wrap', className)}>
      <table
        role="table"
        aria-labelledby={captionId}
        className={cn('nos-table', 'nos-table--responsive', stickyFirstColumn && 'nos-table--sticky-first')}
      >
        <caption id={captionId} className={cn('nos-table__caption', captionHidden && 'nos-visually-hidden')}>
          {caption}
        </caption>

        <thead role="rowgroup">
          <tr role="row">
            {columns.map((column) => (
              <TableHeaderCell
                key={column.id}
                column={column}
                sort={activeSort}
                onSort={() => {
                  applySort(column);
                }}
              />
            ))}
          </tr>
        </thead>

        <tbody role="rowgroup">
          {ordered.map((row) => (
            <tr role="row" key={rowKey(row)} className="nos-table__row">
              {columns.map((column) => {
                const isTitle = column === layout.title;
                const isHiddenOnCards = column.cardRole === 'hidden';
                const content = column.render?.(row) ?? formatCell(column.value(row), column.unit);

                const cellClass = cn(
                  'nos-table__cell',
                  column.numeric === true && 'nos-table__num',
                  isTitle && 'nos-table__cell--title',
                  isHiddenOnCards && 'nos-table__cell--card-hidden',
                );

                // The row header is the title column, so a screen reader
                // announcing a cell names the row it belongs to.
                return isTitle ? (
                  <th role="rowheader" scope="row" key={column.id} className={cellClass}>
                    <CellBody header={column.header} showLabel={false}>
                      {content}
                    </CellBody>
                  </th>
                ) : (
                  <td role="cell" key={column.id} className={cellClass}>
                    <CellBody header={column.header} showLabel>
                      {content}
                    </CellBody>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A header cell, sortable or not.
 *
 * The sort control is a real `<button>` inside the `<th>` rather than a click
 * handler on the `<th>` itself: only the button is focusable, announced as
 * pressable, and reachable by keyboard, and `aria-sort` on the header is what
 * communicates the resulting order.
 *
 * The direction is carried by an arrow icon *and* by `aria-sort` — §8.13 forbids
 * state conveyed by colour alone, and a header that only turns accent-coloured
 * when sorted says nothing to a monochrome or forced-colours rendering.
 */
function TableHeaderCell<Row>({
  column,
  sort,
  onSort,
}: {
  readonly column: TableColumn<Row>;
  readonly sort: TableSort | undefined;
  readonly onSort: () => void;
}): ReactNode {
  const direction = ariaSortFor(column, sort);
  const isSorted = direction !== 'none';

  const label = column.unit === undefined ? column.header : `${column.header} (${column.unit})`;

  if (column.sortable !== true) {
    return (
      <th role="columnheader" scope="col" className={cn(column.numeric === true && 'nos-table__num')}>
        {label}
      </th>
    );
  }

  return (
    <th
      role="columnheader"
      scope="col"
      aria-sort={direction}
      className={cn(column.numeric === true && 'nos-table__num')}
    >
      <button type="button" className={cn('nos-table__sort', isSorted && 'is-sorted')} onClick={onSort}>
        <span>{label}</span>
        <Icon
          name={direction === 'descending' ? 'data.sort-descending' : 'data.sort-ascending'}
          label={null}
          size="sm"
          className={cn('nos-table__sort-icon', isSorted && 'is-sorted')}
        />
        {/* The button's own name says what pressing it does; `aria-sort` on the
            header says what the current order is. Both are needed — without the
            first, the control announces as the column name and nothing else. */}
        <span className="nos-visually-hidden">
          {isSorted ? `sorted ${direction}, ` : ''}
          sort by {column.header}
        </span>
      </button>
    </th>
  );
}

/**
 * The inside of a cell: the column label, then the value.
 *
 * The label exists in every cell and is revealed only by the card layout. It is
 * `aria-hidden` because `scope="col"` already binds the cell to its header, and
 * a visible duplicate would make every card read its headers twice.
 */
function CellBody({
  header,
  showLabel,
  children,
}: {
  readonly header: string;
  readonly showLabel: boolean;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <>
      {showLabel && (
        <span className="nos-table__cell-label" aria-hidden="true">
          {header}
        </span>
      )}
      <span className="nos-table__cell-value">{children}</span>
    </>
  );
}
