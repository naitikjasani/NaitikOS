'use client';

import { create } from 'zustand';

/**
 * Navigation UI state.
 *
 * §5.1: "Zustand: strictly ephemeral UI state: sheet open, rail configuration,
 * active timer." Every field here qualifies — none of it is worth persisting,
 * and none of it comes from a server.
 *
 * §7.3's test applied: "If a store field could be refetched from the server, it
 * is in the wrong place." A collapsed sidebar cannot be refetched; it is a fact
 * about this browser window in this moment.
 *
 * The one judgement call is `isSidebarCollapsed`, which a user might reasonably
 * expect to survive a reload. It is deliberately *not* persisted: on a tablet
 * the sidebar collapses for width reasons, and persisting that would leave a
 * desktop session mysteriously narrow after one visit on a smaller screen.
 */

export type NavigationState = {
  /** Desktop sidebar. Width-driven on smaller screens, user-driven on wide. */
  readonly isSidebarCollapsed: boolean;
  /** Mobile navigation drawer. */
  readonly isMobileNavOpen: boolean;
  /** The command palette (⌘K). */
  readonly isCommandPaletteOpen: boolean;
  /**
   * The quick-capture kind currently open, by its metric key, or `null`.
   *
   * In the shell store rather than inside `QuickCapture` because two surfaces
   * open it: the `c`-leader chord (§3.3(4)) and the command palette. A sheet
   * whose state lives inside one of its two triggers cannot be opened by the
   * other without an imperative handle, and a handle threaded through the shell
   * is a worse coupling than one field here.
   */
  readonly captureKind: string | null;
  /** The settings sheet. */
  readonly isSettingsOpen: boolean;
  /**
   * Explicit sidebar disclosure decisions, keyed by node href.
   *
   * Absent means "follow the route": a pillar containing the current page is
   * open, everything else is closed. That default is right almost always and
   * needs no state at all — the entry only appears once the operator overrides
   * it, which they do when *browsing* rather than navigating.
   *
   * Storing overrides rather than open/closed booleans is what keeps the two
   * behaviours from fighting. A plain `openIds` set would have to be rewritten
   * on every navigation to re-derive the automatic part, and any such rewrite
   * silently discards the operator's choice.
   */
  readonly navGroupOverrides: Readonly<Record<string, boolean>>;
  /**
   * The destination of a navigation that has started but not yet landed.
   *
   * Server components stream, so a tap on a slow route produces no feedback at
   * all until the first byte arrives. This is the signal the shell uses to say
   * "that registered" — an optimistic active state on the tapped item and a
   * progress track under the top bar. It is not a spinner over the content:
   * §8.6 keeps motion functional, and blanking a page the operator can still
   * read is a regression, not feedback.
   */
  readonly pendingHref: string | null;
  /**
   * Recently visited destinations, most recent first.
   *
   * In memory only, and that is a privacy decision rather than an oversight
   * (P7). A persisted route history is a health-inference vector: "opened
   * /body/skin/treatments eleven times this month" is a diagnosis written in
   * localStorage, readable by anything with script access on this origin. A
   * session's worth of recents is most of the ranking benefit at none of that
   * cost.
   */
  readonly recentHrefs: readonly string[];

  readonly toggleSidebar: () => void;
  readonly setSidebarCollapsed: (collapsed: boolean) => void;
  readonly setMobileNavOpen: (open: boolean) => void;
  readonly setCommandPaletteOpen: (open: boolean) => void;
  readonly toggleCommandPalette: () => void;
  readonly openCapture: (metricKey: string) => void;
  readonly closeCapture: () => void;
  readonly setSettingsOpen: (open: boolean) => void;
  readonly toggleNavGroup: (href: string, isOpenByRoute: boolean) => void;
  readonly beginNavigation: (href: string) => void;
  readonly endNavigation: () => void;
  readonly recordVisit: (href: string) => void;
  /**
   * Close every transient surface.
   *
   * Called on route change. Without it, opening the command palette,
   * navigating, and arriving at a new page leaves the palette open over
   * unrelated content — the single most common shell bug.
   */
  readonly closeAllOverlays: () => void;
};

export const useNavigationStore = create<NavigationState>((set) => ({
  isSidebarCollapsed: false,
  isMobileNavOpen: false,
  isCommandPaletteOpen: false,
  captureKind: null,
  isSettingsOpen: false,
  navGroupOverrides: {},
  pendingHref: null,
  recentHrefs: [],

  toggleSidebar: () => {
    set((state) => ({ isSidebarCollapsed: !state.isSidebarCollapsed }));
  },
  setSidebarCollapsed: (isSidebarCollapsed) => {
    set({ isSidebarCollapsed });
  },
  setMobileNavOpen: (isMobileNavOpen) => {
    set({ isMobileNavOpen });
  },
  setCommandPaletteOpen: (isCommandPaletteOpen) => {
    set({ isCommandPaletteOpen });
  },
  toggleCommandPalette: () => {
    set((state) => ({ isCommandPaletteOpen: !state.isCommandPaletteOpen }));
  },
  openCapture: (captureKind) => {
    // The palette closes as capture opens: §3.3(4)'s "capture must never
    // require navigation" is about not *moving*, and leaving a palette open
    // behind a sheet is two overlays deep for a three-tap interaction.
    set({ captureKind, isCommandPaletteOpen: false });
  },
  closeCapture: () => {
    set({ captureKind: null });
  },
  setSettingsOpen: (isSettingsOpen) => {
    set({ isSettingsOpen });
  },
  /**
   * `isOpenByRoute` is passed in rather than derived here, because the store
   * has no business knowing the route tree. The caller says what the automatic
   * answer currently is; this records the opposite of it.
   */
  toggleNavGroup: (href, isOpenByRoute) => {
    set((state) => {
      const current = state.navGroupOverrides[href] ?? isOpenByRoute;
      return { navGroupOverrides: { ...state.navGroupOverrides, [href]: !current } };
    });
  },
  beginNavigation: (pendingHref) => {
    set({ pendingHref });
  },
  endNavigation: () => {
    set({ pendingHref: null });
  },
  recordVisit: (href) => {
    set((state) => ({
      // Deduplicated then capped. Without the dedupe the list degenerates into
      // one destination repeated eight times after any back-and-forth, which is
      // exactly the browsing pattern recents are meant to shortcut.
      recentHrefs: [href, ...state.recentHrefs.filter((entry) => entry !== href)].slice(0, 8),
    }));
  },
  closeAllOverlays: () => {
    set({
      isMobileNavOpen: false,
      isCommandPaletteOpen: false,
      isSettingsOpen: false,
      captureKind: null,
    });
  },
}));
