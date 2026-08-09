/**
 * The shape everything in `statistics/` consumes.
 *
 * ## Why these are plain `number`s when the rest of the system bans floats
 *
 * §5.3 is categorical: "numeric never float" for measured quantities, and
 * `units/decimal.ts` exists so a stored kilogram is exact. That rule governs the
 * *record*. It does not govern a regression.
 *
 * A moving average over ninety bodyweight readings is a **derived display
 * value** — it is never written back to `observation`, never exported as fact,
 * and never compared for equality. Running it on `Decimal` would cost an
 * allocation per operation and a division that is not closed (see
 * `divideDecimal`, which demands an explicit scale for exactly this reason),
 * in exchange for exactness in a number whose last three digits are not
 * meaningful anyway.
 *
 * So the boundary is drawn once, explicitly, in `derivation/rollup.ts`: decimal
 * strings are parsed to `number` there and nowhere else. Anything that flows
 * *back* into the record — session volume, a personal record — stays in
 * `Decimal` all the way through (`derivation/volume.ts`, `derivation/records.ts`).
 */

/**
 * One value on one local day.
 *
 * A day key, not an instant, because everything in this module compares and
 * windows by *calendar day in the operator's zone*. §5.3: a workout at 7am
 * during travel is a different fact from one at 7am at home, and the zone is
 * resolved before a value gets here — never after.
 */
export type DailyValue = {
  /** `YYYY-MM-DD`, already resolved in the observer's zone. */
  readonly dayKey: string;
  readonly value: number;
};

/**
 * A derived value on a day, which may be absent.
 *
 * `null` is a **gap, and it must stay one.** §8.9(3): "Missing data is shown as
 * missing. Gaps are gaps. Lines break. Interpolation across a week of no data is
 * fabrication." Every function here returns `null` rather than carrying the last
 * value forward, and that is the single most important property in the file.
 */
export type DailyEstimate = {
  readonly dayKey: string;
  readonly value: number | null;
};

/** A derived value with an interval around it (§8.9(4)). */
export type DailyBand = {
  readonly dayKey: string;
  readonly value: number;
  readonly lower: number;
  readonly upper: number;
};
