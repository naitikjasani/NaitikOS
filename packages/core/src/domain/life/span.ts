/**
 * The Life Timeline — eras, chapters, events, and the geometry that draws them
 * (§10.8).
 *
 * §10.8 describes "the zoomed-out counterpart, scaling from day to decade…
 * composed of eras (life phases), chapters (jobs, relocations, relationships),
 * events (discrete, significant), and metric bands", and is unusually candid
 * about the payoff: "Its value is entirely in the long run. At year one it is a
 * novelty; at year ten it is the only place a person can see their own life as
 * a shape."
 *
 * ## Every row on this timeline was authored, and that is the constraint
 *
 * §10.0: "The model never computes, discovers, or asserts." The temptation here
 * is enormous and specific — the system holds five years of observations and
 * could easily notice that logging density changed in March 2027 and offer to
 * open a chapter. It does not. A life phase is a judgement about meaning, and a
 * timeline that contained inferred spans would be a story the system wrote
 * about someone rather than the one they wrote about themselves. There is no
 * inference in this file. There is arithmetic on dates the operator typed.
 *
 * ## What this file computes, and what it refuses to
 *
 * It computes lane packing, a bounding window, and fractional positions — pure
 * geometry, all of it derivable from the rows and none of it a claim. It does
 * not compute a duration for an unfinished chapter, does not fill an end date,
 * and does not invent a range when there is nothing to draw.
 */

import type { Result } from '@naitikos/shared';
import { err, ok } from '@naitikos/shared';

import type { DomainError } from '../../errors/domain-error';
import { validationError } from '../../errors/domain-error';
import { dayKeyIndex, parseInstant } from '../../temporal/instant';
import { dayKeyInZone } from '../../timeline/grouping';

/* =========================================================================
 * Kinds and scales
 * ====================================================================== */

/** Mirrors the `life_span_kind` pgEnum exactly. */
export const LIFE_SPAN_KINDS = Object.freeze(['era', 'chapter'] as const);

export type LifeSpanKind = (typeof LIFE_SPAN_KINDS)[number];

export const LIFE_SPAN_KIND_LABELS: Readonly<Record<LifeSpanKind, string>> = Object.freeze({
  era: 'Era',
  chapter: 'Chapter',
});

export function isLifeSpanKind(value: string): value is LifeSpanKind {
  return (LIFE_SPAN_KINDS as readonly string[]).includes(value);
}

/**
 * The zoom levels this surface offers.
 *
 * §3.2 lists `day|week|month|year|life` on `/timeline`, but the first three
 * belong to the domain-event projection: a day of logged sets is a thing that
 * table can show and this one cannot, because a chapter is not an event and
 * does not have a Tuesday. So the zoomed-out surface starts where the other one
 * runs out — a year, a decade, and the whole record.
 */
export const TIMELINE_SCALES = Object.freeze(['year', 'decade', 'life'] as const);

export type TimelineScale = (typeof TIMELINE_SCALES)[number];

export const TIMELINE_SCALE_LABELS: Readonly<Record<TimelineScale, string>> = Object.freeze({
  year: 'Year',
  decade: 'Decade',
  life: 'Life',
});

export function isTimelineScale(value: string): value is TimelineScale {
  return (TIMELINE_SCALES as readonly string[]).includes(value);
}

/* =========================================================================
 * The rows
 * ====================================================================== */

/** A named span of life: an era (phase) or a chapter (job, relocation, relationship). */
export type LifeSpan = {
  readonly id: string;
  readonly kind: LifeSpanKind;
  readonly title: string;
  readonly description: string | null;
  readonly startedAt: string;
  /**
   * `null` means *still running*, and it stays `null`.
   *
   * The current chapter has not ended. Writing today's date into it — even for
   * the convenience of the layout code below — would turn the timeline's most
   * important span into the one that is silently rewritten every night, and
   * would assert an ending nobody recorded. {@link spanExtent} is where "runs
   * to now" is expressed, as a rendering fact rather than a stored one.
   */
  readonly endedAt: string | null;
  /** A chapter may sit inside an era. Eras do not nest. */
  readonly parentId: string | null;
  /** A palette slot, 1–8, or `null`. Never a colour — §8.9(5) and the DB check. */
  readonly slot: number | null;
};

export type LifeSpanInput = {
  readonly id: string;
  readonly kind: LifeSpanKind;
  readonly title: string;
  readonly description?: string | null;
  readonly startedAt: string;
  readonly endedAt?: string | null;
  readonly parentId?: string | null;
  readonly slot?: number | null;
};

/** A discrete, significant event. Not a logged set — see the table's comment. */
export type LifeEvent = {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly occurredAt: string;
  readonly spanId: string | null;
  /** 1–5, or `null`. How large it looms, which is the operator's call. */
  readonly significance: number | null;
};

export type LifeEventInput = {
  readonly id: string;
  readonly title: string;
  readonly description?: string | null;
  readonly occurredAt: string;
  readonly spanId?: string | null;
  readonly significance?: number | null;
};

/** The palette is eight slots wide (§8.9); the DB check says so too. */
export const MIN_SLOT = 1;
export const MAX_SLOT = 8;

/** Significance runs 1–5, matching `life_event_significance_range`. */
export const MIN_SIGNIFICANCE = 1;
export const MAX_SIGNIFICANCE = 5;

/* =========================================================================
 * Validation
 * ====================================================================== */

/**
 * Validate a span before it reaches Postgres.
 *
 * Every rule here is also a CHECK constraint, and the duplication is deliberate:
 * the constraint is the guarantee, this is the error message. A form that says
 * "a span cannot end before it started" is usable; one that surfaces
 * `life_span_ordered` is not.
 */
export function validateSpan(input: LifeSpanInput): Result<LifeSpanInput, DomainError> {
  if (input.title.trim() === '') {
    return err(validationError('life_span_title_empty', 'A span needs a name.'));
  }

  const started = parseInstant(input.startedAt);
  if (started === null) {
    return err(validationError('life_span_start_invalid', 'startedAt must be an ISO-8601 instant.'));
  }

  const endedAt = input.endedAt ?? null;
  if (endedAt !== null) {
    const ended = parseInstant(endedAt);
    if (ended === null) {
      return err(validationError('life_span_end_invalid', 'endedAt must be an ISO-8601 instant.'));
    }
    if (ended.getTime() < started.getTime()) {
      return err(
        validationError('life_span_ends_before_start', 'A span cannot end before it started.'),
      );
    }
  }

  const slot = input.slot ?? null;
  if (slot !== null && (!Number.isInteger(slot) || slot < MIN_SLOT || slot > MAX_SLOT)) {
    return err(
      validationError(
        'life_span_slot_out_of_range',
        `A palette slot is a whole number from ${String(MIN_SLOT)} to ${String(MAX_SLOT)}.`,
      ),
    );
  }

  /*
   * Eras do not nest. The table's comment says so and the layout below relies
   * on it: an era is the background a chapter sits against, and an era inside
   * an era would make "which band is this chapter in" a tree walk rather than
   * a lookup. There is no CHECK for this one — a self-referencing constraint
   * across a nullable FK cannot express it — so this is the only enforcement.
   */
  if (input.kind === 'era' && (input.parentId ?? null) !== null) {
    return err(validationError('life_span_era_nested', 'An era cannot sit inside another span.'));
  }

  return ok(input);
}

export function validateEvent(input: LifeEventInput): Result<LifeEventInput, DomainError> {
  if (input.title.trim() === '') {
    return err(validationError('life_event_title_empty', 'An event needs a name.'));
  }

  if (parseInstant(input.occurredAt) === null) {
    return err(validationError('life_event_instant_invalid', 'occurredAt must be an ISO-8601 instant.'));
  }

  const significance = input.significance ?? null;
  if (
    significance !== null &&
    (!Number.isInteger(significance) ||
      significance < MIN_SIGNIFICANCE ||
      significance > MAX_SIGNIFICANCE)
  ) {
    return err(
      validationError(
        'life_event_significance_out_of_range',
        `Significance is a whole number from ${String(MIN_SIGNIFICANCE)} to ${String(MAX_SIGNIFICANCE)}.`,
      ),
    );
  }

  return ok(input);
}

/* =========================================================================
 * Layout
 * ====================================================================== */

/** Days in a mean Gregorian year. Used only to label a span, never to date one. */
const DAYS_PER_YEAR = 365.2425;

/**
 * The day key an instant falls on, for positioning.
 *
 * UTC, deliberately, and this is the one place in the system where that is the
 * right answer rather than the §5.3 mistake. A zone shift moves an instant by
 * at most a day; on an axis that spans a decade that is a fifth of a pixel, and
 * carrying a zone through every bound and position here would buy nothing but
 * a parameter on six functions. `dayKeyInZone` is reused rather than
 * reimplemented so the parse and the fallback behave identically to everywhere
 * else.
 */
function positioningDayKey(instant: string): string {
  return dayKeyInZone(instant, 'UTC');
}

/**
 * A span's drawable extent.
 *
 * `endsAt` is the instant the bar stops at; `open` says whether that instant is
 * a recorded fact or today standing in for one. The pair exists so the two can
 * never be confused: a renderer that only received `endsAt` would have no way
 * to draw a chapter as continuing rather than as closed today, and §8.9's rule
 * about not fabricating what the record does not hold applies to a bar's right
 * edge as much as to a chart's interpolated gap.
 */
export type SpanExtent = {
  readonly startedAt: string;
  readonly endsAt: string;
  readonly open: boolean;
};

export function spanExtent(span: LifeSpan, nowIso: string): SpanExtent {
  return span.endedAt === null
    ? { startedAt: span.startedAt, endsAt: nowIso, open: true }
    : { startedAt: span.startedAt, endsAt: span.endedAt, open: false };
}

/** One horizontal track. Spans in a lane never overlap in time. */
export type SpanLane = {
  readonly lane: number;
  readonly spans: readonly LifeSpan[];
};

/**
 * Pack spans into non-overlapping lanes.
 *
 * ## Why lanes exist at all
 *
 * Two chapters genuinely overlap. A job runs from 2021 to 2025 and a
 * relationship runs from 2023 to 2026, and both are true at once — that is what
 * a chapter *is*. Drawn on a single line, one hides the other, and the timeline
 * loses precisely the thing §10.8 wants it for: the shape of a life is made of
 * things that ran concurrently.
 *
 * Greedy interval packing, spans sorted by start: each span takes the first
 * lane whose last occupant has already finished. That is optimal in lane count
 * for intervals and, more usefully here, it is *stable* — adding a chapter next
 * year does not shuffle the ones already on screen, which a bin-packing
 * optimiser would.
 *
 * ## Eras and chapters get separate lane groups
 *
 * An era is the backdrop; a chapter sits against it. Interleaving them would
 * put a two-decade phase in the same track as a nine-month job and make both
 * unreadable, so eras occupy the first lanes and chapters start below the last
 * era lane. Lane numbers are therefore contiguous across the whole layout, and
 * a lane never contains both kinds.
 *
 * @param nowIso Where an open span's bar stops. Never written to the record.
 */
export function layoutSpans(spans: readonly LifeSpan[], nowIso: string): readonly SpanLane[] {
  const eras = spans.filter((span) => span.kind === 'era');
  const chapters = spans.filter((span) => span.kind === 'chapter');

  const eraLanes = packGroup(eras, nowIso, 0);
  const chapterLanes = packGroup(chapters, nowIso, eraLanes.length);

  return [...eraLanes, ...chapterLanes];
}

function packGroup(
  spans: readonly LifeSpan[],
  nowIso: string,
  firstLane: number,
): readonly SpanLane[] {
  if (spans.length === 0) return [];

  /*
   * Packing compares day *indices*, not ISO strings. Two instants can describe
   * the same moment and sort the wrong way as text — `2024-01-01T00:00:00Z` is
   * lexically before `2023-12-31T20:00:00-05:00` and chronologically after it.
   * The record accepts an offset (§5.3 stores the zone), so a string compare
   * here would put a span in the wrong lane on exactly the rows that travelled.
   */
  const placed = spans
    .map((span) => {
      const extent = spanExtent(span, nowIso);
      return {
        span,
        from: dayKeyIndex(positioningDayKey(extent.startedAt)),
        to: dayKeyIndex(positioningDayKey(extent.endsAt)),
      };
    })
    .filter((entry): entry is { span: LifeSpan; from: number; to: number } =>
      entry.from !== null && entry.to !== null,
    )
    .sort((a, b) => (a.from === b.from ? (a.span.id < b.span.id ? -1 : 1) : a.from - b.from));

  const lanes: { readonly spans: LifeSpan[]; to: number }[] = [];

  for (const entry of placed) {
    /*
     * "First lane that is free" rather than "shortest lane". An open span holds
     * its lane out to `nowIso`, so every later span goes below it — which is
     * correct: a chapter that has not ended is still occupying that track.
     */
    const free = lanes.find((lane) => lane.to <= entry.from);
    if (free === undefined) {
      lanes.push({ spans: [entry.span], to: entry.to });
    } else {
      free.spans.push(entry.span);
      // Not unconditional: a span wholly contained in an earlier one would
      // otherwise pull the lane's occupancy backwards.
      if (entry.to > free.to) free.to = entry.to;
    }
  }

  return lanes.map((lane, index) => ({ lane: firstLane + index, spans: lane.spans }));
}

/* =========================================================================
 * Bounds and positions
 * ====================================================================== */

/**
 * The window the timeline draws, as day keys plus its length in years.
 *
 * Day keys rather than instants: at this zoom a pixel is weeks wide, and every
 * other windowing function in the system (`shiftDayKey`, `dayKeyIndex`, the
 * adherence grid) already speaks in calendar labels. `years` is carried so the
 * screen can label the axis without re-deriving it.
 */
export type TimelineBounds = {
  readonly fromDayKey: string;
  readonly toDayKey: string;
  readonly years: number;
};

/**
 * The window that contains everything, or `null` when there is nothing to draw.
 *
 * **`null`, never a default range.** An empty timeline rendered against an
 * invented "last ten years" axis would show a decade of confidently empty
 * space, which reads as ten years of nothing having happened rather than as a
 * page nobody has written yet. §8.9(3)'s "gaps are gaps" applies to the axis
 * itself: if there is no data, there is no axis.
 *
 * Open spans extend the window to `nowIso`, because that is where their bar
 * ends — the window has to contain what is drawn.
 */
export function boundsFor(
  spans: readonly LifeSpan[],
  events: readonly LifeEvent[],
  nowIso: string,
): TimelineBounds | null {
  let from: string | null = null;
  let to: string | null = null;

  const widen = (dayKey: string): void => {
    if (from === null || dayKey < from) from = dayKey;
    if (to === null || dayKey > to) to = dayKey;
  };

  for (const span of spans) {
    const extent = spanExtent(span, nowIso);
    widen(positioningDayKey(extent.startedAt));
    widen(positioningDayKey(extent.endsAt));
  }
  for (const event of events) {
    widen(positioningDayKey(event.occurredAt));
  }

  if (from === null || to === null) return null;

  const fromIndex = dayKeyIndex(from);
  const toIndex = dayKeyIndex(to);
  /* A malformed instant produced a non-date key upstream (see `dayKeyInZone`'s
   * fallback). Reporting no bounds is better than an axis of nonsense. */
  if (fromIndex === null || toIndex === null) return null;

  return {
    fromDayKey: from,
    toDayKey: to,
    years: (toIndex - fromIndex) / DAYS_PER_YEAR,
  };
}

/**
 * Where an instant sits in the window, as a fraction from 0 (left) to 1 (right).
 *
 * The screen does no date arithmetic — it multiplies this by a width. That
 * split is what lets the same numbers drive a bar, a marker and, later, a
 * metric band without three implementations of the same off-by-one.
 *
 * Clamped rather than refused when the instant falls outside the window: a
 * chapter that began before the visible year still begins at the left edge of
 * it, and returning `null` there would make every caller re-derive the
 * comparison this function just did. `null` means one thing only — the instant
 * could not be placed on a calendar at all.
 */
export function positionOf(instant: string, bounds: TimelineBounds): number | null {
  const index = dayKeyIndex(positioningDayKey(instant));
  const fromIndex = dayKeyIndex(bounds.fromDayKey);
  const toIndex = dayKeyIndex(bounds.toDayKey);
  if (index === null || fromIndex === null || toIndex === null) return null;

  const width = toIndex - fromIndex;
  /* A single-day window — one event and nothing else. Everything sits at the
   * start; dividing by zero would put it at NaN, which CSS renders as the whole
   * bar. */
  if (width <= 0) return 0;

  return Math.min(1, Math.max(0, (index - fromIndex) / width));
}
