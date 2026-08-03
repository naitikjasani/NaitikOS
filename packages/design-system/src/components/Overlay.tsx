'use client';

import * as AlertDialogPrimitive from '@radix-ui/react-alert-dialog';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as DropdownPrimitive from '@radix-ui/react-dropdown-menu';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { Drawer as DrawerPrimitive } from 'vaul';
import type { ReactNode } from 'react';

import { cn } from '../lib/cn';
import { Button, IconButton } from './Button';
import { Icon } from '../icons/Icon';
import type { IconName } from '../icons/registry';
import { Text } from '../primitives/Text';

/**
 * Overlays — §8.12.
 *
 *   "All built on Radix, so focus trapping, focus restoration, escape
 *    handling, and scroll locking are correct without reimplementation."
 *
 * That sentence is the entire justification for the dependency. Each of those
 * four behaviours is individually subtle and collectively about four hundred
 * lines nobody should write twice — and getting focus restoration wrong means
 * a keyboard user is dumped at the top of the document every time they close a
 * dialog.
 *
 * | Component     | Use                                   | Placement          |
 * |---------------|---------------------------------------|--------------------|
 * | `Dialog`      | Focused task requiring confirmation   | Centred, modal     |
 * | `Sheet`       | Contextual detail or capture          | Bottom / right     |
 * | `Popover`     | Lightweight secondary content         | Anchored           |
 * | `Tooltip`     | Supplementary label — never essential | Anchored           |
 * | `AlertDialog` | Destructive confirmation              | Centred, explicit  |
 */

/* =========================================================================
 * Dialog
 * ====================================================================== */

export type DialogProps = {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  /**
   * Required.
   *
   * Radix warns when a dialog has no description, and the warning is right: a
   * screen-reader user hears the title and then silence while sighted users
   * read the body. Making it a required prop is cheaper than remembering.
   */
  readonly description: string;
  /** Hide the description visually while keeping it announced. */
  readonly descriptionHidden?: boolean;
  readonly children?: ReactNode;
  readonly footer?: ReactNode;
  readonly size?: 'sm' | 'md' | 'lg';
};

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  descriptionHidden = false,
  children,
  footer,
  size = 'md',
}: DialogProps): ReactNode {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="nos-overlay" />
        <DialogPrimitive.Content className={cn('nos-dialog', `nos-dialog--${size}`)}>
          <div className="nos-dialog__header">
            <DialogPrimitive.Title asChild>
              <Text role="title-2" as="h2">
                {title}
              </Text>
            </DialogPrimitive.Title>
            <DialogPrimitive.Close asChild>
              <IconButton icon="nav.close" label="Close" size="sm" />
            </DialogPrimitive.Close>
          </div>

          <DialogPrimitive.Description
            className={descriptionHidden ? 'nos-visually-hidden' : undefined}
            asChild={!descriptionHidden}
          >
            {descriptionHidden ? (
              description
            ) : (
              <Text role="body-sm" tone="secondary">
                {description}
              </Text>
            )}
          </DialogPrimitive.Description>

          {children !== undefined && <div className="nos-dialog__body">{children}</div>}
          {footer !== undefined && <div className="nos-dialog__footer">{footer}</div>}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/* =========================================================================
 * AlertDialog — destructive confirmation
 * ====================================================================== */

/**
 * A destructive confirmation.
 *
 * §8.12 attaches a warning to this component that is worth repeating at the
 * point of use:
 *
 *   "**Destructive actions never rely solely on a confirm dialog.** Deletion
 *    is soft (§9.4) and produces an undo toast. Confirmation dialogs train
 *    people to click through them; undo actually protects data."
 *
 * So this is the *second* line of defence, not the first. If a caller reaches
 * for it without also implementing undo, the data is not protected.
 */
export function AlertDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
  onConfirm,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly description: string;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  readonly onConfirm: () => void;
}): ReactNode {
  return (
    <AlertDialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialogPrimitive.Portal>
        <AlertDialogPrimitive.Overlay className="nos-overlay" />
        <AlertDialogPrimitive.Content className="nos-dialog nos-dialog--sm">
          <AlertDialogPrimitive.Title asChild>
            <Text role="title-3" as="h2">
              {title}
            </Text>
          </AlertDialogPrimitive.Title>
          <AlertDialogPrimitive.Description asChild>
            <Text role="body-sm" tone="secondary">
              {description}
            </Text>
          </AlertDialogPrimitive.Description>

          <div className="nos-dialog__footer">
            {/* Cancel first in the DOM, so it is the first tab stop and the
                default focus target. The destructive action should never be
                one stray Enter away. */}
            <AlertDialogPrimitive.Cancel asChild>
              <Button variant="secondary">{cancelLabel}</Button>
            </AlertDialogPrimitive.Cancel>
            <AlertDialogPrimitive.Action asChild>
              <Button variant="destructive" onClick={onConfirm}>
                {confirmLabel}
              </Button>
            </AlertDialogPrimitive.Action>
          </div>
        </AlertDialogPrimitive.Content>
      </AlertDialogPrimitive.Portal>
    </AlertDialogPrimitive.Root>
  );
}

/* =========================================================================
 * Sheet — bottom on mobile, side on desktop
 * ====================================================================== */

export type SheetProps = {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly description?: string;
  readonly children?: ReactNode;
  readonly footer?: ReactNode;
  /**
   * `bottom` is the default and the important one.
   *
   * §8.12: "Sheets are the primary mobile pattern — bottom sheets are
   * reachable one-handed, which matters when logging a set with a phone in one
   * hand." A right-side sheet on a phone requires a reach across the screen.
   */
  readonly side?: 'bottom' | 'right';
};

/**
 * A sheet, implemented with Vaul.
 *
 * Vaul rather than a styled Radix Dialog because of one behaviour that cannot
 * be added afterwards: drag-to-dismiss with velocity, including the rubber-band
 * resistance and the snap. On a phone that is how a sheet is actually closed —
 * the close button is the fallback, not the primary gesture. Vaul is built on
 * Radix Dialog, so the focus semantics above still hold.
 */
export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  side = 'bottom',
}: SheetProps): ReactNode {
  return (
    <DrawerPrimitive.Root open={open} onOpenChange={onOpenChange} direction={side}>
      <DrawerPrimitive.Portal>
        <DrawerPrimitive.Overlay className="nos-overlay" />
        <DrawerPrimitive.Content className={cn('nos-sheet', `nos-sheet--${side}`)}>
          {side === 'bottom' && (
            // The grab handle. Also the visual affordance that this is
            // draggable — without it, users do not discover the gesture.
            <div className="nos-sheet__handle" aria-hidden="true" />
          )}

          <div className="nos-sheet__header">
            <DrawerPrimitive.Title asChild>
              <Text role="title-3" as="h2">
                {title}
              </Text>
            </DrawerPrimitive.Title>
            <DrawerPrimitive.Close asChild>
              <IconButton icon="nav.close" label="Close" size="sm" />
            </DrawerPrimitive.Close>
          </div>

          {description !== undefined ? (
            <DrawerPrimitive.Description asChild>
              <Text role="body-sm" tone="secondary">
                {description}
              </Text>
            </DrawerPrimitive.Description>
          ) : (
            // Radix requires a description for the aria wiring; when there is
            // nothing meaningful to say, the title is reused rather than
            // leaving the dialog undescribed.
            <DrawerPrimitive.Description className="nos-visually-hidden">
              {title}
            </DrawerPrimitive.Description>
          )}

          <div className="nos-sheet__body">{children}</div>
          {footer !== undefined && <div className="nos-sheet__footer">{footer}</div>}
        </DrawerPrimitive.Content>
      </DrawerPrimitive.Portal>
    </DrawerPrimitive.Root>
  );
}

/* =========================================================================
 * Popover
 * ====================================================================== */

export function Popover({
  trigger,
  children,
  align = 'center',
  side = 'bottom',
}: {
  readonly trigger: ReactNode;
  readonly children: ReactNode;
  readonly align?: 'start' | 'center' | 'end';
  readonly side?: 'top' | 'right' | 'bottom' | 'left';
}): ReactNode {
  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger asChild>{trigger}</PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          className="nos-popover"
          align={align}
          side={side}
          sideOffset={8}
          // Keeps the panel on screen near a viewport edge rather than
          // clipping — the common failure on a 360px phone.
          collisionPadding={12}
        >
          {children}
          <PopoverPrimitive.Arrow className="nos-popover__arrow" />
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

/* =========================================================================
 * Tooltip
 * ====================================================================== */

/**
 * Provider for the tooltip system. Mounted once, near the root.
 *
 * Radix shares open/close timing across tooltips through this provider, which
 * is what produces the "first one waits, subsequent ones appear instantly"
 * behaviour users expect from a toolbar.
 */
export function TooltipProvider({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <TooltipPrimitive.Provider delayDuration={400} skipDelayDuration={300}>
      {children}
    </TooltipPrimitive.Provider>
  );
}

/**
 * A supplementary label.
 *
 * §8.12: "Supplementary label — **never essential information**." A tooltip is
 * invisible on touch devices and to most screen readers until focused. If the
 * content matters, it belongs in the layout.
 */
export function Tooltip({
  content,
  children,
  side = 'top',
}: {
  readonly content: string;
  readonly children: ReactNode;
  readonly side?: 'top' | 'right' | 'bottom' | 'left';
}): ReactNode {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content className="nos-tooltip" side={side} sideOffset={6}>
          {content}
          <TooltipPrimitive.Arrow className="nos-tooltip__arrow" />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

/* =========================================================================
 * DropdownMenu
 * ====================================================================== */

export type MenuItem = {
  readonly id: string;
  readonly label: string;
  readonly icon?: IconName;
  readonly onSelect?: (() => void) | undefined;
  readonly destructive?: boolean;
  readonly disabled?: boolean | undefined;
  /** Renders a separator above this item. */
  readonly separatorBefore?: boolean;
};

export function DropdownMenu({
  trigger,
  items,
  align = 'end',
  label,
}: {
  readonly trigger: ReactNode;
  readonly items: readonly MenuItem[];
  readonly align?: 'start' | 'center' | 'end';
  /** Accessible name for the menu itself. */
  readonly label: string;
}): ReactNode {
  return (
    <DropdownPrimitive.Root>
      <DropdownPrimitive.Trigger asChild>{trigger}</DropdownPrimitive.Trigger>
      <DropdownPrimitive.Portal>
        <DropdownPrimitive.Content
          className="nos-menu"
          align={align}
          sideOffset={6}
          collisionPadding={12}
          aria-label={label}
        >
          {items.map((item) => (
            <div key={item.id}>
              {item.separatorBefore === true && (
                <DropdownPrimitive.Separator className="nos-menu__separator" />
              )}
              <DropdownPrimitive.Item
                className={cn('nos-menu__item', item.destructive === true && 'is-destructive')}
                // Spread rather than passed: `exactOptionalPropertyTypes`
                // distinguishes an absent prop from an explicit `undefined`,
                // and Radix's props reject the latter.
                {...(item.disabled === undefined ? {} : { disabled: item.disabled })}
                {...(item.onSelect === undefined ? {} : { onSelect: item.onSelect })}
              >
                {item.icon !== undefined && <Icon name={item.icon} label={null} size="sm" />}
                {item.label}
              </DropdownPrimitive.Item>
            </div>
          ))}
        </DropdownPrimitive.Content>
      </DropdownPrimitive.Portal>
    </DropdownPrimitive.Root>
  );
}
