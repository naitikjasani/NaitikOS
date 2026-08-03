'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { Icon, Text, cn } from '@naitikos/design-system';

import type { NavItem } from '@/lib/navigation/config';

/**
 * One navigation entry.
 *
 * Shared by the sidebar and the mobile tab bar so the active-state logic and the
 * aria wiring exist once. `aria-current="page"` is what a screen reader uses to
 * announce "current page"; a class alone conveys nothing.
 */
export function NavLink({
  item,
  isActive,
  variant,
  onNavigate,
}: {
  readonly item: NavItem;
  readonly isActive: boolean;
  readonly variant: 'sidebar' | 'tab';
  readonly onNavigate?: () => void;
}): ReactNode {
  const className = cn(
    variant === 'sidebar' ? 'nav-link' : 'tab-link',
    isActive && 'is-active',
    !item.available && 'is-unavailable',
  );

  const contents = (
    <>
      <Icon name={item.icon} label={null} size={variant === 'tab' ? 'md' : 'sm'} />
      <Text role={variant === 'tab' ? 'caption' : 'body-sm'} tone="inherit" as="span">
        {item.label}
      </Text>
    </>
  );

  /**
   * An unavailable route renders as a disabled button, not a link.
   *
   * A development-only affordance (§3.3 R6 removes these entirely in
   * production). A `<span>` would be invisible to keyboard users; a `<button
   * disabled>` is announced as unavailable, which is the truth.
   */
  if (!item.available) {
    return (
      <button type="button" className={className} disabled aria-disabled="true">
        {contents}
        <span className="nos-visually-hidden">not built yet</span>
      </button>
    );
  }

  return (
    <Link
      href={item.href}
      className={className}
      aria-current={isActive ? 'page' : undefined}
      // Spread rather than passed: `exactOptionalPropertyTypes` treats an
      // explicit `undefined` as distinct from an absent prop, and Next's
      // LinkProps rejects the former.
      {...(onNavigate === undefined ? {} : { onClick: onNavigate })}
      // Prefetch is Next's default and is right here: the nav is five entries,
      // all of them likely, and the payloads are small.
    >
      {contents}
    </Link>
  );
}
