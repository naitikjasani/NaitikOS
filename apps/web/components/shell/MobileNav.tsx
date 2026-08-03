'use client';

import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

import {
  MOBILE_NAV_LIMIT,
  activeNavId,
  showsUnbuiltRoutes,
  visibleNavItems,
} from '@/lib/navigation/config';
import { NavLink } from './NavLink';

/**
 * The mobile tab bar.
 *
 * Bottom-placed, which is not a style choice: §8.12 notes bottom sheets are
 * "reachable one-handed, which matters when logging a set with a phone in one
 * hand", and the same reach argument applies to navigation. A top tab bar on a
 * 6-inch phone requires a grip change.
 *
 * Capped at four entries (see `MOBILE_NAV_LIMIT`). A fifth makes each target
 * narrower than the 44px §8.13 requires on a 360px screen.
 */
export function MobileNav(): ReactNode {
  const pathname = usePathname();
  const active = activeNavId(pathname);
  const items = visibleNavItems(showsUnbuiltRoutes()).slice(0, MOBILE_NAV_LIMIT);

  return (
    <nav className="mobile-nav" aria-label="Primary">
      <ul className="mobile-nav__list" role="list">
        {items.map((item) => (
          <li key={item.id} className="mobile-nav__item">
            <NavLink item={item} isActive={active === item.id} variant="tab" />
          </li>
        ))}
      </ul>
    </nav>
  );
}
