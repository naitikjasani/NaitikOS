/**
 * Capture entrances — §3.2's `/today/capture/:kind`.
 *
 * ## A route for a thing that must not be a route
 *
 * §3.3(4) is unambiguous: *"Quick capture is global. A floating action
 * available on every route… **Capture must never require navigation.**"* A page
 * whose job is to capture is the exact thing that rule forbids, so this table
 * describes **entrances**, not destinations. Nothing inside the application
 * links here.
 *
 * What it is for is the set of places that can hand the application a URL and
 * nothing else: a PWA home-screen shortcut, a notification action, a share
 * target, an OS widget. The manifest already asserts this is how capture works
 * on a phone —
 *
 *   "Long-pressing the home-screen icon is the mobile equivalent of the `c`
 *    chord, and it is the only way to reach capture without opening the app
 *    first — which is what 'capture must never require navigation' means on a
 *    phone."
 *
 * — and until this table existed the manifest had one shortcut, the Daily
 * Close, because there was no URL for anything else. The claim was true about
 * the design and false about the build.
 *
 * ## Half of these are not sheets, and that is the point
 *
 * §3.2 names six kinds: `mood|weight|meal|set|photo|note`. The quick-capture
 * rail has sheets for two of them. The other four are not missing sheets — they
 * are captures whose fastest path is a route, and `/settings/capture` already
 * says why for the hardest case:
 *
 *   "The meal suggestion ranking is server data the capture sheet does not
 *    have, so `/body/nutrition/log` is the faster path and a slower one that
 *    looked faster would be a trap."
 *
 * The same holds for a set (the live logger holds the session), a photo (the
 * §4.2 capture protocol is the module — ghost overlay, time-of-day window,
 * flash state), and a note (a journal entry is prose, and a sheet sized for a
 * number is the wrong shape for it).
 *
 * So an entrance resolves to whichever of the two is genuinely faster, and this
 * is the one place in the system where all six of §3.2's kinds resolve. A
 * shortcut that opened a sheet which then told the operator to go somewhere
 * else would cost them the seconds the shortcut existed to save.
 */

/** Where a slug lands. */
export type CaptureTarget =
  /** The quick-capture sheet, opened over `/today` without a page transition. */
  | { readonly kind: 'sheet'; readonly metricKey: string }
  /**
   * A route, because the route is the faster path.
   *
   * `why` is rendered nowhere. It is here so that adding a sheet for one of
   * these later requires deleting a stated reason rather than noticing an
   * omission.
   */
  | { readonly kind: 'route'; readonly href: string; readonly why: string };

export type CaptureEntrance = {
  /** The `:kind` segment. Stable — a home-screen shortcut outlives a refactor. */
  readonly slug: string;
  readonly label: string;
  readonly target: CaptureTarget;
};

/**
 * §3.2's six, plus the three the rail carries that §3.2's list predates.
 *
 * The rail is the authority on what has a sheet; this table is the authority on
 * what has a URL. They are checked against each other in `entrances.test.ts`,
 * because the failure mode otherwise is a home-screen shortcut that opens
 * `/today` and does nothing — which reads as the application being broken
 * rather than as a stale table.
 */
export const CAPTURE_ENTRANCES: readonly CaptureEntrance[] = Object.freeze([
  { slug: 'mood', label: 'Mood', target: { kind: 'sheet', metricKey: 'mind.mood' } },
  { slug: 'energy', label: 'Energy', target: { kind: 'sheet', metricKey: 'mind.energy' } },
  { slug: 'anxiety', label: 'Anxiety', target: { kind: 'sheet', metricKey: 'mind.anxiety' } },
  { slug: 'weight', label: 'Weight', target: { kind: 'sheet', metricKey: 'body.weight' } },
  { slug: 'water', label: 'Water', target: { kind: 'sheet', metricKey: 'nutrition.water' } },
  {
    slug: 'meal',
    label: 'Meal',
    target: {
      kind: 'route',
      href: '/body/nutrition/log',
      why: 'The meal suggestion ranking is server data the sheet does not have. Fetching it on open would put a round trip inside the capture, making the sheet slower than the page.',
    },
  },
  {
    slug: 'set',
    label: 'Set',
    target: {
      kind: 'route',
      href: '/body/gym/log',
      why: 'A set belongs to a session. The live logger holds the session, the previous load and the rest timer; a set captured outside one has nothing to attach to.',
    },
  },
  {
    slug: 'photo',
    label: 'Photo',
    target: {
      kind: 'route',
      href: '/body/skin/photos',
      why: '§4.2 makes the capture protocol the module — ghost overlay, time-of-day window, forced flash state. A photo captured outside it is stored and flagged, which is worse than a photo not taken.',
    },
  },
  {
    slug: 'note',
    label: 'Note',
    target: {
      kind: 'route',
      href: '/mind/journal',
      why: 'A journal entry is prose. A sheet sized for a number is the wrong shape for it, and a one-line field would quietly teach the operator to write one line.',
    },
  },
]);

/** The entrance for a URL segment, or `null` — a 404 rather than a guess. */
export function entranceFor(slug: string): CaptureEntrance | null {
  return CAPTURE_ENTRANCES.find((entrance) => entrance.slug === slug) ?? null;
}

/**
 * The query parameter a sheet entrance lands on: `/today?capture=mood`.
 *
 * The **slug**, not the metric key. A home-screen shortcut is a URL the
 * operating system stores for as long as the icon exists, and a metric key is
 * an internal identifier that may be renamed. The slug is the contract.
 */
export const CAPTURE_PARAM = 'capture';
