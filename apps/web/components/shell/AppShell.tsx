'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useRef, type ReactNode } from 'react';

import { useNavigationStore } from '@/lib/stores/navigation.store';
import { QuickCapture, SyncBanner } from '@/features/capture';
import { CommandPalette } from './CommandPalette';
import { MobileNav } from './MobileNav';
import { Sidebar } from './Sidebar';
import { SettingsDrawer } from './SettingsDrawer';
import { TopBar } from './TopBar';

/**
 * The application shell.
 *
 * Responsive by layout rather than by branching: the sidebar and the mobile tab
 * bar are both always rendered, and CSS decides which is visible. Two
 * consequences worth stating.
 *
 * Rendering both means no layout shift when the viewport crosses a breakpoint,
 * and no JavaScript-measured width — which would be wrong on first paint and
 * would break with the viewport resized before hydration.
 *
 * §8.4's "mobile-first without qualification" is honoured the other way round
 * from how it usually is: the mobile layout is the unqualified default, and the
 * sidebar appears at `lg` as progressive enhancement. There is no
 * `max-width` query anywhere in the shell.
 */

export type AppShellProps = {
  readonly children: ReactNode;
  /** Rendered in the top bar and the profile menu. */
  readonly account: { readonly email: string; readonly role: string };
  /** The profile's IANA zone — what a captured observation is stamped with (§5.3). */
  readonly zone: string;
};

export function AppShell({ children, account, zone }: AppShellProps): ReactNode {
  const pathname = usePathname();
  const closeAllOverlays = useNavigationStore((state) => state.closeAllOverlays);
  const toggleCommandPalette = useNavigationStore((state) => state.toggleCommandPalette);

  /**
   * Close transient surfaces on navigation.
   *
   * Without this, opening the palette, navigating, and landing on a new page
   * leaves the palette open over unrelated content. It is the most common shell
   * bug and it only appears once routing actually works, which is late.
   *
   * The first run is skipped. Nothing can be open on mount, so the call was
   * always a no-op — except in the one case where it was not: a deep link
   * arriving at `/today?capture=mood` has the sheet opened by a child effect,
   * and child effects run before the parent's. Clearing overlays on mount would
   * therefore close the sheet the URL asked for, before the first paint, and
   * leave the operator on `/today` with no explanation.
   */
  const navigated = useRef(false);
  useEffect(() => {
    if (!navigated.current) {
      navigated.current = true;
      return;
    }
    closeAllOverlays();
  }, [pathname, closeAllOverlays]);

  /**
   * ⌘K / Ctrl+K.
   *
   * Registered once here rather than inside the palette, because the palette is
   * unmounted while closed and cannot listen for the key that opens it.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        toggleCommandPalette();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [toggleCommandPalette]);

  return (
    <div className="app-shell">
      {/* First tab stop on every page (§8.13). */}
      <a className="nos-skip-link" href="#main">
        Skip to content
      </a>

      <Sidebar />

      <div className="app-shell__main">
        <TopBar account={account} />

        {/*
          `id="main"` is the skip-link target and `tabIndex={-1}` makes it
          focusable programmatically — without it, the skip link moves the
          viewport but not focus, and a keyboard user's next Tab returns them to
          the navigation they were trying to skip.
        */}
        <main id="main" className="app-shell__content" tabIndex={-1}>
          {/*
            The unsynced banner sits above the page rather than inside it, and
            that placement is the requirement rather than a layout choice: §5.7
            wants the state "visible", which means visible on whatever route the
            operator happens to be on when a drain starts failing.
          */}
          <SyncBanner />
          {children}
        </main>
      </div>

      <MobileNav />

      {/* Overlays live at the shell level so they are not unmounted by a route
          change mid-transition, and so their portals sit above everything. */}
      <CommandPalette />
      <SettingsDrawer />

      {/*
        §3.3(4): "Quick capture is global... Capture must never require
        navigation." Mounted at the shell so its keyboard chord is live on every
        route and its sheet opens over whatever is already on screen.
      */}
      <QuickCapture zone={zone} />
    </div>
  );
}
