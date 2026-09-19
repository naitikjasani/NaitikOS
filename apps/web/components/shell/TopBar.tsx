'use client';

import type { ReactNode } from 'react';
import { Avatar, DropdownMenu, Icon, IconButton, Text, Tooltip } from '@naitikos/design-system';

import { useNavigationStore } from '@/lib/stores/navigation.store';
import { useSession } from '@/features/auth';
import { RouteProgress } from './RouteProgress';

/**
 * The top bar.
 *
 * Sticky rather than fixed, so it scrolls with a long page on mobile and does
 * not permanently occupy 56px of a 667px viewport. §8.4's mobile-first stance
 * is about vertical space as much as width.
 *
 * ## What it holds, and what it no longer holds
 *
 * It used to carry breadcrumbs, hidden below `md`. Those have moved into the
 * page header (`PageBreadcrumbs`), next to the heading they qualify and visible
 * at every width. What is left is deliberately only things that are true on
 * every one of §3.2's ninety routes:
 *
 *   - the palette trigger, which on desktop is the primary way to reach a route
 *     that is not the one you are on (§2.5 makes it the search architecture);
 *   - who is signed in, and the way out;
 *   - whether a navigation is in flight.
 *
 * On a phone the trigger takes the whole free row rather than shrinking to a
 * 32px icon. That is the trade this bar exists to make: if 56px of the scarcest
 * axis is going to be spent, it should buy a target the thumb can actually
 * find, not three tiny ones.
 */
export function TopBar({
  account,
}: {
  readonly account: { readonly email: string; readonly role: string };
}): ReactNode {
  const setCommandPaletteOpen = useNavigationStore((state) => state.setCommandPaletteOpen);
  const setSettingsOpen = useNavigationStore((state) => state.setSettingsOpen);
  const { signOut, isSigningOut } = useSession();

  return (
    <header className="topbar" data-shell-nav>
      <div className="topbar__inner">
        {/*
          The wordmark stands in for the sidebar's brand below `lg`, where there
          is no sidebar. Hidden at `lg` rather than duplicated, so the name
          appears exactly once on screen at every width.
        */}
        <Text role="title-3" as="p" className="topbar__brand">
          Ekayu
        </Text>

        {/*
          Search is the command palette.
          One surface rather than two: §3.2 lists no separate search route, and
          §2.5 forbids "an in-app 'everything' search that queries live LLM
          context". The palette is the search architecture.
        */}
        <Tooltip content="Search and commands  ⌘K">
          <button
            type="button"
            className="topbar__search"
            onClick={() => {
              setCommandPaletteOpen(true);
            }}
          >
            <Icon name="action.search" label={null} size="sm" />
            <Text role="body-sm" tone="tertiary" as="span" className="topbar__search-label">
              Search or jump to…
            </Text>
            <kbd className="topbar__kbd" aria-hidden="true">
              ⌘K
            </kbd>
          </button>
        </Tooltip>

        {/*
          Notifications placeholder, and desktop-only.
          §5.9: "Opt-in per category, off by default, no exceptions." Everything
          is off at this milestone, so there is nothing to show — and P6 forbids
          a badge that manufactures urgency. A permanently disabled control is
          not worth 44px of a phone's top bar, so below `lg` it is absent; the
          setting that turns notifications on lives in `/settings/notifications`
          either way.
        */}
        <div className="topbar__desktop-only">
          <Tooltip content="Notifications — none enabled">
            <IconButton
              icon="identity.notifications-off"
              label="Notifications — none enabled"
              size="sm"
              disabled
            />
          </Tooltip>
        </div>

        <DropdownMenu
          label="Account"
          trigger={
            <button
              type="button"
              className="topbar__profile"
              aria-label={`Account: ${account.email}`}
            >
              <Avatar name={account.email} size="sm" />
            </button>
          }
          items={[
            { id: 'email', label: account.email, disabled: true },
            { id: 'role', label: `Role: ${account.role}`, disabled: true },
            {
              id: 'settings',
              label: 'Settings',
              icon: 'nav.settings',
              separatorBefore: true,
              onSelect: () => {
                setSettingsOpen(true);
              },
            },
            {
              id: 'sign-out',
              label: isSigningOut ? 'Signing out…' : 'Sign out',
              icon: 'action.sign-out',
              destructive: true,
              separatorBefore: true,
              onSelect: () => {
                void signOut();
              },
            },
          ]}
        />
      </div>

      {/*
        Pinned to the bar's lower edge rather than the viewport's, so it sits on
        the boundary between chrome and content — which is the boundary that is
        about to change.
      */}
      <RouteProgress />
    </header>
  );
}
