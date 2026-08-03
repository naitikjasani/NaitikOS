'use client';

import * as TabsPrimitive from '@radix-ui/react-tabs';
import * as ToggleGroupPrimitive from '@radix-ui/react-toggle-group';
import type { ReactNode } from 'react';

import { cn } from '../lib/cn';
import { Icon } from '../icons/Icon';
import type { IconName } from '../icons/registry';

/**
 * In-page navigation: tabs and segmented controls.
 *
 * The two look similar and are not interchangeable:
 *
 *   - **Tabs** switch between panels of content. The selected tab controls
 *     what is rendered below it, and `role="tabpanel"` ties them together for
 *     assistive technology.
 *   - **SegmentedControl** picks a value. Nothing is "below" it; it filters or
 *     configures something elsewhere on the page.
 *
 * Using tabs for a filter produces an announcement of "tab panel" for content
 * that is not one, which is why they are separate components rather than one
 * with a `variant` prop.
 */

/* =========================================================================
 * Tabs
 * ====================================================================== */

export type TabItem = {
  readonly id: string;
  readonly label: string;
  readonly icon?: IconName;
  readonly content: ReactNode;
  readonly disabled?: boolean;
};

export function Tabs({
  items,
  value,
  onValueChange,
  label,
  className,
}: {
  readonly items: readonly TabItem[];
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  /** Accessible name for the tab list. */
  readonly label: string;
  readonly className?: string;
}): ReactNode {
  return (
    <TabsPrimitive.Root
      value={value}
      onValueChange={onValueChange}
      className={cn('nos-tabs', className)}
    >
      <TabsPrimitive.List className="nos-tabs__list" aria-label={label}>
        {items.map((item) => (
          <TabsPrimitive.Trigger
            key={item.id}
            value={item.id}
            disabled={item.disabled}
            className="nos-tabs__trigger"
          >
            {item.icon !== undefined && <Icon name={item.icon} label={null} size="sm" />}
            {item.label}
          </TabsPrimitive.Trigger>
        ))}
      </TabsPrimitive.List>

      {items.map((item) => (
        <TabsPrimitive.Content key={item.id} value={item.id} className="nos-tabs__panel">
          {item.content}
        </TabsPrimitive.Content>
      ))}
    </TabsPrimitive.Root>
  );
}

/* =========================================================================
 * SegmentedControl
 * ====================================================================== */

export type SegmentOption<T extends string> = {
  readonly value: T;
  readonly label: string;
  readonly icon?: IconName;
  readonly disabled?: boolean;
};

/**
 * A single-select control rendered as adjacent segments.
 *
 * Built on Radix ToggleGroup with `type="single"`, which gives arrow-key
 * navigation and a single tab stop. The selection cannot be emptied —
 * `onValueChange` ignores the empty string that ToggleGroup emits when the
 * active item is re-pressed, because a segmented control with nothing selected
 * is a state the caller has no way to render sensibly.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onValueChange,
  label,
  size = 'md',
  fullWidth = false,
  className,
}: {
  readonly options: readonly SegmentOption<T>[];
  readonly value: T;
  readonly onValueChange: (value: T) => void;
  readonly label: string;
  readonly size?: 'sm' | 'md';
  readonly fullWidth?: boolean;
  readonly className?: string;
}): ReactNode {
  return (
    <ToggleGroupPrimitive.Root
      type="single"
      value={value}
      onValueChange={(next) => {
        // Radix emits '' when the active item is toggled off. Ignored: this is
        // a required single choice.
        if (next !== '') onValueChange(next as T);
      }}
      aria-label={label}
      className={cn(
        'nos-segmented',
        `nos-segmented--${size}`,
        fullWidth && 'nos-segmented--full',
        className,
      )}
    >
      {options.map((option) => (
        <ToggleGroupPrimitive.Item
          key={option.value}
          value={option.value}
          disabled={option.disabled}
          className="nos-segmented__item"
        >
          {option.icon !== undefined && <Icon name={option.icon} label={null} size="sm" />}
          {option.label}
        </ToggleGroupPrimitive.Item>
      ))}
    </ToggleGroupPrimitive.Root>
  );
}

/* =========================================================================
 * Breadcrumbs
 * ====================================================================== */

export type Crumb = {
  readonly label: string;
  /** Absent on the final crumb, which is the current page. */
  readonly href?: string;
};

/**
 * Breadcrumbs.
 *
 * §3.3 caps route depth at three, so these are short by construction — which
 * is the only reason they are worth rendering at all. A breadcrumb trail long
 * enough to wrap is a navigation structure that has already failed.
 *
 * The current page carries `aria-current="page"` and is not a link. Linking
 * the page you are on is a small lie that screen-reader users notice.
 */
export function Breadcrumbs({
  crumbs,
  className,
  renderLink,
}: {
  readonly crumbs: readonly Crumb[];
  readonly className?: string;
  /**
   * Injected so the design system does not import a router.
   *
   * §6.2 keeps this package domain- and framework-agnostic; a `next/link`
   * import here would weld it to Next.
   */
  readonly renderLink: (href: string, children: ReactNode) => ReactNode;
}): ReactNode {
  return (
    <nav aria-label="Breadcrumb" className={cn('nos-breadcrumbs', className)}>
      <ol className="nos-breadcrumbs__list" role="list">
        {crumbs.map((crumb, index) => {
          const isLast = index === crumbs.length - 1;
          return (
            <li key={`${crumb.label}-${String(index)}`} className="nos-breadcrumbs__item">
              {isLast || crumb.href === undefined ? (
                <span aria-current={isLast ? 'page' : undefined}>{crumb.label}</span>
              ) : (
                renderLink(crumb.href, crumb.label)
              )}
              {!isLast && (
                <Icon name="nav.next" label={null} size="sm" className="nos-breadcrumbs__sep" />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
