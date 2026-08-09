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

  readonly toggleSidebar: () => void;
  readonly setSidebarCollapsed: (collapsed: boolean) => void;
  readonly setMobileNavOpen: (open: boolean) => void;
  readonly setCommandPaletteOpen: (open: boolean) => void;
  readonly toggleCommandPalette: () => void;
  readonly openCapture: (metricKey: string) => void;
  readonly closeCapture: () => void;
  readonly setSettingsOpen: (open: boolean) => void;
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
  closeAllOverlays: () => {
    set({
      isMobileNavOpen: false,
      isCommandPaletteOpen: false,
      isSettingsOpen: false,
      captureKind: null,
    });
  },
}));
