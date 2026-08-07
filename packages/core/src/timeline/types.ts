/**
 * The timeline.
 *
 * §3.2 gives it a surface and §3.3 R5 gives it a rule:
 *
 *   "**Timeline is the escape hatch.** Any entity anywhere links to its position
 *    on the timeline; the timeline links back to every entity. This is the
 *    connective tissue that makes the system feel like one thing."
 *
 * It is a **projection over the event log**, not a query over sixteen domain
 * tables. ADR 0005 explains why: a sixteen-way `UNION ALL`, re-planned on every
 * request and edited every time a domain is added, is the shape §3.3 R5 exists to
 * avoid. Projecting means a new domain appears on the timeline by emitting
 * events, with no timeline code change.
 *
 * ## What a timeline entry is
 *
 * A row that can be *rendered* without touching a domain table, and *expanded*
 * by following its links. That split is the whole design: the list view is one
 * indexed scan; detail is a join the user asked for.
 */

import type { EventCategory, EventType } from '../events/registry';

/** A link from a timeline entry back to the row it describes (§3.3 R5). */
export type TimelineLink = {
  readonly entityType: string;
  readonly entityId: string;
  /** `subject` for the primary row; `related` for context. */
  readonly relation: 'subject' | 'related';
};

/** Media attached to an entry, resolved lazily. */
export type TimelineMedia = {
  readonly mediaObjectId: string;
  readonly kind: string;
  /**
   * Whether the object is client-side encrypted (§5.5 sensitive tier).
   *
   * The timeline renders a placeholder for these rather than requesting a signed
   * URL — decryption needs the passphrase-derived key, which the server does not
   * have. A timeline that silently showed broken images for every skin photo
   * would look like a bug.
   */
  readonly isEncrypted: boolean;
  readonly complianceScore?: number;
};

/**
 * One entry.
 *
 * Denormalised on write by the projector. That is a deliberate trade: the
 * timeline is read constantly and written once per event, so the cost belongs on
 * the write. It is safe *because* of the ADR 0005 rule — the fields below are
 * labels and references, never authoritative values, so a stale entry cannot
 * disagree with a number.
 */
export type TimelineEntry = {
  /** The event this entry projects. One entry per event. */
  readonly eventId: string;
  readonly sequence: number;
  readonly eventType: EventType;
  readonly category: EventCategory;

  /** When it happened, and the zone it happened in (§5.3). */
  readonly occurredAt: string;
  readonly zone: string | null;
  /** The day it belongs to in the capture zone. Pre-computed — see `grouping.ts`. */
  readonly occurredOn: string;

  /** Rendered summary. Built by the projector from the payload. */
  readonly title: string;
  readonly detail: string | null;

  /** `primary` shows collapsed; `detail` only when a group is expanded. */
  readonly significance: 'primary' | 'detail';
  readonly clinical: boolean;

  /** Groups events from one user action (§3.2's single-day expansion). */
  readonly correlationId: string;

  readonly links: readonly TimelineLink[];
  readonly media: readonly TimelineMedia[];

  /**
   * Free-text search vector source.
   *
   * The title and detail only — **never event payload or entity content**.
   * §4.7's journal text must not become searchable through the timeline, and
   * `Journal.Created`'s payload deliberately carries no content for the same
   * reason.
   */
  readonly searchText: string;
};

/* =========================================================================
 * Query
 * ====================================================================== */

/** How entries are grouped for display. */
export type TimelineGrouping = 'none' | 'day' | 'week' | 'month' | 'correlation';

export type TimelineQuery = {
  /** Inclusive lower bound, ISO instant. */
  readonly from?: string;
  /** Exclusive upper bound. Half-open so adjacent pages never double-count. */
  readonly until?: string;

  readonly categories?: readonly EventCategory[];
  readonly eventTypes?: readonly EventType[];

  /**
   * Include `detail`-significance entries.
   *
   * Default false. A workout of forty sets emits forty `Workout.SetLogged`
   * events, and a collapsed timeline showing all of them buries the rest of the
   * day.
   */
  readonly includeDetail?: boolean;

  readonly clinicalOnly?: boolean;
  /** Entries with attached media — the photo-series view. */
  readonly withMediaOnly?: boolean;

  /** Full-text over title and detail. Never over payload or entity content. */
  readonly search?: string;

  /** Everything touching one entity. §3.3 R5's "links back to every entity". */
  readonly entity?: { readonly type: string; readonly id: string };

  readonly grouping?: TimelineGrouping;

  /**
   * Keyset cursor: the last `sequence` seen.
   *
   * Not an offset. `OFFSET 40000` re-scans forty thousand rows on every page and
   * — worse — shifts if an event is inserted mid-scroll, so a user paging back
   * through five years silently skips entries. A keyset cursor is stable and
   * O(page).
   */
  readonly afterSequence?: number;
  /** Reverse order — newest first, which is the default view. */
  readonly direction?: 'forward' | 'backward';
  readonly limit?: number;
};

export const TIMELINE_PAGE_SIZE = 50;
export const TIMELINE_MAX_PAGE_SIZE = 200;

export type TimelineGroup = {
  /** `2026-08-03`, `2026-W32`, `2026-08`, or a correlation id. */
  readonly key: string;
  readonly label: string;
  readonly entries: readonly TimelineEntry[];
};

export type TimelinePage = {
  readonly entries: readonly TimelineEntry[];
  /** Present when `grouping` was requested. */
  readonly groups?: readonly TimelineGroup[];
  /** Cursor for the next page. `null` at the end. */
  readonly nextCursor: number | null;
  /**
   * Whether more entries exist.
   *
   * Derived from fetching `limit + 1` rather than a `COUNT(*)`. An exact count
   * over a five-year timeline is a full scan on every page for information the
   * UI uses to decide whether to render one button.
   */
  readonly hasMore: boolean;
};

/**
 * Clamp and normalise a query.
 *
 * Called before the store sees it, so a caller cannot request 100,000 rows —
 * either by mistake or as a cheap way to exhaust memory on a single-user
 * deployment with no rate limit on reads.
 */
export function normaliseQuery(query: TimelineQuery): Required<Pick<TimelineQuery, 'limit' | 'direction' | 'grouping' | 'includeDetail'>> & TimelineQuery {
  return {
    ...query,
    limit: Math.min(Math.max(1, query.limit ?? TIMELINE_PAGE_SIZE), TIMELINE_MAX_PAGE_SIZE),
    direction: query.direction ?? 'backward',
    grouping: query.grouping ?? 'none',
    includeDetail: query.includeDetail ?? false,
  };
}
