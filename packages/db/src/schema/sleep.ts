/**
 * Sleep — §4.6, promoted to a full module in V3.
 *
 * §4.6 is unusually emphatic about why this matters:
 *
 *   "Sleep is the highest-leverage cross-domain variable in the entire system
 *    and is therefore in the MVP's Daily Close despite Sleep not being a full
 *    module until later."
 *
 * ## Why this is a table when duration and quality are already observations
 *
 * `body.sleep.duration` and `body.sleep.quality` have been in the registry
 * since week one, and they stay there — every existing chart, correlation and
 * Daily Close reads them. What they cannot carry is what §4.6 asks for beyond
 * them: **timing, consistency, and disturbances.**
 *
 * §9.2's test is whether a thing has internal structure. A night does: it has
 * two endpoints, a latency, a count of wakings, and a reason it was bad. Those
 * are not five more scalars — the interesting quantity is the *relationship*
 * between the endpoints across nights, which is what consistency means and
 * which no per-metric series can express.
 *
 * So a night is an entity, and it **also** writes the two observations. That is
 * the same shape Gym uses: a `workout_set` is a row and its load is also an
 * observation. §9.3 permits it because the observation is derived from the
 * entity and never the other way round — the night is the source of truth and
 * the series is a projection of it.
 *
 * ## What is deliberately absent
 *
 * **Sleep stages.** No REM, deep or light columns. §4.6 puts wearable import at
 * V3 and this system has none yet; more to the point, consumer sleep staging is
 * a model's guess from movement and heart rate, and storing it in the same
 * columns as a self-report would put a vendor's inference and the operator's
 * own observation behind one name. When import arrives it gets its own columns
 * and its own `source`.
 *
 * **A sleep score.** Every wearable computes one and no two agree, because the
 * weights are a product decision rather than a finding. §10.0 keeps the system
 * out of the business of asserting a number it cannot defend.
 */

import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';

import { sleepDisturbance } from './enums';
import { entityColumns, ianaZone, instant, quantity } from './columns';

/**
 * One night.
 *
 * Keyed by `day_key` — **the morning it ended**, not the evening it started.
 * That is the convention every other per-day join in the system uses: a night
 * is compared against the day it produced, so "I slept badly and then had a bad
 * day" is one row against one day key rather than an off-by-one nobody notices
 * until a correlation comes out backwards.
 */
export const sleepNight = pgTable(
  'sleep_night',
  {
    ...entityColumns,

    /** The morning this night ended, in `zone`. One night per day key. */
    dayKey: text().notNull(),
    zone: ianaZone().notNull(),

    /**
     * Lights out and out of bed. Both nullable, because the Daily Close asks
     * for a duration and not for two clock times — a night captured through the
     * ritual has a duration and no timing, and that is a complete record of
     * what the operator actually knows.
     */
    bedAt: instant(),
    wokeAt: instant(),

    /**
     * Hours slept. Stored rather than computed from the endpoints, because the
     * two are different facts: time in bed is not time asleep, and the
     * difference is exactly `latencyMinutes` plus the wakings. A derived
     * duration would silently overstate every night.
     */
    durationHours: quantity(),

    /** 1–5, matching the Daily Close scale and `body.sleep.quality`. */
    quality: integer(),

    /** How long it took to fall asleep, as estimated on waking. */
    latencyMinutes: integer(),
    /** Times woken in the night. A count the operator gives, not a detection. */
    wakings: integer(),

    /** What disturbed it, when something did. */
    disturbance: sleepDisturbance(),
    disturbanceNote: text(),

    note: text(),
  },
  (t) => [
    /*
     * One night per morning. A second row for the same day key is a duplicate
     * rather than a nap — naps are not modelled, and a schema that silently
     * accepted two would make every consistency figure wrong by an amount
     * nobody could see.
     */
    uniqueIndex('sleep_night_day_unique').on(t.dayKey).where(sql`${t.deletedAt} IS NULL`),
    index('sleep_night_day_idx').on(t.dayKey.desc()).where(sql`${t.deletedAt} IS NULL`),
    check('sleep_night_ordered', sql`${t.wokeAt} IS NULL OR ${t.bedAt} IS NULL OR ${t.bedAt} < ${t.wokeAt}`),
    check('sleep_night_quality_range', sql`${t.quality} IS NULL OR ${t.quality} BETWEEN 1 AND 5`),
    check('sleep_night_duration_range', sql`${t.durationHours} IS NULL OR (${t.durationHours} >= 0 AND ${t.durationHours} <= 24)`),
    check('sleep_night_latency_range', sql`${t.latencyMinutes} IS NULL OR (${t.latencyMinutes} >= 0 AND ${t.latencyMinutes} <= 600)`),
    check('sleep_night_wakings_range', sql`${t.wakings} IS NULL OR ${t.wakings} >= 0`),
  ],
);
