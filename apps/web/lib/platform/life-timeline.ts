/**
 * The Life Timeline, assembled — §10.8.
 *
 *   "The zoomed-out counterpart, scaling from day to decade. Composed of eras
 *    (life phases), chapters (jobs, relocations, relationships), events
 *    (discrete, significant), and metric bands… Its value is entirely in the
 *    long run."
 *
 * ## Every position is a number by the time it leaves this file
 *
 * The screen multiplies fractions by a width. It parses no dates, computes no
 * durations and knows nothing about calendars. That split is deliberate: the
 * date arithmetic is in `core`, tested there, and a bar, a marker and (when
 * metric bands land) a band all read the same numbers rather than three
 * implementations of the same off-by-one.
 *
 * ## Metric bands are not here yet, and the page does not pretend otherwise
 *
 * §10.8 lists them as the fourth composition element. They need a decade of
 * observations behind them to say anything, so they are deferred rather than
 * stubbed — a background band drawn over eighteen months of data would be the
 * novelty §10.8 warns about, dressed as the artifact it promises.
 *
 * ## Nothing here infers a span
 *
 * §10.0. The system holds enough observations to guess where a chapter started
 * and it does not guess. Every row on this page was authored.
 */

import 'server-only';

import type { Result } from '@naitikos/shared';
import { ok } from '@naitikos/shared';
import type { DomainError, LifeEvent, LifeSpan, TimelineBounds, TimelineScale } from '@naitikos/core';
import {
  boundsFor,
  dayKeyInZone,
  isoFromMillis,
  layoutSpans,
  positionOf,
  shiftDayKey,
  spanExtent,
  systemClock,
} from '@naitikos/core';
import type { Database } from '@naitikos/db';
import { createLifeRepository } from '@naitikos/db';

/**
 * A categorical palette slot.
 *
 * Matches the design system's `Series['slot']` exactly, so `seriesColorVar`
 * accepts it without a cast. The colour itself is never computed here — §8.9(5)
 * has the theme own it, and a hex value in this file would be one that fails
 * contrast in whichever theme nobody checked.
 */
export type PaletteSlot = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

const PALETTE_SLOTS: readonly PaletteSlot[] = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8] as const);

/** How far back each scale looks. `life` looks all the way back, so it has no entry. */
const WINDOW_DAYS: Readonly<Record<Exclude<TimelineScale, 'life'>, number>> = Object.freeze({
  year: 365,
  /* Ten mean Gregorian years. The label says "decade" and the axis should mean it. */
  decade: 3653,
});

export type PositionedSpan = {
  readonly id: string;
  readonly title: string;
  readonly kind: LifeSpan['kind'];
  readonly description: string | null;
  readonly startedAt: string;
  /** `null` while it is still running. Never today's date standing in for one. */
  readonly endedAt: string | null;
  /** True when the bar's right edge is today rather than a recorded ending. */
  readonly open: boolean;
  readonly slot: PaletteSlot;
  /** Left edge, 0–1 of the axis. */
  readonly from: number;
  /** Right edge, 0–1 of the axis. */
  readonly to: number;
};

export type PositionedLane = {
  readonly lane: number;
  readonly spans: readonly PositionedSpan[];
};

export type PositionedEvent = {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly occurredAt: string;
  readonly significance: number | null;
  readonly spanId: string | null;
  /** Position along the axis, 0–1. */
  readonly at: number;
};

export type LifeTimeline = {
  readonly scale: TimelineScale;
  /** `null` when there is nothing to draw. The axis is not invented (§8.9(3)). */
  readonly bounds: TimelineBounds | null;
  readonly lanes: readonly PositionedLane[];
  readonly events: readonly PositionedEvent[];
  /** Every live span, unpositioned — the authoring form's parent picker reads this. */
  readonly spans: readonly LifeSpan[];
  /**
   * True when the record holds nothing at all, as distinct from holding
   * nothing *in this window*. The two need different words on the page: one is
   * a page nobody has written yet, the other is a zoom level with no rows in
   * it, and conflating them would tell a five-year user their timeline is
   * empty because they looked at the last year.
   */
  readonly hasNothing: boolean;
};

export async function loadLifeTimeline(
  db: Database,
  scale: TimelineScale,
): Promise<Result<LifeTimeline, DomainError>> {
  const life = createLifeRepository(db);

  const spans = await life.spans();
  if (!spans.ok) return spans;
  const events = await life.events();
  if (!events.ok) return events;

  const nowIso = isoFromMillis(systemClock.nowMillis());
  const hasNothing = spans.value.length === 0 && events.value.length === 0;

  const full = boundsFor(spans.value, events.value, nowIso);
  if (full === null) {
    return ok({ scale, bounds: null, lanes: [], events: [], spans: spans.value, hasNothing });
  }

  const bounds = narrow(full, scale);

  const visibleSpans = spans.value.filter((span) => {
    const extent = spanExtent(span, nowIso);
    /* Intersects the window, rather than sits inside it: a chapter that began
     * before this year and is still running is the most important thing on a
     * one-year view. */
    return (
      utcDayKey(extent.endsAt) >= bounds.fromDayKey && utcDayKey(extent.startedAt) <= bounds.toDayKey
    );
  });

  const visibleEvents = events.value.filter((event) => {
    const key = utcDayKey(event.occurredAt);
    return key >= bounds.fromDayKey && key <= bounds.toDayKey;
  });

  /*
   * Slots are assigned over *every* span, not over the visible ones, so a
   * chapter keeps its colour when the reader changes scale. A colour that moved
   * with the zoom would make the palette decorative.
   */
  const slots = new Map(spans.value.map((span, index) => [span.id, slotFor(span, index)]));

  const lanes = layoutSpans(visibleSpans, nowIso).map((lane) => ({
    lane: lane.lane,
    spans: lane.spans
      .map((span) => position(span, bounds, nowIso, slots.get(span.id) ?? 1))
      .filter((span): span is PositionedSpan => span !== null),
  }));

  return ok({
    scale,
    bounds,
    /* A lane whose only span failed to position would render as an empty
     * track. Dropped rather than drawn blank. */
    lanes: lanes.filter((lane) => lane.spans.length > 0),
    events: visibleEvents
      .map((event) => positionEvent(event, bounds))
      .filter((event): event is PositionedEvent => event !== null),
    spans: spans.value,
    hasNothing,
  });
}

/**
 * Clip the full extent down to the requested scale.
 *
 * The left edge moves in; the right edge never does. A timeline of the past is
 * read from its most recent end, and a "last year" view that stopped at the
 * last recorded event rather than at today would hide the fact that nothing has
 * been recorded since March.
 *
 * The window is also never wider than the data. Padding a two-year record out
 * to a decade would draw eight years of confident emptiness, which reads as
 * eight years in which nothing happened.
 */
function narrow(full: TimelineBounds, scale: TimelineScale): TimelineBounds {
  if (scale === 'life') return full;

  const days = WINDOW_DAYS[scale];
  const start = shiftDayKey(full.toDayKey, -days);
  if (start === null || start <= full.fromDayKey) return full;

  const years = days / 365.2425;
  return { fromDayKey: start, toDayKey: full.toDayKey, years };
}

/**
 * The day key an instant falls on, for windowing.
 *
 * UTC, matching what `core`'s `positionOf` uses. §5.3's zone requirement is
 * about facts read per day; at a year of zoom a zone shift is under a pixel,
 * and disagreeing with the positioning function would be the actual bug.
 */
function utcDayKey(instant: string): string {
  return dayKeyInZone(instant, 'UTC');
}

/**
 * The palette slot a span draws in.
 *
 * An authored slot wins. When none was chosen the slot cycles by position,
 * which distinguishes adjacent spans and means nothing else — §8.9(5): colour
 * never encodes valence, and a system-chosen colour that appeared to rank
 * someone's life phases would be worse than a monochrome timeline. The
 * fallback is not written back to the row.
 */
function slotFor(span: LifeSpan, index: number): PaletteSlot {
  const declared = span.slot;
  if (declared !== null && Number.isInteger(declared) && declared >= 1 && declared <= 8) {
    return PALETTE_SLOTS[declared - 1] ?? 1;
  }
  return PALETTE_SLOTS[index % PALETTE_SLOTS.length] ?? 1;
}

function position(
  span: LifeSpan,
  bounds: TimelineBounds,
  nowIso: string,
  slot: PaletteSlot,
): PositionedSpan | null {
  const extent = spanExtent(span, nowIso);
  const from = positionOf(extent.startedAt, bounds);
  const to = positionOf(extent.endsAt, bounds);
  /* `null` means the instant is not a date at all. Such a row is dropped rather
   * than pinned to the left edge, where it would silently claim a start it
   * does not have. */
  if (from === null || to === null) return null;

  return {
    id: span.id,
    title: span.title,
    kind: span.kind,
    description: span.description,
    startedAt: span.startedAt,
    endedAt: span.endedAt,
    open: extent.open,
    slot,
    from,
    to: Math.max(to, from),
  };
}

function positionEvent(event: LifeEvent, bounds: TimelineBounds): PositionedEvent | null {
  const at = positionOf(event.occurredAt, bounds);
  if (at === null) return null;

  return {
    id: event.id,
    title: event.title,
    description: event.description,
    occurredAt: event.occurredAt,
    significance: event.significance,
    spanId: event.spanId,
    at,
  };
}
