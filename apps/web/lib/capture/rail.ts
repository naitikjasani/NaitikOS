/**
 * The quick-capture rail's contents — §3.3(4).
 *
 * Data only. `features/capture/components/QuickCapture.tsx` renders it,
 * `/settings/capture` documents it, and `lib/capture/entrances.ts` gives each
 * entry a URL. See {@link RAIL} for why those three share one module.
 */

export type CaptureKind = {
  readonly key: string;
  readonly metricKey: string;
  readonly label: string;
  readonly control: 'scale' | 'number' | 'preset';
  readonly unit: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  /**
   * For `preset`: the values offered as one-tap buttons.
   *
   * Hydration is the one metric on this rail where the *value* is almost always
   * one of three numbers — a glass, a bottle, a litre. A stepper from 0 to 3000
   * in steps of 50 is sixty taps for a number the operator already knows, so the
   * control is three buttons and the stepper is not offered at all.
   */
  readonly presets?: readonly number[];
};

/**
 * The rail's contents.
 *
 * A short, hard-coded list rather than everything in the registry, and that is
 * the design. §3.2 caps quick capture at "≤3-tap logging" — a rail of eighteen
 * metrics is a menu, and a menu is navigation, which §3.3(4) forbids here. What
 * belongs is the handful of things captured *between* Daily Closes.
 *
 * §3.2 puts the configuration at `/settings/capture`. That page is a reference
 * for what is here rather than an editor, for the same reason: a rail the
 * operator can extend becomes a menu.
 *
 * ## Why this is not inside the sheet that renders it
 *
 * It is plain data with no React in it, and three things need to read it: the
 * sheet, `/settings/capture`, and `lib/capture/entrances.ts`, which builds a
 * URL for every one of these so a home-screen shortcut can reach it. The last
 * two run on the server, and a `'use client'` module hands a server import an
 * opaque reference rather than the array. Keeping the list here is what stops
 * those two surfaces from carrying their own copy and drifting from the rail
 * within one change.
 */
export const RAIL: readonly CaptureKind[] = [
  { key: 'm', metricKey: 'mind.mood', label: 'Mood', control: 'scale', unit: '', min: 1, max: 5, step: 1 },
  { key: 'e', metricKey: 'mind.energy', label: 'Energy', control: 'scale', unit: '', min: 1, max: 5, step: 1 },
  { key: 'a', metricKey: 'mind.anxiety', label: 'Anxiety', control: 'scale', unit: '', min: 1, max: 5, step: 1 },
  { key: 'w', metricKey: 'body.weight', label: 'Weight', control: 'number', unit: 'kg', min: 20, max: 400, step: 0.1 },
  /*
   * Hydration, and the only Nutrition thing on this rail.
   *
   * §4.3's other captures are *meals*, and a meal needs the suggestion ranking
   * — which is server data this shell does not have. Fetching it when the sheet
   * opens would put a round trip in the middle of §2.2's ten-second budget,
   * making the sheet slower than `/body/nutrition/log`, which is server-rendered
   * with that data already in the response. So there is no `c f`: the fastest
   * path to a logged meal is the route, and a second slower path that looks
   * faster would be a trap.
   *
   * Water is different. It is one number, it has no library behind it, and the
   * three presets cover almost every case. It belongs on the rail for the same
   * reason weight does.
   */
  {
    key: 'h',
    metricKey: 'nutrition.water',
    label: 'Water',
    control: 'preset',
    unit: 'ml',
    min: 0,
    max: 3000,
    step: 50,
    presets: [250, 500, 1000],
  },
];

/**
 * The rail, for the command palette and for `/settings/capture`.
 *
 * A chord nobody can discover is a chord nobody uses, and the palette is the
 * only surface a person opens *looking* for what is possible. Exported as data
 * rather than rendered anywhere so each surface owns its own layout.
 */
export const QUICK_CAPTURE_CHORDS: readonly {
  readonly chord: string;
  readonly label: string;
  readonly metricKey: string;
}[] = RAIL.map((kind) => ({ chord: `c ${kind.key}`, label: kind.label, metricKey: kind.metricKey }));
