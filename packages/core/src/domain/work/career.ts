/**
 * The career log — §4.8.
 *
 * §4.8 states the problem this solves before it states the feature, which is
 * unusual in that section and worth taking literally:
 *
 *   "**Career** — a running log of accomplishments, artifacts, feedback, and
 *    reviews. Solves a real recurring problem: reconstructing a year of work at
 *    review time from memory. Every shipped thing gets one line on the day it
 *    ships."
 *
 * Two consequences run through this file.
 *
 * **The protocol is one line on the day.** So the metric that matters is not
 * how many entries exist, it is how long the log has been silent — a career log
 * with forty entries all typed the week before a review is a memory
 * reconstruction with extra steps, which is the exact failure it exists to
 * prevent. {@link loggingGap} is that measure, and it reads `occurredAt`
 * against the day, not `createdAt`.
 *
 * **Review time is the read.** {@link summarisePeriod} produces what a review
 * form asks for and nothing else: what shipped, what was said about it, which
 * of it was visible, and which skills it exercised. It ranks nothing and
 * scores nothing. §10.0 puts the model outside the path of any figure, and this
 * is a page carried into a conversation about money.
 */

import type { Result } from '@naitikos/shared';
import { err, ok } from '@naitikos/shared';

import type { DomainError } from '../../errors/domain-error';
import { validationError } from '../../errors/domain-error';
import { dayKeyIndex } from '../../temporal/instant';
import { parseInstant } from '../../temporal/instant';

/** Mirrors the `career_entry_kind` pgEnum exactly. */
export const CAREER_ENTRY_KINDS = Object.freeze([
  'shipped',
  'artifact',
  'feedback',
  'recognition',
  'review',
  'role_change',
  'incident',
] as const);

export type CareerEntryKind = (typeof CAREER_ENTRY_KINDS)[number];

export const CAREER_KIND_LABELS: Readonly<Record<CareerEntryKind, string>> = Object.freeze({
  shipped: 'Shipped',
  artifact: 'Artifact',
  feedback: 'Feedback',
  recognition: 'Recognition',
  review: 'Review',
  role_change: 'Role change',
  /* An incident is career history. Leaving it out would make the log a
   * highlight reel, and a highlight reel is not what gets consulted when the
   * question is "what did I learn last year". */
  incident: 'Incident',
});

export function isCareerEntryKind(value: string): value is CareerEntryKind {
  return (CAREER_ENTRY_KINDS as readonly string[]).includes(value);
}

export type CareerEntry = {
  readonly id: string;
  readonly kind: CareerEntryKind;
  readonly title: string;
  readonly detail: string | null;
  readonly occurredAt: string;
  readonly projectId: string | null;
  readonly attributedTo: string | null;
  readonly artifactUrl: string | null;
  readonly isVisibleToLeadership: boolean | null;
  readonly skills: readonly string[];
};

export type CareerEntryInput = {
  readonly id: string;
  readonly kind: CareerEntryKind;
  readonly title: string;
  readonly detail?: string | null;
  readonly occurredAt: string;
  readonly projectId?: string | null;
  readonly attributedTo?: string | null;
  readonly artifactUrl?: string | null;
  readonly isVisibleToLeadership?: boolean | null;
  readonly skills?: readonly string[];
};

export function validateCareerEntry(input: CareerEntryInput): Result<CareerEntryInput, DomainError> {
  if (input.title.trim() === '') {
    return err(validationError('career_entry_title_empty', 'A career entry needs a title.'));
  }
  if (!isCareerEntryKind(input.kind)) {
    return err(validationError('career_entry_kind_unknown', `Unknown career entry kind: ${input.kind}.`));
  }
  if (parseInstant(input.occurredAt) === null) {
    return err(validationError('career_entry_occurred_invalid', 'occurredAt must be an ISO-8601 instant.'));
  }

  /*
   * Feedback and recognition need a source.
   *
   * "Good work on the migration" with nobody attached is unusable at review
   * time — the first question asked of it is who said so, and an entry that
   * cannot answer is worse than no entry, because it looks like evidence.
   */
  if ((input.kind === 'feedback' || input.kind === 'recognition') && (input.attributedTo ?? '').trim() === '') {
    return err(
      validationError(
        'career_entry_attribution_missing',
        'Feedback and recognition need a source. Unattributed praise is not evidence.',
      ),
    );
  }

  return ok(input);
}

/* -------------------------------------------------------------------------
 * The gap
 * ---------------------------------------------------------------------- */

/**
 * How many days of silence before the log is worth a nudge.
 *
 * Fourteen. §4.8's protocol is per-shipped-thing rather than per-day, and a
 * fortnight with nothing shipped, no feedback and no incident is either a quiet
 * fortnight — fine, and worth knowing — or a fortnight the log missed.
 */
export const CAREER_GAP_DAYS = 14;

/**
 * Days since the most recent entry, or `null` if the log is empty.
 *
 * Measured on `occurredAt`, not `createdAt`. An entry backdated to the day it
 * happened closes the gap it was meant to close, which is the behaviour the
 * protocol wants to reward.
 */
export function loggingGap(
  entries: readonly CareerEntry[],
  todayDayKey: string,
  dayKeyOf: (instant: string) => string,
): number | null {
  const today = dayKeyIndex(todayDayKey);
  if (today === null || entries.length === 0) return null;

  let newest: number | null = null;
  for (const entry of entries) {
    const index = dayKeyIndex(dayKeyOf(entry.occurredAt));
    if (index === null) continue;
    if (newest === null || index > newest) newest = index;
  }

  return newest === null ? null : Math.max(0, today - newest);
}

/* -------------------------------------------------------------------------
 * The review read
 * ---------------------------------------------------------------------- */

export type SkillTally = {
  readonly skill: string;
  readonly entries: number;
};

export type CareerPeriod = {
  readonly fromDayKey: string;
  readonly toDayKey: string;
  readonly total: number;
  readonly byKind: Readonly<Record<CareerEntryKind, number>>;
  /**
   * Entries marked visible to leadership, and entries explicitly marked not.
   *
   * Three counts rather than a ratio, because `null` is a real answer here —
   * "I did not record whether anyone saw this" is different from "nobody did",
   * and a percentage would silently fold the unknowns into one of the two.
   */
  readonly visible: number;
  readonly notVisible: number;
  readonly visibilityUnknown: number;
  readonly skills: readonly SkillTally[];
  /** Entries in the period, newest first. */
  readonly entries: readonly CareerEntry[];
};

/**
 * Everything a review form asks for, over a window.
 *
 * `dayKeyOf` is injected rather than imported so the caller supplies the zone.
 * §5.3 keeps zone interpretation at the edge, and a career period boundary in
 * the wrong zone silently moves an entry between two review cycles.
 */
export function summarisePeriod(
  entries: readonly CareerEntry[],
  fromDayKey: string,
  toDayKey: string,
  dayKeyOf: (instant: string) => string,
): CareerPeriod {
  const inPeriod = entries.filter((entry) => {
    const key = dayKeyOf(entry.occurredAt);
    return key >= fromDayKey && key <= toDayKey;
  });

  const byKind = Object.fromEntries(CAREER_ENTRY_KINDS.map((kind) => [kind, 0])) as Record<
    CareerEntryKind,
    number
  >;
  const skills = new Map<string, number>();
  let visible = 0;
  let notVisible = 0;
  let unknown = 0;

  for (const entry of inPeriod) {
    byKind[entry.kind] += 1;

    if (entry.isVisibleToLeadership === true) visible += 1;
    else if (entry.isVisibleToLeadership === false) notVisible += 1;
    else unknown += 1;

    for (const skill of entry.skills) {
      const normalised = skill.trim().toLowerCase();
      if (normalised === '') continue;
      skills.set(normalised, (skills.get(normalised) ?? 0) + 1);
    }
  }

  return {
    fromDayKey,
    toDayKey,
    total: inPeriod.length,
    byKind: Object.freeze(byKind),
    visible,
    notVisible,
    visibilityUnknown: unknown,
    skills: [...skills.entries()]
      .map(([skill, count]) => ({ skill, entries: count }))
      /* Count first, then alphabetically — a stable order matters on a page
       * that gets re-read across a review cycle and compared with itself. */
      .sort((a, b) => b.entries - a.entries || a.skill.localeCompare(b.skill)),
    entries: [...inPeriod].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)),
  };
}
