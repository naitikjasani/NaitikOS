import type { CSSProperties, ElementType, ReactNode } from 'react';

import { cn } from '../lib/cn';

/**
 * Layout primitives — §8.4.
 *
 *   "Layout primitives — `Stack`, `Inline`, `Grid`, `Container` — take
 *    token-typed gaps. Ad-hoc flexbox in feature code is discouraged, because
 *    layout consistency is what makes a sixteen-domain application feel like
 *    one product rather than sixteen."
 *
 * The gap prop is typed to the spacing scale, so `gap="3.5"` is a compile
 * error rather than a rendering surprise. That is the whole point: §8.4 says
 * "every margin, padding, and gap references a token; arbitrary values fail
 * lint", and a union type catches it earlier than lint does.
 */

/** The 4px-grid steps (§8.4). */
export const SPACE_STEPS = [
  '0',
  'px',
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '8',
  '10',
  '12',
  '16',
  '20',
  '24',
] as const;

export type SpaceStep = (typeof SPACE_STEPS)[number];

function spaceVar(step: SpaceStep | undefined): string | undefined {
  return step === undefined ? undefined : `var(--space-${step})`;
}

type AlignItems = 'start' | 'center' | 'end' | 'stretch' | 'baseline';
type JustifyContent = 'start' | 'center' | 'end' | 'between' | 'around';

const ALIGN: Record<AlignItems, string> = {
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
  stretch: 'stretch',
  baseline: 'baseline',
};

const JUSTIFY: Record<JustifyContent, string> = {
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
  between: 'space-between',
  around: 'space-around',
};

type FlexProps = {
  readonly children?: ReactNode;
  readonly gap?: SpaceStep;
  readonly align?: AlignItems;
  readonly justify?: JustifyContent;
  readonly wrap?: boolean;
  readonly className?: string;
  readonly style?: CSSProperties;
  /** Render as a different element — `as="ul"` for a list, `as="nav"`, etc. */
  readonly as?: ElementType;
};

/**
 * Vertical flow. The default container for stacked content.
 *
 * Uses `gap` rather than margins on children, so a child can be removed
 * without leaving a phantom margin behind — the single most common source of
 * layout drift in a long-lived codebase.
 */
export function Stack({
  children,
  gap = '4',
  align,
  justify,
  className,
  style,
  as: Component = 'div',
}: FlexProps): ReactNode {
  return (
    <Component
      className={cn('nos-stack', className)}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: spaceVar(gap),
        alignItems: align === undefined ? undefined : ALIGN[align],
        justifyContent: justify === undefined ? undefined : JUSTIFY[justify],
        ...style,
      }}
    >
      {children}
    </Component>
  );
}

/**
 * Horizontal flow.
 *
 * Wraps by default. A row of chips or actions that cannot wrap causes
 * horizontal scroll on a phone, and §8.4 is mobile-first "without
 * qualification".
 */
export function Inline({
  children,
  gap = '2',
  align = 'center',
  justify,
  wrap = true,
  className,
  style,
  as: Component = 'div',
}: FlexProps): ReactNode {
  return (
    <Component
      className={cn('nos-inline', className)}
      style={{
        display: 'flex',
        flexDirection: 'row',
        flexWrap: wrap ? 'wrap' : 'nowrap',
        gap: spaceVar(gap),
        alignItems: ALIGN[align],
        justifyContent: justify === undefined ? undefined : JUSTIFY[justify],
        ...style,
      }}
    >
      {children}
    </Component>
  );
}

export type GridProps = FlexProps & {
  /**
   * Minimum column width before wrapping.
   *
   * Expressed as a minimum rather than a column count, so the grid is
   * intrinsically responsive: no breakpoints, no media queries, and it behaves
   * correctly inside a sidebar as well as at full width.
   */
  readonly minColumnWidth?: string;
  /** Fixed column count. Overrides `minColumnWidth` when set. */
  readonly columns?: number;
};

export function Grid({
  children,
  gap = '4',
  minColumnWidth = '16rem',
  columns,
  align,
  className,
  style,
  as: Component = 'div',
}: GridProps): ReactNode {
  return (
    <Component
      className={cn('nos-grid', className)}
      style={{
        display: 'grid',
        gap: spaceVar(gap),
        gridTemplateColumns:
          columns === undefined
            ? `repeat(auto-fit, minmax(min(${minColumnWidth}, 100%), 1fr))`
            : `repeat(${String(columns)}, minmax(0, 1fr))`,
        alignItems: align === undefined ? undefined : ALIGN[align],
        ...style,
      }}
    >
      {children}
    </Component>
  );
}

export type ContainerProps = {
  readonly children?: ReactNode;
  /**
   * `reading` caps at ~65ch for long-form text (§8.3's serif mode); `content`
   * is the default page width; `wide` is for dense tables and charts.
   */
  readonly width?: 'reading' | 'content' | 'wide' | 'full';
  readonly className?: string;
  readonly style?: CSSProperties;
  readonly as?: ElementType;
};

const CONTAINER_WIDTH: Record<NonNullable<ContainerProps['width']>, string> = {
  reading: '42rem',
  content: '64rem',
  wide: '90rem',
  full: '100%',
};

/**
 * Centres content and applies the gutter.
 *
 * The gutter is a density token, so `compact` narrows every page margin in the
 * application at once (§8.4).
 */
export function Container({
  children,
  width = 'content',
  className,
  style,
  as: Component = 'div',
}: ContainerProps): ReactNode {
  return (
    <Component
      className={cn('nos-container', className)}
      style={{
        width: '100%',
        maxWidth: CONTAINER_WIDTH[width],
        marginInline: 'auto',
        paddingInline: 'var(--layout-gutter)',
        ...style,
      }}
    >
      {children}
    </Component>
  );
}

/** A flexible gap that pushes siblings apart in a flex row. */
export function Spacer(): ReactNode {
  return <div aria-hidden="true" style={{ flex: 1 }} />;
}

/**
 * A horizontal rule that is a separator, not decoration.
 *
 * `role="separator"` with an orientation, so a screen reader announces the
 * section break rather than skipping a `<div>` with a border.
 */
export function Divider({
  orientation = 'horizontal',
  className,
}: {
  readonly orientation?: 'horizontal' | 'vertical';
  readonly className?: string;
}): ReactNode {
  return (
    <div
      role="separator"
      aria-orientation={orientation}
      className={cn('nos-divider', `nos-divider--${orientation}`, className)}
    />
  );
}
