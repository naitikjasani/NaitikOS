import type { ElementType, HTMLAttributes, ReactNode } from 'react';

import { cn } from '../lib/cn';
import { EmptyState, type EmptyStateProps } from './States';
import { Text } from '../primitives/Text';

/**
 * Card — §8.8.
 *
 *   "Cards are the primary container. Four variants, and no more, because
 *    container proliferation is how visual systems lose coherence."
 *
 * | Variant       | Use                                                    |
 * |---------------|--------------------------------------------------------|
 * | `flat`        | Grouping without emphasis. No border, no shadow.       |
 * | `outlined`    | Distinct entity. 1px subtle border.                    |
 * | `raised`      | Elevated content — modals, popovers. Subtle shadow.    |
 * | `interactive` | Whole card is a target. Hover, focus, cursor.          |
 *
 * Adding a fifth variant is a design-system decision, not a component prop.
 *
 * ## Elevation in dark mode
 *
 * §8.7: "elevation is conveyed by lightness, not shadow, since shadows are
 * near-invisible on dark surfaces." `raised` therefore lightens the surface in
 * dark and casts a shadow in light — handled in CSS by the theme, so the
 * component does not branch on it.
 */

export type CardVariant = 'flat' | 'outlined' | 'raised' | 'interactive';

export type CardProps = {
  readonly children?: ReactNode;
  readonly variant?: CardVariant;
  readonly as?: ElementType;
  /**
   * Required when `variant="interactive"`.
   *
   * An interactive card must be a real button or link, not a `<div>` with an
   * `onClick`. This prop exists so the component can render the correct
   * element rather than bolting `role="button"` and a keydown handler onto a
   * div — which is the pattern that reliably breaks keyboard users.
   */
  readonly onActivate?: () => void;
} & Omit<HTMLAttributes<HTMLElement>, 'onClick'>;

export function Card({
  children,
  variant = 'flat',
  as,
  onActivate,
  className,
  ...rest
}: CardProps): ReactNode {
  const isInteractive = variant === 'interactive';
  const Component: ElementType = as ?? (isInteractive ? 'button' : 'div');

  return (
    <Component
      className={cn('nos-card', `nos-card--${variant}`, className)}
      {...(isInteractive
        ? { type: Component === 'button' ? 'button' : undefined, onClick: onActivate }
        : {})}
      {...rest}
    >
      {children}
    </Component>
  );
}

export type CardHeaderProps = {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  /** Actions rendered opposite the title — an overflow menu, a filter. */
  readonly actions?: ReactNode;
  /** Heading level. Visual size is fixed; document outline is the caller's. */
  readonly as?: 'h2' | 'h3' | 'h4';
  readonly className?: string;
};

export function CardHeader({
  title,
  description,
  actions,
  as = 'h3',
  className,
}: CardHeaderProps): ReactNode {
  return (
    <div className={cn('nos-card__header', className)}>
      <div className="nos-card__header-text">
        <Text role="title-3" as={as}>
          {title}
        </Text>
        {description !== undefined && (
          <Text role="body-sm" tone="secondary">
            {description}
          </Text>
        )}
      </div>
      {actions !== undefined && <div className="nos-card__header-actions">{actions}</div>}
    </div>
  );
}

/**
 * The card's content, and its empty state.
 *
 * §8.8: "Every card supports an empty state; **an empty card is a designed
 * state, not a blank rectangle.** Given that this system will legitimately have
 * empty modules for long periods, empty states are a primary design surface
 * rather than an afterthought."
 *
 * The `empty` prop is what makes that structural rather than aspirational. It
 * lives here, on the body, so a card gets the designed state on every variant
 * without four copies of the same conditional at the call site — and because
 * the header and footer stay put, an empty card keeps its title and its action,
 * which is exactly what stops it reading as a broken screen.
 *
 * Emptiness is decided here rather than by the caller passing a flag, because
 * `{items.map(…)}` over an empty array renders an empty array, not `null`, and
 * a caller-supplied `isEmpty` is a second source of truth that drifts from the
 * data the moment a filter is added.
 */
export type CardBodyProps = {
  readonly children?: ReactNode;
  /**
   * Rendered instead of the children when there are none.
   *
   * `EmptyState` requires a description and takes at most one action, so §8.8's
   * "states what would appear here and offers the single action that would
   * populate it" is enforced by the type rather than by review.
   */
  readonly empty?: EmptyStateProps;
  readonly className?: string;
};

export function CardBody({ children, empty, className }: CardBodyProps): ReactNode {
  const isEmpty =
    children === undefined ||
    children === null ||
    children === false ||
    (Array.isArray(children) && children.length === 0);

  return (
    <div className={cn('nos-card__body', className)}>
      {isEmpty && empty !== undefined ? <EmptyState size="sm" {...empty} /> : children}
    </div>
  );
}

export function CardFooter({
  children,
  className,
}: {
  readonly children?: ReactNode;
  readonly className?: string;
}): ReactNode {
  return <div className={cn('nos-card__footer', className)}>{children}</div>;
}
