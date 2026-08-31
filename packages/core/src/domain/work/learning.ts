/**
 * Learning — §4.8.
 *
 * §4.8 gives four words and one link: "queue, progress, notes, synthesis. Links
 * to Career for skill development."
 *
 * ## Abandonment is an outcome, not a failure
 *
 * `abandoned` is a first-class status. A queue that can only be finished is a
 * queue that accumulates guilt, and the operator stops adding to it — at which
 * point the queue stops recording what they were actually reading, which was
 * the only thing it was for. What §4.8 wants is the linkage between what was
 * learned and what it was for, and a book put down after forty pages with a
 * sentence about why is more useful than one that sits at "in progress"
 * forever.
 *
 * ## Progress is a fraction of a self-declared total
 *
 * Not a page number. A book, a course and a paper count in three different
 * units, and the question asked of the column is always "how far in". The unit
 * is recorded alongside so the number is never ambiguous, and a total of `null`
 * produces no fraction at all rather than a zero — §10.9's "insufficient data"
 * rather than a guess.
 */

import type { Result } from '@naitikos/shared';
import { err, ok } from '@naitikos/shared';

import type { DomainError } from '../../errors/domain-error';
import { validationError } from '../../errors/domain-error';

/** Mirrors the `learning_kind` pgEnum exactly. */
export const LEARNING_KINDS = Object.freeze(['book', 'paper', 'course', 'talk', 'article', 'other'] as const);

export type LearningKind = (typeof LEARNING_KINDS)[number];

export const LEARNING_KIND_LABELS: Readonly<Record<LearningKind, string>> = Object.freeze({
  book: 'Book',
  paper: 'Paper',
  course: 'Course',
  talk: 'Talk',
  article: 'Article',
  other: 'Other',
});

/** The unit a kind usually counts in. A default, never a constraint. */
export const DEFAULT_UNIT_LABEL: Readonly<Record<LearningKind, string>> = Object.freeze({
  book: 'pages',
  paper: 'pages',
  course: 'lessons',
  talk: 'minutes',
  article: 'minutes',
  other: 'units',
});

/** Mirrors the `learning_status` pgEnum exactly. */
export const LEARNING_STATUSES = Object.freeze(['queued', 'in_progress', 'finished', 'abandoned'] as const);

export type LearningStatus = (typeof LEARNING_STATUSES)[number];

export const LEARNING_STATUS_LABELS: Readonly<Record<LearningStatus, string>> = Object.freeze({
  queued: 'Queued',
  in_progress: 'Reading',
  finished: 'Finished',
  /* "Put down", not "abandoned" or "failed". The status name in the database is
   * the blunt one; the word the operator reads is the honest one without the
   * judgement attached. */
  abandoned: 'Put down',
});

export function isLearningStatus(value: string): value is LearningStatus {
  return (LEARNING_STATUSES as readonly string[]).includes(value);
}

export function isLearningKind(value: string): value is LearningKind {
  return (LEARNING_KINDS as readonly string[]).includes(value);
}

export type LearningItem = {
  readonly id: string;
  readonly kind: LearningKind;
  readonly title: string;
  readonly author: string | null;
  readonly url: string | null;
  readonly status: LearningStatus;
  readonly totalUnits: number | null;
  readonly completedUnits: number | null;
  readonly unitLabel: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly abandonedReason: string | null;
  readonly synthesis: string | null;
  readonly skills: readonly string[];
};

export type LearningItemInput = {
  readonly id: string;
  readonly kind: LearningKind;
  readonly title: string;
  readonly author?: string | null;
  readonly url?: string | null;
  readonly totalUnits?: number | null;
  readonly unitLabel?: string | null;
  readonly skills?: readonly string[];
};

export function validateLearningItem(input: LearningItemInput): Result<LearningItemInput, DomainError> {
  if (input.title.trim() === '') {
    return err(validationError('learning_title_empty', 'A learning item needs a title.'));
  }
  if (!isLearningKind(input.kind)) {
    return err(validationError('learning_kind_unknown', `Unknown learning kind: ${input.kind}.`));
  }
  const total = input.totalUnits ?? null;
  if (total !== null && (!Number.isInteger(total) || total <= 0)) {
    return err(validationError('learning_total_invalid', 'A total must be a positive whole number of units.'));
  }
  return ok(input);
}

/**
 * How far through, as a 0–1 fraction, or `null` when it cannot be said.
 *
 * `null` rather than `0` for a missing total. §10.9 asks for "insufficient
 * data" over a guess, and a progress bar sitting at zero for a book that is
 * half read is a specific, wrong claim.
 */
export function learningProgress(item: LearningItem): number | null {
  const total = item.totalUnits;
  const done = item.completedUnits;
  if (total === null || done === null || total <= 0) return null;
  return Math.max(0, Math.min(1, done / total));
}

/**
 * A one-line description of where something is, for a list.
 *
 * Never "0%" for an unmeasured item; it says so instead.
 */
export function describeProgress(item: LearningItem): string {
  const fraction = learningProgress(item);
  const unit = item.unitLabel ?? DEFAULT_UNIT_LABEL[item.kind];

  if (fraction === null) {
    if (item.completedUnits !== null) return `${String(item.completedUnits)} ${unit} in`;
    return item.status === 'queued' ? 'Not started' : 'No progress recorded';
  }
  return `${String(item.completedUnits ?? 0)} of ${String(item.totalUnits ?? 0)} ${unit} · ${String(
    Math.round(fraction * 100),
  )}%`;
}

/**
 * Queue order: what to pick up next.
 *
 * In-progress first, then queued, then everything closed. Within a group, the
 * order is the order things were added — a queue that reshuffles itself by
 * recency rewards the most recent enthusiasm and buries the thing that was
 * genuinely worth reading four months ago.
 */
export function queueOrder(items: readonly LearningItem[]): readonly LearningItem[] {
  const rank = (status: LearningStatus): number =>
    status === 'in_progress' ? 0 : status === 'queued' ? 1 : status === 'finished' ? 2 : 3;
  return [...items].sort((a, b) => rank(a.status) - rank(b.status) || a.id.localeCompare(b.id));
}

/**
 * Skills the queue has covered but the career log has not, and the reverse.
 *
 * §4.8's "Links to Career for skill development", made concrete. Reported as
 * two lists and nothing more: a skill learned and never applied is worth
 * noticing, and so is one applied without any deliberate study behind it. The
 * system does not say which of those is a problem, because for any given skill
 * either could be entirely fine.
 */
export type SkillCrossover = {
  readonly studiedNotApplied: readonly string[];
  readonly appliedNotStudied: readonly string[];
  readonly both: readonly string[];
};

export function skillCrossover(
  items: readonly LearningItem[],
  careerSkills: readonly string[],
): SkillCrossover {
  const normalise = (skill: string): string => skill.trim().toLowerCase();

  const studied = new Set<string>();
  for (const item of items) {
    /* Only finished and in-progress items count as study. A queued book is an
     * intention, and counting it would make the queue a claim about what the
     * operator knows. */
    if (item.status === 'queued') continue;
    for (const skill of item.skills) {
      const key = normalise(skill);
      if (key !== '') studied.add(key);
    }
  }

  const applied = new Set(careerSkills.map(normalise).filter((skill) => skill !== ''));

  const both = [...studied].filter((skill) => applied.has(skill)).sort();
  return {
    studiedNotApplied: [...studied].filter((skill) => !applied.has(skill)).sort(),
    appliedNotStudied: [...applied].filter((skill) => !studied.has(skill)).sort(),
    both,
  };
}
