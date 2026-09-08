/**
 * The PWA manifest (§12 week 2: "PWA: manifest, service worker, installable,
 * offline shell").
 *
 * A `manifest.ts` route rather than a static `manifest.json`, so the name, the
 * theme colour and the shortcuts are typed and cannot drift from the values the
 * rest of the app uses.
 *
 * ## Why installability is a requirement rather than a nicety
 *
 * §5.9: "On iOS [Web Push] requires the PWA to be installed to the home screen
 * — a genuine platform constraint that must be communicated honestly during
 * onboarding rather than discovered as a bug." The Daily Close reminder is the
 * one notification the ritual depends on, so an uninstallable app has no
 * reminder on the operator's actual phone.
 */

import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Ekayu',
    short_name: 'Ekayu',
    description: 'A personal health and life operating system.',
    start_url: '/today',
    /*
     * `standalone`, not `fullscreen`. Fullscreen hides the status bar, which
     * takes the clock away — and the Close is a time-anchored ritual whose
     * whole question is "how was today". Hiding the time is the wrong trade.
     */
    display: 'standalone',
    orientation: 'portrait',
    /*
     * Matches `--color-bg-base` in the dark theme, which §8.7 makes the default.
     * A mismatch here is visible as a flash of the wrong colour during launch,
     * before the first paint — the one moment the operator has nothing else to
     * look at.
     */
    background_color: '#0b0f14',
    theme_color: '#0b0f14',
    categories: ['health', 'lifestyle', 'productivity'],
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    /*
     * §3.3(4): quick capture is "reachable from the PWA shortcut menu on
     * mobile". Long-pressing the home-screen icon is the mobile equivalent of
     * the `c` chord, and it is the only way to reach capture without opening
     * the app first — which is what "capture must never require navigation"
     * means on a phone.
     */
    shortcuts: [
      {
        name: 'Daily Close',
        short_name: 'Close',
        description: 'Record the day in under sixty seconds.',
        url: '/today/close',
      },
      /*
       * Two captures, not nine.
       *
       * `lib/capture/entrances.ts` has a URL for every kind the system
       * captures, and this list is deliberately a fraction of it. Android shows
       * at most four shortcuts on a long-press and iOS shows a similar handful;
       * past that the menu is scrolled, and a scrolled menu is the list-reading
       * §3.3(4) exists to avoid. Mood and weight are the two things captured
       * between Closes often enough to earn a place on the home screen — the
       * rest are reachable by the `c` chord, the palette, and by URL.
       */
      {
        name: 'Log mood',
        short_name: 'Mood',
        description: 'One tap, one to five.',
        url: '/today/capture/mood',
      },
      {
        name: 'Log weight',
        short_name: 'Weight',
        description: 'A single reading. The seven-day mean is what the record reads (§4.6).',
        url: '/today/capture/weight',
      },
    ],
  };
}
