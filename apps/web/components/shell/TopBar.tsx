'use client';

import { usePathname } from 'next/navigation';
import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  Avatar,
  Breadcrumbs,
  DropdownMenu,
  Icon,
  IconButton,
  Inline,
  Spacer,
  Text,
  Tooltip,
} from '@naitikos/design-system';

import { breadcrumbsFor } from '@/lib/navigation/config';
import { useNavigationStore } from '@/lib/stores/navigation.store';
import { useSession } from '@/features/auth';

/**
 * The top bar: breadcrumbs, search, notifications, profile.
 *
 * Sticky rather than fixed, so it scrolls with a long page on mobile and does
 * not permanently occupy 56px of a 667px viewport. §8.4's mobile-first stance
 * is about vertical space as much as width.
 */
export function TopBar({
  account,
}: {
  readonly account: { readonly email: string; readonly role: string };
}): ReactNode {
  const pathname = usePathname();
  const crumbs = breadcrumbsFor(pathname);
  const setCommandPaletteOpen = useNavigationStore((state) => state.setCommandPaletteOpen);
  const setSettingsOpen = useNavigationStore((state) => state.setSettingsOpen);
  const { signOut, isSigningOut } = useSession();

  return (
    <header className="topbar">
      <Inline gap="2" wrap={false} className="topbar__inner">
        {/*
          Breadcrumbs are hidden below `md` in CSS. On a phone the page title
          carries the context and a truncated trail is noise — §3.3 caps depth
          at three precisely so the trail is never load-bearing.
        */}
        {crumbs.length > 1 && (
          <div className="topbar__crumbs">
            <Breadcrumbs
              crumbs={crumbs}
              // Injected so the design system never imports a router (§6.2).
              renderLink={(href, children) => <Link href={href}>{children}</Link>}
            />
          </div>
        )}

        <Spacer />

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
              Search
            </Text>
            <kbd className="topbar__kbd" aria-hidden="true">
              ⌘K
            </kbd>
          </button>
        </Tooltip>

        {/*
          Notifications placeholder.
          §5.9: "Opt-in per category, off by default, no exceptions." Everything
          is off at this milestone, so there is nothing to show — and P6 forbids
          a badge that manufactures urgency. It renders as an empty affordance
          rather than a count.
        */}
        <Tooltip content="Notifications — none enabled">
          <IconButton
            icon="identity.notifications-off"
            label="Notifications — none enabled"
            size="sm"
            disabled
          />
        </Tooltip>

        <DropdownMenu
          label="Account"
          trigger={
            <button type="button" className="topbar__profile" aria-label={`Account: ${account.email}`}>
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
      </Inline>
    </header>
  );
}
