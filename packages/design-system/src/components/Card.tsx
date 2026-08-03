import type { ElementType, HTMLAttributes, ReactNode } from 'react';

import { cn } from '../lib/cn';
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

export function CardBody({
  children,
  className,
}: {
  readonly children?: ReactNode;
  readonly className?: string;
}): ReactNode {
  return <div className={cn('nos-card__body', className)}>{children}</div>;
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
