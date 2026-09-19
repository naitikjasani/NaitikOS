'use client';

import { usePathname } from 'next/navigation';
import { useMemo, type ReactNode } from 'react';
import { Icon, Sheet, Text, cn } from '@naitikos/design-system';

import {
  MOBILE_NAV_LIMIT,
  activeNavId,
  showsUnbuiltRoutes,
  visibleNavItems,
} from '@/lib/navigation/config';
import { useNavigationStore } from '@/lib/stores/navigation.store';
import { NAV_SECTIONS, navTrail } from './navigation-tree';
import { NavLink } from './NavLink';

/**
 * The mobile tab bar.
 *
 * Bottom-placed, which is not a style choice: §8.12 notes bottom sheets are
 * "reachable one-handed, which matters when logging a set with a phone in one
 * hand", and the same reach argument applies to navigation. A top tab bar on a
 * 6-inch phone requires a grip change.
 *
 * ## Four tabs and a door
 *
 * `MOBILE_NAV_LIMIT` caps the *pillar* tabs at four, and that cap is still
 * right. But four tabs out of ninety routes left everything from `/library` to
 * `/settings/data/export` unreachable on a phone except through ⌘K — which does
 * not exist on a phone. The fifth entry is not a pillar; it is the door to the
 * rest of the tree, and it is the reason the sidebar's absence below `lg` is no
 * longer a loss of reach.
 *
 * The 44px arithmetic (§8.13) still holds at five: on the narrowest supported
 * viewport, 360px less two 8px gutters and four 8px separators gives 62px per
 * target. Six would give 50px before separators and is the point at which this
 * stops being safe, so five is the ceiling rather than a starting point.
 */
export function MobileNav(): ReactNode {
  const pathname = usePathname();
  const active = activeNavId(pathname);
  const items = visibleNavItems(showsUnbuiltRoutes()).slice(0, MOBILE_NAV_LIMIT);

  const isOpen = useNavigationStore((state) => state.isMobileNavOpen);
  const setOpen = useNavigationStore((state) => state.setMobileNavOpen);

  // A route outside the four tabs — `/library`, `/settings/privacy` — would
  // otherwise leave the whole bar unlit, which reads as "you are nowhere".
  const isElsewhere = active === null || !items.some((item) => item.id === active);

  return (
    <>
      <nav className="mobile-nav" aria-label="Primary" data-shell-nav>
        <ul className="mobile-nav__list" role="list">
          {items.map((item) => (
            <li key={item.id} className="mobile-nav__item">
              <NavLink
                href={item.href}
                label={item.label}
                icon={item.icon}
                variant="tab"
                state={active === item.id ? 'current' : 'idle'}
                available={item.available}
              />
            </li>
          ))}
          <li className="mobile-nav__item">
            <button
              type="button"
              className={cn('tab-link', isElsewhere && 'is-branch')}
              aria-haspopup="dialog"
              aria-expanded={isOpen}
              onClick={() => {
                setOpen(true);
              }}
            >
              <Icon name="nav.more" label={null} size="md" />
              <Text role="caption" tone="inherit" as="span">
                More
              </Text>
            </button>
          </li>
        </ul>
      </nav>

      <MobileNavSheet open={isOpen} onOpenChange={setOpen} pathname={pathname} />
    </>
  );
}

/**
 * The rest of the application, on a phone.
 *
 * A sheet rather than a full-screen route, because §8.12 makes sheets the
 * primary mobile pattern and because a navigation *page* would put an entry in
 * the history stack — the back button after choosing a destination would then
 * return the operator to a menu they have already used, which is the classic
 * mobile-nav history bug.
 *
 * Two levels deep only. The third level follows the route in the sidebar, but
 * on a phone the sheet is a jump table, not a map: showing ninety rows here
 * would need its own scroll-and-search, and the palette already is that.
 */
function MobileNavSheet({
  open,
  onOpenChange,
  pathname,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly pathname: string;
}): ReactNode {
  const trail = useMemo(() => navTrail(pathname), [pathname]);
  const onTrail = useMemo(() => new Set(trail.hrefs), [trail]);

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Everywhere else"
      description="Every surface in the system. The four tabs are the ones you use daily."
      side="bottom"
    >
      <div className="mobile-nav__sheet">
        {NAV_SECTIONS.map((section) => (
          <div className="mobile-nav__group" key={section.id}>
            <Text role="caption" tone="tertiary" as="h3" id={`mobile-nav-${section.id}`}>
              {section.label}
            </Text>
            <ul className="mobile-nav__grid" aria-labelledby={`mobile-nav-${section.id}`}>
              {section.items.map((item) => (
                <li key={item.href}>
                  <NavLink
                    href={item.href}
                    label={item.label}
                    icon={item.icon}
                    variant="sidebar"
                    state={
                      item.href === trail.currentHref
                        ? 'current'
                        : onTrail.has(item.href)
                          ? 'branch'
                          : 'idle'
                    }
                    onNavigate={() => {
                      // Closed on selection as well as on route change. The
                      // route-change close in AppShell fires only once the new
                      // page commits, and on a slow route that is a second of
                      // the sheet sitting there looking ignored.
                      onOpenChange(false);
                    }}
                  />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Sheet>
  );
}
