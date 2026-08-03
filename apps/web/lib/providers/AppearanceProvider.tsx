'use client';

import { useCallback, useEffect, useSyncExternalStore, type ReactNode } from 'react';
import type { Density, MotionPreference, Theme } from '@naitikos/core';

import { resolveTheme, useAppearanceStore } from '../stores/appearance.store';

/**
 * Applies theme, density, and motion to the document root.
 *
 * §8.6 requires the motion decision to be made exactly once: "`prefers-reduced-
 * motion` is honoured globally, implemented once at the motion-provider level
 * rather than per-component." This is that level. No component queries the
 * media query — they read `--motion-duration-*`, which this sets up.
 *
 * §8.4 does the same for density: "swap the spacing scale via a data attribute
 * on the root."
 *
 * ## The flash-of-wrong-theme problem
 *
 * Theme lives in `localStorage`, which a server render cannot read. Left alone,
 * every load paints the default theme and then corrects itself — a white flash
 * in a dark room.
 *
 * The fix is {@link ThemeScript}, a tiny blocking script in `<head>` that reads
 * storage and stamps the attribute *before* first paint. This provider then
 * takes over once React hydrates. The duplication between the two is
 * unavoidable and is why the script is kept to a few lines.
 */

export type AppearanceProviderProps = {
  readonly children: ReactNode;
  /**
   * Server-persisted values from the `setting` row.
   *
   * The server is the source of truth (see the store's header note); passing
   * them here overwrites whatever the browser cached.
   */
  readonly serverValues?: {
    readonly theme: Theme;
    readonly density: Density;
    readonly motion: MotionPreference;
  };
};

export function AppearanceProvider({ children, serverValues }: AppearanceProviderProps): ReactNode {
  const theme = useAppearanceStore((state) => state.theme);
  const density = useAppearanceStore((state) => state.density);
  const motion = useAppearanceStore((state) => state.motion);
  const hydrateFromServer = useAppearanceStore((state) => state.hydrateFromServer);

  /**
   * The OS preferences, read through `useSyncExternalStore`.
   *
   * Not `useState` + `useEffect`. Reading a media query in an effect and
   * calling `setState` produces a render with the wrong value followed
   * immediately by a corrected one — a cascading render that React's own lint
   * rule flags, and which for theme means a visible flash of the wrong palette.
   *
   * `useSyncExternalStore` reads the current value during render and subscribes
   * for changes, so the first paint is already correct. The server snapshot is
   * the blueprint default: dark, and motion unreduced.
   */
  const prefersDark = useMediaQuery('(prefers-color-scheme: dark)', true);
  const prefersReducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)', false);

  /* --- Server values win over the local cache ------------------------ */
  useEffect(() => {
    if (serverValues !== undefined) hydrateFromServer(serverValues);
  }, [serverValues, hydrateFromServer]);

  /* --- Stamp the root ------------------------------------------------ */
  useEffect(() => {
    const root = document.documentElement;
    const resolved = resolveTheme(theme, prefersDark);

    root.dataset['theme'] = resolved;
    root.dataset['density'] = density;

    /**
     * `full` is stamped explicitly, not just omitted.
     *
     * `base.css` has a `prefers-reduced-motion` media block guarded by
     * `:root:not([data-motion='full'])`, so that the OS preference applies
     * before hydration. Once the user has *chosen* full motion, that guard has
     * to be defeated — which requires the attribute to be present rather than
     * absent.
     */
    const effective: 'full' | 'reduced' =
      motion === 'reduced' ? 'reduced' : motion === 'full' ? 'full' : prefersReducedMotion ? 'reduced' : 'full';
    root.dataset['motion'] = effective;

    // `color-scheme` makes native controls, scrollbars, and form widgets match
    // the theme. Without it a dark app has light scrollbars.
    root.style.colorScheme = resolved;
  }, [theme, density, motion, prefersDark, prefersReducedMotion]);

  return <>{children}</>;
}

/**
 * The pre-paint theme script.
 *
 * Inlined into `<head>` and executed synchronously, before the first paint, so
 * the correct theme is applied without a flash. Deliberately tiny and
 * dependency-free — it runs before React, before hydration, before anything.
 *
 * It duplicates a little of the provider's logic. That is the accepted cost of
 * not flashing; the alternative is a cookie read in the server render, recorded
 * as debt in docs/app-shell.md.
 *
 * The nonce is required because §5.14's CSP is nonce-based and forbids
 * `unsafe-inline` — an unnonced inline script is silently blocked, and the
 * symptom is exactly the flash this exists to prevent.
 */
export function ThemeScript({ nonce }: { readonly nonce: string }): ReactNode {
  const script = `
(function () {
  try {
    var stored = JSON.parse(localStorage.getItem('naitikos.appearance') || '{}').state || {};
    var theme = stored.theme || 'dark';
    var density = stored.density || 'comfortable';
    var motion = stored.motion || 'system';
    var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    var resolved = theme === 'system' ? (prefersDark ? 'dark' : 'light') : theme;
    var root = document.documentElement;
    root.dataset.theme = resolved;
    root.dataset.density = density;
    if (motion !== 'system') root.dataset.motion = motion;
    root.style.colorScheme = resolved;
  } catch (e) {
    // Storage disabled, or corrupt JSON. Fall through to the dark default in
    // :root — a working app in the wrong theme beats a blank page.
  }
})();`.trim();

  return <script nonce={nonce} dangerouslySetInnerHTML={{ __html: script }} />;
}

/**
 * Subscribe to a media query.
 *
 * `serverSnapshot` is what the server render assumes. It must match the
 * pre-paint script's default, or hydration disagrees about the theme.
 */
function useMediaQuery(query: string, serverSnapshot: boolean): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const media = window.matchMedia(query);
      media.addEventListener('change', onChange);
      return () => {
        media.removeEventListener('change', onChange);
      };
    },
    [query],
  );

  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => serverSnapshot,
  );
}
