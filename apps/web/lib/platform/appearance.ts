/**
 * Appearance — §2.3's "aggregate lens over skin, physique, grooming, and hair".
 *
 * ## A lens owns no data, and this one owns none
 *
 * P3: *"There is no 'gym database' and no 'skin database.' There is one
 * observation log and one entity graph. Gym and Skin are queries with a UI
 * attached."* Appearance is the purest test of that claim in the system,
 * because it is a pillar in the navigation that has no table, no repository and
 * no metric of its own.
 *
 * So this module composes existing loaders and computes nothing. Every figure
 * on the page is already computed and already displayed somewhere else, by the
 * same code. If that stops being true, the lens has become a sixth pillar with
 * a private opinion, and the two surfaces will disagree the first time one of
 * them is changed.
 *
 * ## Two of the four exist, and the page says which
 *
 * §2.3 names four elements. Skin and physique have schema, capture protocols
 * and a year of design behind them. **Grooming and hair have nothing** — no
 * table, no metric, no capture path.
 *
 * §3.3 R6 would ordinarily say a module with nothing behind it should be absent
 * rather than empty: *"A visible-but-empty module teaches the user that the
 * system is a graveyard."* That rule is about routes, and it is why
 * `/body/appearance` did not exist until now. It does not extend to a lens
 * *naming what it does not cover* — the opposite, in fact. A page called
 * Appearance that silently showed two of four things would imply the other two
 * were absent from the record because there was nothing to record, which is
 * §8.9's failure applied to a whole domain.
 */

import 'server-only';

import type { Result } from '@naitikos/shared';
import { ok } from '@naitikos/shared';
import type { DomainError, RegionTrend, SkinState } from '@naitikos/core';
import { dayKeyInZone, isoFromMillis, shiftDayKey, systemClock } from '@naitikos/core';
import type { Database } from '@naitikos/db';

import { loadSkinOverview } from './skin';

/**
 * The window every element is read over.
 *
 * Ninety days, and the same number for all of them, which is the point. An
 * aggregate lens showing skin over a fortnight beside weight over a year would
 * invite a comparison between two windows — the one thing a page laying figures
 * side by side must not do, because §4.7's prohibition on asserting a cause is
 * defeated by an axis mismatch as easily as by a sentence.
 */
export const APPEARANCE_WINDOW_DAYS = 90;

/** One element of §2.3's four, with what the record actually holds for it. */
export type AppearanceElement = {
  readonly id: 'skin' | 'physique' | 'grooming' | 'hair';
  readonly label: string;
  /** Where the operator goes to see or record this. `null` when nothing exists. */
  readonly href: string | null;
  /**
   * Why this element has no surface, or `null` when it has one.
   *
   * A sentence rather than a boolean. "Not built" is not information; "there is
   * no table and no capture path, and here is what one would need" is.
   */
  readonly absence: string | null;
};

export type AppearanceBoard = {
  readonly fromDayKey: string;
  readonly toDayKey: string;
  readonly windowDays: number;
  /** §2.3's four, in its order, present or not. */
  readonly elements: readonly AppearanceElement[];
  /** Per-region skin trends, exactly as `/body/skin` computes them. */
  readonly skinRegions: readonly RegionTrend[];
  /** Days in the window with a skin record, so a trend is readable. */
  readonly skinRecordedDays: number;
  /** Flare days in the window. Counted, never explained. */
  readonly skinFlares: number;
};

export async function loadAppearance(db: Database, zone: string): Promise<Result<AppearanceBoard, DomainError>> {
  const toDayKey = dayKeyInZone(isoFromMillis(systemClock.nowMillis()), zone);
  const fromDayKey = shiftDayKey(toDayKey, -(APPEARANCE_WINDOW_DAYS - 1)) ?? toDayKey;

  /*
   * `loadSkinOverview`, not a query of its own.
   *
   * It already produces `regionTrends` and the flare list, and calling it is
   * what guarantees this page and `/body/skin` cannot disagree about what the
   * last ninety days looked like. A second query here would be a second
   * definition of "how is the skin", which is exactly what a lens is not.
   */
  const skin = await loadSkinOverview(db, { fromDayKey, toDayKey, zone });
  if (!skin.ok) return skin;

  return ok({
    fromDayKey,
    toDayKey,
    windowDays: APPEARANCE_WINDOW_DAYS,
    elements: ELEMENTS,
    skinRegions: skin.value.regions,
    skinRecordedDays: recordedDays(skin.value.states),
    skinFlares: skin.value.flares.length,
  });
}

function recordedDays(states: readonly SkinState[]): number {
  return new Set(states.map((state) => state.observedOn)).size;
}

/**
 * §2.3's four elements, and an honest sentence about the two that do not exist.
 *
 * The absences are written out rather than omitted because they are the more
 * useful half of this page. "Grooming is not tracked" tells the operator that a
 * gap in their record is a gap in the *system*, not in their attention — which
 * is the difference between a missing feature and a personal failure, and this
 * is the one pillar where that distinction is worth being careful about.
 */
const ELEMENTS: readonly AppearanceElement[] = Object.freeze([
  { id: 'skin', label: 'Skin', href: '/body/skin', absence: null },
  { id: 'physique', label: 'Physique', href: '/body/composition', absence: null },
  {
    id: 'grooming',
    label: 'Grooming',
    href: null,
    absence:
      'Not tracked. There is no table and no capture path — it would need a routine of its own, in the way skincare has one, and nothing has yet made the case that a haircut interval belongs in a longitudinal health record.',
  },
  {
    id: 'hair',
    label: 'Hair',
    href: null,
    absence:
      'Not tracked. It would need standardised photography under the same capture protocol skin uses, because change is slow enough that capture variance would dominate it entirely — which is a real piece of work rather than a missing page.',
  },
]);
