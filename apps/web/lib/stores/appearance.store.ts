'use client';

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { Density, MotionPreference, Theme } from '@naitikos/core';
import {
  DEFAULT_DENSITY,
  DEFAULT_MOTION,
  DEFAULT_THEME,
  DENSITIES,
  MOTION_PREFERENCES,
  THEMES,
} from '@naitikos/core';

/**
 * Appearance state — theme, density, motion.
 *
 * ## Why this is in a store at all, given the server already knows
 *
 * §5.1 draws a hard line: "**Zustand never holds server data.** That boundary
 * is enforced in review; violating it produces two sources of truth and is the
 * most common way this pairing goes wrong."
 *
 * Appearance sits deliberately on the ephemeral side of it, and the reason is
 * latency rather than architecture. Theme has to apply *before first paint* —
 * a server round trip means a flash of the wrong theme on every load, which on
 * a tool opened in a dark bedroom is not a cosmetic problem. So the browser
 * holds the applied value in `localStorage`, and the server's `setting` row
 * (§9.2) remains the durable record.
 *
 * That is two copies, which the rule exists to prevent — so the direction of
 * authority is fixed and stated: **the server row is the truth; this store is a
 * cache of it.** `hydrateFromServer` overwrites local; nothing writes the other
 * way except an explicit user action, which persists through the API and then
 * updates here.
 *
 * The alternative — reading the theme from a cookie in the server render — is
 * genuinely better and is recorded as debt in docs/app-shell.md. It was not
 * done here because it requires the theme to be known before `getAuthState`,
 * and that ordering interacts with the proxy in a way worth doing deliberately
 * rather than incidentally.
 */

export type AppearanceState = {
  readonly theme: Theme;
  readonly density: Density;
  readonly motion: MotionPreference;
  /** True once `localStorage` has been read; used to avoid a hydration mismatch. */
  readonly isHydrated: boolean;

  readonly setTheme: (theme: Theme) => void;
  readonly setDensity: (density: Density) => void;
  readonly setMotion: (motion: MotionPreference) => void;
  /** Overwrite from the server's `setting` row. The server wins. */
  readonly hydrateFromServer: (values: {
    theme: Theme;
    density: Density;
    motion: MotionPreference;
  }) => void;
};

const STORAGE_KEY = 'naitikos.appearance';

/** Narrow an untrusted persisted value, falling back rather than throwing. */
function oneOf<T extends string>(allowed: readonly T[], value: unknown, fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

export const useAppearanceStore = create<AppearanceState>()(
  persist(
    (set) => ({
      theme: DEFAULT_THEME,
      density: DEFAULT_DENSITY,
      motion: DEFAULT_MOTION,
      isHydrated: false,

      setTheme: (theme) => {
        set({ theme });
      },
      setDensity: (density) => {
        set({ density });
      },
      setMotion: (motion) => {
        set({ motion });
      },
      hydrateFromServer: (values) => {
        set({ ...values });
      },
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),

      // `isHydrated` is derived, never stored — persisting it would make a
      // fresh page load believe it had already hydrated.
      partialize: (state) => ({
        theme: state.theme,
        density: state.density,
        motion: state.motion,
      }),

      /**
       * Sanitise on read.
       *
       * A value written by an older build must not crash the current one, and
       * — more importantly — must not lock the user out of the settings screen
       * that would let them fix it. Same tolerance as `parsePreferences` in
       * core, for the same reason.
       */
      merge: (persisted, current) => {
        const stored = (persisted ?? {}) as Record<string, unknown>;
        return {
          ...current,
          theme: oneOf(THEMES, stored['theme'], DEFAULT_THEME),
          density: oneOf(DENSITIES, stored['density'], DEFAULT_DENSITY),
          motion: oneOf(MOTION_PREFERENCES, stored['motion'], DEFAULT_MOTION),
        };
      },

      onRehydrateStorage: () => () => {
        // Marks the store as having read localStorage, so a consumer can avoid
        // rendering against defaults during the first client pass.
        useAppearanceStore.setState({ isHydrated: true });
      },
    },
  ),
);

/**
 * Resolve `system` against the OS preference.
 *
 * Kept out of the store because it depends on a media query, and a store that
 * reads the environment is a store that cannot be tested with a plain value.
 */
export function resolveTheme(theme: Theme, prefersDark: boolean): 'dark' | 'light' {
  if (theme === 'system') return prefersDark ? 'dark' : 'light';
  return theme;
}
