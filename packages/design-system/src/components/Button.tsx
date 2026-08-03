import { Slot } from '@radix-ui/react-slot';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

import { cn } from '../lib/cn';
import { Icon } from '../icons/Icon';
import type { IconName } from '../icons/registry';

/**
 * Button.
 *
 * Four variants and three sizes. The constraint that shapes it is §8.13's
 * "Touch targets ≥ 44×44px… Non-negotiable for gym use" — so the default
 * height is the `--layout-control-height` token, which is 44px at comfortable
 * density and drops only to 40px at compact, where the user has explicitly
 * asked for tighter.
 *
 * ## Loading is a disabled state that announces itself
 *
 * `isLoading` disables the button *and* sets `aria-busy`, and keeps the label
 * in the DOM rather than replacing it with a spinner. Swapping the label out
 * changes the button's width mid-interaction and leaves a screen reader
 * announcing nothing at all.
 */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive';
export type ButtonSize = 'sm' | 'md' | 'lg';

export type ButtonProps = {
  readonly children?: ReactNode;
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  /** Leading icon. Decorative — the label carries the meaning. */
  readonly iconStart?: IconName;
  readonly iconEnd?: IconName;
  readonly isLoading?: boolean;
  readonly fullWidth?: boolean;
  /**
   * Render the child element instead of a `<button>`, forwarding props.
   *
   * For a link that looks like a button. `<Button asChild><Link/></Button>`
   * keeps the anchor semantics — which matters, because a `<button>` that
   * navigates breaks middle-click, "open in new tab", and the browser's own
   * link affordances.
   */
  readonly asChild?: boolean;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'>;

export function Button({
  children,
  variant = 'secondary',
  size = 'md',
  iconStart,
  iconEnd,
  isLoading = false,
  fullWidth = false,
  asChild = false,
  className,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps): ReactNode {
  const Component = asChild ? Slot : 'button';
  const iconSize = size === 'lg' ? 'lg' : size === 'sm' ? 'sm' : 'md';

  return (
    <Component
      // Defaulting to `button`: an un-typed button inside a form submits it,
      // which is the single most common accidental-submit bug in React.
      type={asChild ? undefined : type}
      className={cn(
        'nos-button',
        `nos-button--${variant}`,
        `nos-button--${size}`,
        fullWidth && 'nos-button--full',
        className,
      )}
      disabled={disabled === true || isLoading}
      aria-busy={isLoading || undefined}
      {...rest}
    >
      {isLoading ? (
        <Icon name="status.loading" label={null} size={iconSize} className="nos-spin" />
      ) : iconStart !== undefined ? (
        <Icon name={iconStart} label={null} size={iconSize} />
      ) : null}
      {children}
      {iconEnd !== undefined && !isLoading && <Icon name={iconEnd} label={null} size={iconSize} />}
    </Component>
  );
}

/**
 * A button whose only content is an icon.
 *
 * Separate component rather than a `<Button>` with no children, because the
 * accessible label must be **required** here. §8.5: icons "never [appear] as
 * the sole carrier of meaning" — an icon-only button with no label is
 * unusable with a screen reader, and it is the easiest accessibility failure
 * to ship.
 */
export type IconButtonProps = {
  readonly icon: IconName;
  /** Required. Announced by assistive technology; also the tooltip text. */
  readonly label: string;
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly isLoading?: boolean;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'aria-label'>;

export function IconButton({
  icon,
  label,
  variant = 'ghost',
  size = 'md',
  isLoading = false,
  className,
  disabled,
  type = 'button',
  ...rest
}: IconButtonProps): ReactNode {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={cn(
        'nos-button',
        'nos-button--icon',
        `nos-button--${variant}`,
        `nos-button--${size}`,
        className,
      )}
      disabled={disabled === true || isLoading}
      aria-busy={isLoading || undefined}
      {...rest}
    >
      <Icon
        name={isLoading ? 'status.loading' : icon}
        label={null}
        size={size === 'lg' ? 'lg' : size === 'sm' ? 'sm' : 'md'}
        className={isLoading ? 'nos-spin' : undefined}
      />
    </button>
  );
}
