/**
 * The product register — §4.2's "product register with introduction dates and
 * reaction history".
 *
 * ## Events, not state
 *
 * The schema comment states the design: introduction and discontinuation dates
 * live on `product_event` rather than on the product, "because §4.2's payoff
 * question — 'my chest acne worsened three weeks after starting that
 * moisturiser' — needs the *events*, not a current state. A product introduced,
 * dropped, and reintroduced has three events and one row."
 *
 * So {@link isActiveOn} derives whether a product was in use on a given day by
 * replaying its events. The `is_active` column exists as a cache for the hot
 * path; this function is the truth, and a test asserts they agree.
 *
 * ## The payoff question, answered honestly
 *
 * {@link changesBefore} answers "what changed in the fortnight before this
 * flare" with a *list of things that changed*. It does not rank them, score
 * them, or call any of them a cause.
 *
 * That restraint is the whole point. §14.2's Finding 9 records what happens
 * when a check is wrong even a fifth of the time — "a warning that is wrong even
 * twenty percent of the time is a warning that gets ignored within a fortnight,
 * taking the credible warnings with it." A suspected-trigger ranking over n=1
 * with a fortnight of lag would be wrong far more often than that. A list of
 * what changed is something the operator can reason about; a ranked list of
 * suspects is something they would either believe or stop reading.
 */

import { dayKeyIndex } from '../../temporal/instant';
import { dayKeyInZone } from '../../timeline/grouping';

export const PRODUCT_EVENT_KINDS = Object.freeze([
  'introduced',
  'discontinued',
  'repurchased',
  'reaction',
  'finished',
] as const);

export type ProductEventKind = (typeof PRODUCT_EVENT_KINDS)[number];

export type ProductSeverity = 'mild' | 'moderate' | 'severe';

export type SkincareProduct = {
  readonly id: string;
  readonly name: string;
  readonly brand: string | null;
  readonly category: string | null;
  readonly keyIngredients: readonly string[];
  readonly isActive: boolean;
  readonly notes: string | null;
};

export type ProductEvent = {
  readonly id: string;
  readonly productId: string;
  readonly kind: ProductEventKind;
  readonly occurredAt: string;
  readonly zone: string | null;
  readonly reactionDescription: string | null;
  readonly reactionSeverity: ProductSeverity | null;
  readonly note: string | null;
};

/** `CeraVe · Moisturising Lotion`, or just the name when there is no brand. */
export function productLabel(product: SkincareProduct): string {
  return product.brand === null ? product.name : `${product.brand} · ${product.name}`;
}

/* -------------------------------------------------------------------------
 * Use, replayed from events
 * ---------------------------------------------------------------------- */

/** The kinds that start a period of use, and the kinds that end one. */
const STARTS_USE: readonly ProductEventKind[] = Object.freeze(['introduced', 'repurchased']);
const ENDS_USE: readonly ProductEventKind[] = Object.freeze(['discontinued', 'finished']);

/**
 * Whether a product was in use on a day, by replaying its events up to and
 * including that day.
 *
 * `reaction` neither starts nor ends use — the operator may have reacted to
 * something and kept using it while they worked out whether it was that, and
 * inferring a discontinuation from a reaction would put a fact in the record
 * they never stated.
 */
export function isActiveOn(events: readonly ProductEvent[], productId: string, dayKey: string, zone: string): boolean {
  let active = false;
  for (const event of ordered(events, productId, zone)) {
    if (event.dayKey > dayKey) break;
    if (STARTS_USE.includes(event.event.kind)) active = true;
    else if (ENDS_USE.includes(event.event.kind)) active = false;
  }
  return active;
}

export type UsePeriod = {
  readonly productId: string;
  readonly fromDayKey: string;
  /** `null` while still in use. */
  readonly toDayKey: string | null;
};

/** Every period a product was in use, oldest first. */
export function usePeriods(events: readonly ProductEvent[], productId: string, zone: string): readonly UsePeriod[] {
  const periods: UsePeriod[] = [];
  let openFrom: string | null = null;

  for (const { event, dayKey } of ordered(events, productId, zone)) {
    if (STARTS_USE.includes(event.kind)) {
      openFrom ??= dayKey;
    } else if (ENDS_USE.includes(event.kind) && openFrom !== null) {
      periods.push({ productId, fromDayKey: openFrom, toDayKey: dayKey });
      openFrom = null;
    }
  }

  if (openFrom !== null) periods.push({ productId, fromDayKey: openFrom, toDayKey: null });
  return periods;
}

/**
 * Days since the product was most recently introduced, as of `asOfDayKey`.
 *
 * `null` when it has never been introduced or is not currently in use. The
 * figure matters because a skin reaction to a new product typically appears
 * within weeks, and "started 9 days ago" is the context that makes today's log
 * legible.
 */
export function daysSinceIntroduction(
  events: readonly ProductEvent[],
  productId: string,
  asOfDayKey: string,
  zone: string,
): number | null {
  const periods = usePeriods(events, productId, zone);
  const current = periods.at(-1);
  if (current === undefined || current.toDayKey !== null) return null;
  const from = dayKeyIndex(current.fromDayKey);
  const to = dayKeyIndex(asOfDayKey);
  if (from === null || to === null || to < from) return null;
  return to - from;
}

/* -------------------------------------------------------------------------
 * Reactions
 * ---------------------------------------------------------------------- */

export type Reaction = {
  readonly productId: string;
  readonly dayKey: string;
  readonly description: string | null;
  readonly severity: ProductSeverity | null;
};

/** Every recorded reaction, most recent first. The operator's words, unranked. */
export function reactionHistory(events: readonly ProductEvent[], zone: string): readonly Reaction[] {
  return events
    .filter((event) => event.kind === 'reaction')
    .map((event) => ({
      productId: event.productId,
      dayKey: dayKeyInZone(event.occurredAt, event.zone ?? zone),
      description: event.reactionDescription,
      severity: event.reactionSeverity,
    }))
    .sort((a, b) => (a.dayKey > b.dayKey ? -1 : a.dayKey < b.dayKey ? 1 : 0));
}

/* -------------------------------------------------------------------------
 * What changed
 * ---------------------------------------------------------------------- */

/** The default look-back for "what changed before this". Three weeks. */
export const CHANGE_WINDOW_DAYS = 21;

export type ProductChange = {
  readonly productId: string;
  readonly kind: ProductEventKind;
  readonly dayKey: string;
  readonly daysBefore: number;
};

/**
 * Product changes in the window before a day, most recent first.
 *
 * The return type carries `daysBefore` and nothing resembling a score. §4.2's
 * payoff question is answered by putting this list next to a flare annotation
 * and letting the operator — who is a person with a memory, not a dataset —
 * decide whether any of it is relevant.
 */
export function changesBefore(
  events: readonly ProductEvent[],
  dayKey: string,
  zone: string,
  windowDays: number = CHANGE_WINDOW_DAYS,
): readonly ProductChange[] {
  const anchor = dayKeyIndex(dayKey);
  if (anchor === null) return [];

  const changes: ProductChange[] = [];
  for (const event of events) {
    if (event.kind === 'reaction') continue;
    const eventDay = dayKeyInZone(event.occurredAt, event.zone ?? zone);
    const index = dayKeyIndex(eventDay);
    if (index === null) continue;
    const daysBefore = anchor - index;
    if (daysBefore < 0 || daysBefore > windowDays) continue;
    changes.push({ productId: event.productId, kind: event.kind, dayKey: eventDay, daysBefore });
  }

  return changes.sort((a, b) => a.daysBefore - b.daysBefore);
}

/* -------------------------------------------------------------------------
 * Shared ordering
 * ---------------------------------------------------------------------- */

type DatedEvent = { readonly event: ProductEvent; readonly dayKey: string };

function ordered(events: readonly ProductEvent[], productId: string, zone: string): readonly DatedEvent[] {
  return events
    .filter((event) => event.productId === productId)
    .map((event) => ({ event, dayKey: dayKeyInZone(event.occurredAt, event.zone ?? zone) }))
    .sort((a, b) =>
      a.dayKey < b.dayKey ? -1 : a.dayKey > b.dayKey ? 1 : a.event.occurredAt < b.event.occurredAt ? -1 : 1,
    );
}
