'use client';

import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { Divider, IconButton, Stack, Text, cn } from '@naitikos/design-system';

import { activeNavId, showsUnbuiltRoutes, visibleNavItems } from '@/lib/navigation/config';
import { useNavigationStore } from '@/lib/stores/navigation.store';
import { NavLink } from './NavLink';

/**
 * The desktop sidebar.
 *
 * Hidden below `lg` in CSS rather than unmounted, so crossing the breakpoint
 * costs no re-render and no layout shift.
 *
 * Collapsing hides the labels and narrows the rail. The icons keep their
 * accessible names through `NavLink`'s visually-hidden text, so a collapsed
 * sidebar is still fully navigable by screen reader — §8.5's rule that an icon
 * is never the sole carrier of meaning applies to the collapsed state too.
 */
export function Sidebar(): ReactNode {
  const pathname = usePathname();
  const isCollapsed = useNavigationStore((state) => state.isSidebarCollapsed);
  const toggleSidebar = useNavigationStore((state) => state.toggleSidebar);

  const items = visibleNavItems(showsUnbuiltRoutes());
  const active = activeNavId(pathname);

  return (
    <nav
      className={cn('sidebar', isCollapsed && 'is-collapsed')}
      aria-label="Primary"
      data-collapsed={isCollapsed}
    >
      <div className="sidebar__brand">
        {!isCollapsed && (
          <Text role="title-3" as="p">
            NaitikOS
          </Text>
        )}
        <IconButton
          icon={isCollapsed ? 'nav.forward' : 'nav.back'}
          label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          size="sm"
          onClick={toggleSidebar}
        />
      </div>

      <Divider />

      <Stack gap="1" as="ul" className="sidebar__list">
        {items.map((item) => (
          <li key={item.id}>
            <NavLink item={item} isActive={active === item.id} variant="sidebar" />
          </li>
        ))}
      </Stack>
    </nav>
  );
}
