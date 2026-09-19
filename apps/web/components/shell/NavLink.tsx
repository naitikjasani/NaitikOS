'use client';

import Link from 'next/link';
import type { MouseEvent, ReactNode } from 'react';
import { Icon, Text, cn } from '@naitikos/design-system';
import type { IconName } from '@naitikos/design-system';

import { useNavigationStore } from '@/lib/stores/navigation.store';

export type NavLinkVariant = 'sidebar' | 'subnav' | 'tab';

/**
 * Where this entry sits relative to the current route.
 *
 * `branch` is the one worth naming: on `/body/gym/programs/abc123` the Body
 * entry is neither the current page nor an unrelated one, and collapsing that
 * middle case into "not active" is what makes a deep route feel like it has
 * escaped the navigation.
 */
export type NavLinkState = 'current' | 'branch' | 'idle';

/**
 * One navigation entry.
 *
 * Shared by the sidebar, its nested lists, and the mobile tab bar, so the
 * active-state logic and the aria wiring exist once.
 *
 * `aria-current="page"` marks the exact route and nothing else. A `branch`
 * ancestor deliberately does *not* get it: the relationship is already carried
 * structurally, because the expanded list beneath the ancestor contains the
 * current item, and a second "current" announcement in the same tree is a
 * screen-reader user being told they are in two places at once.
 *
 * Per §8.13, no state here is carried by colour alone — `current` adds an inset
 * rule, `branch` adds a spine down its subtree, and `unavailable` renders as a
 * genuinely disabled control that assistive technology announces as such.
 */
export function NavLink({
  href,
  label,
  icon,
  variant,
  state,
  available = true,
  onNavigate,
}: {
  readonly href: string;
  readonly label: string;
  // `| undefined` is explicit throughout: under `exactOptionalPropertyTypes` a
  // bare `?` rejects a caller forwarding a possibly-absent field, which every
  // caller here does.
  readonly icon?: IconName | undefined;
  readonly variant: NavLinkVariant;
  readonly state: NavLinkState;
  readonly available?: boolean | undefined;
  readonly onNavigate?: (() => void) | undefined;
}): ReactNode {
  const pendingHref = useNavigationStore((store) => store.pendingHref);
  const beginNavigation = useNavigationStore((store) => store.beginNavigation);

  const isPending = pendingHref === href && state !== 'current';

  const className = cn(
    variant === 'tab' ? 'tab-link' : 'nav-link',
    variant === 'subnav' && 'nav-link--sub',
    state === 'current' && 'is-active',
    state === 'branch' && 'is-branch',
    !available && 'is-unavailable',
  );

  const contents = (
    <>
      {icon !== undefined && (
        <Icon name={icon} label={null} size={variant === 'tab' ? 'md' : 'sm'} />
      )}
      <Text role={variant === 'tab' ? 'caption' : 'body-sm'} tone="inherit" as="span">
        {label}
      </Text>
      {/*
        Announced, not drawn. The visual signal for a pending navigation is the
        optimistic active state on this row plus the progress track under the
        top bar; a spinner in a tab bar at 44px would displace the label.
      */}
      {isPending && <span className="nos-visually-hidden">Loading</span>}
    </>
  );

  /**
   * An unavailable route renders as a disabled button, not a link.
   *
   * A development-only affordance (§3.3 R6 removes these entirely in
   * production). A `<span>` would be invisible to keyboard users; a `<button
   * disabled>` is announced as unavailable, which is the truth.
   */
  if (!available) {
    return (
      <button type="button" className={className} disabled aria-disabled="true">
        {contents}
        <span className="nos-visually-hidden">not built yet</span>
      </button>
    );
  }

  /**
   * The click handler exists to record navigation *intent*.
   *
   * Modified clicks are excluded because they do not navigate this document —
   * a ⌘-click opens a tab and leaves `pathname` unchanged, so the pending state
   * would have nothing to clear it and the shell would sit lit up forever.
   * Same-route clicks are excluded for the same reason.
   */
  const handleClick = (event: MouseEvent<HTMLAnchorElement>): void => {
    onNavigate?.();
    const isPlainClick =
      event.button === 0 &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.shiftKey &&
      !event.altKey &&
      !event.defaultPrevented;
    if (isPlainClick && state !== 'current') beginNavigation(href);
  };

  return (
    <Link
      href={href}
      className={className}
      aria-current={state === 'current' ? 'page' : undefined}
      data-pending={isPending ? 'true' : undefined}
      onClick={handleClick}
      // Prefetch is Next's default and is right for the surfaces: the tab bar
      // is five entries and the sidebar only ever renders one pillar's interior
      // at a time, so the prefetch fan-out is bounded by the disclosure state
      // rather than by the ninety routes in the tree.
    >
      {contents}
    </Link>
  );
}
