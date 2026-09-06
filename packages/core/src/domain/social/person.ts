/**
 * People — §3.2's `/life/people`, and the one question it is worth answering.
 *
 * §3.2 gives this route two words, "People & relationships", and no §4 section.
 * That absence is an opportunity to get the scope right rather than a licence
 * to build a CRM, so this file answers exactly one question:
 *
 *   **Who have I not spoken to?**
 *
 * Everything below exists to make that answerable and nothing else does. There
 * is no closeness score, no interaction quality rating, no sentiment, and no
 * ranking. Those are all judgements about a person, stored permanently
 * somewhere that person cannot see or correct — and unlike every other row in
 * this database, the subject of these rows is not the operator.
 *
 * ## The cadence is set, never inferred
 *
 * The obvious feature is to learn the natural rhythm of a relationship from its
 * history and flag departures from it. It is also exactly what §10.0 forbids:
 * "the model never computes, discovers, or asserts". A system telling someone
 * they are drifting from a friend, on the evidence of a gap between two
 * timestamps, is asserting something about a relationship it cannot see.
 *
 * So {@link contactStatus} compares against a cadence the operator typed. When
 * there is none, the status is `untracked` — not "fine", and not a default of
 * ninety days. §8.9's "missing data is shown as missing", applied to an absent
 * intention rather than an absent measurement.
 *
 * ## `overdue` is a fact about a number, not about a friendship
 *
 * The word is doing a lot of work and the UI copy has to be careful with it.
 * What the system knows is that more days have passed than the operator said
 * they wanted. It does not know about the message sent from a phone, the
 * afternoon spent together that nobody logged, or the fact that this is simply
 * how the two of them are. The status is a prompt to look, never a verdict.
 */

import type { Result } from '@naitikos/shared';
import { err, ok } from '@naitikos/shared';

import type { DomainError } from '../../errors/domain-error';
import { validationError } from '../../errors/domain-error';
import { dayKeyIndex } from '../../temporal/instant';

/** Mirrors the `relationship_kind` pgEnum exactly. */
export const RELATIONSHIP_KINDS = Object.freeze([
  'family',
  'friend',
  'colleague',
  'professional',
  'acquaintance',
  'other',
] as const);

export type RelationshipKind = (typeof RELATIONSHIP_KINDS)[number];

export const RELATIONSHIP_LABELS: Readonly<Record<RelationshipKind, string>> = Object.freeze({
  family: 'Family',
  friend: 'Friend',
  colleague: 'Colleague',
  /* A doctor, a dentist, a therapist, an accountant. Kept distinct from
   * `colleague` because "when did I last see them" means something entirely
   * different for the two, and §4.4's appointment tracking already cares. */
  professional: 'Professional',
  acquaintance: 'Acquaintance',
  other: 'Other',
});

/** Mirrors the `interaction_kind` pgEnum exactly. */
export const INTERACTION_KINDS = Object.freeze(['in_person', 'call', 'video', 'message', 'other'] as const);

export type InteractionKind = (typeof INTERACTION_KINDS)[number];

export const INTERACTION_LABELS: Readonly<Record<InteractionKind, string>> = Object.freeze({
  in_person: 'In person',
  call: 'Call',
  video: 'Video',
  message: 'Message',
  other: 'Other',
});

export function isRelationshipKind(value: string): value is RelationshipKind {
  return (RELATIONSHIP_KINDS as readonly string[]).includes(value);
}

export function isInteractionKind(value: string): value is InteractionKind {
  return (INTERACTION_KINDS as readonly string[]).includes(value);
}

export type Person = {
  readonly id: string;
  readonly name: string;
  readonly relationship: RelationshipKind;
  readonly context: string | null;
  /** `--MM-DD`, or null. Day and month only — see the schema comment. */
  readonly birthday: string | null;
  readonly cadenceDays: number | null;
};

export type PersonInput = {
  readonly id: string;
  readonly name: string;
  readonly relationship: RelationshipKind;
  readonly context?: string | null;
  readonly birthday?: string | null;
  readonly cadenceDays?: number | null;
};

export type Interaction = {
  readonly id: string;
  readonly personId: string;
  readonly kind: InteractionKind;
  readonly occurredAt: string;
  readonly zone: string;
  readonly dayKey: string;
  readonly note: string | null;
};

/** The longest cadence worth recording, in days. */
export const MAX_CADENCE_DAYS = 730;

/** How far ahead {@link upcomingBirthdays} looks. */
export const BIRTHDAY_HORIZON_DAYS = 30;

const NAME_MAX = 120;
const CONTEXT_MAX = 500;
const NOTE_MAX = 2000;

/** `--MM-DD`, the RFC 6350 partial date. Mirrored by a CHECK on the column. */
const PARTIAL_DATE = /^--(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export function validatePerson(input: PersonInput): Result<Person, DomainError> {
  const name = input.name.trim();
  if (name === '') {
    return err(validationError('name', 'A person needs a name — whatever you call them is fine.'));
  }
  if (name.length > NAME_MAX) {
    return err(validationError('name', `A name is at most ${String(NAME_MAX)} characters.`));
  }

  const context = input.context?.trim() ?? '';
  if (context.length > CONTEXT_MAX) {
    return err(validationError('context', `Keep the context under ${String(CONTEXT_MAX)} characters.`));
  }

  const birthday = input.birthday?.trim() ?? '';
  if (birthday !== '' && !PARTIAL_DATE.test(birthday)) {
    /*
     * The message names the format rather than saying "invalid", because the
     * format is unusual on purpose and nobody guesses `--MM-DD` unprompted.
     */
    return err(
      validationError('birthday', 'A birthday is a day and a month, written --MM-DD. The year is not stored.'),
    );
  }
  /*
   * 30 February passes the regex and is not a day. Checked here rather than in
   * the column, because a CHECK expressive enough to know February has 29 days
   * at most would be a calendar implemented in SQL.
   */
  if (birthday !== '' && !isRealMonthDay(birthday)) {
    return err(validationError('birthday', `${birthday.slice(2)} is not a day that exists.`));
  }

  const cadence = input.cadenceDays ?? null;
  if (cadence !== null && (!Number.isInteger(cadence) || cadence < 1 || cadence > MAX_CADENCE_DAYS)) {
    return err(
      validationError('cadenceDays', `A cadence is between 1 and ${String(MAX_CADENCE_DAYS)} days, or nothing.`),
    );
  }

  return ok({
    id: input.id,
    name,
    relationship: input.relationship,
    context: context === '' ? null : context,
    birthday: birthday === '' ? null : birthday,
    cadenceDays: cadence,
  });
}

/**
 * Whether `--MM-DD` names a day that exists.
 *
 * 29 February is accepted. The year is unknown by construction, so refusing it
 * would refuse a real birthday held by real people on the grounds that three
 * years in four it does not occur.
 */
function isRealMonthDay(partial: string): boolean {
  const month = Number(partial.slice(2, 4));
  const day = Number(partial.slice(5, 7));
  const lengths = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const limit = lengths[month - 1];
  return limit !== undefined && day >= 1 && day <= limit;
}

export type InteractionInput = {
  readonly id: string;
  readonly personId: string;
  readonly kind: InteractionKind;
  readonly occurredAt: string;
  readonly zone: string;
  readonly dayKey: string;
  readonly note?: string | null;
};

export function validateInteraction(input: InteractionInput): Result<InteractionInput, DomainError> {
  const note = input.note?.trim() ?? '';
  if (note.length > NOTE_MAX) {
    return err(validationError('note', `Keep the note under ${String(NOTE_MAX)} characters.`));
  }
  if (dayKeyIndex(input.dayKey) === null) {
    return err(validationError('dayKey', 'The day this happened on could not be read.'));
  }

  return ok({ ...input, note: note === '' ? null : note });
}

/* =========================================================================
 * Contact status
 * ====================================================================== */

/**
 * Where a relationship stands against the cadence the operator set.
 *
 *   - `untracked` — no cadence. Not "fine": the operator has not said.
 *   - `never` — a cadence, and no interaction has ever been recorded.
 *   - `current` — inside the cadence.
 *   - `due` — at or just past it, within {@link DUE_GRACE_DAYS}.
 *   - `overdue` — past it by more than the grace.
 */
export type ContactState = 'untracked' | 'never' | 'current' | 'due' | 'overdue';

/**
 * How long past a cadence still counts as `due` rather than `overdue`.
 *
 * A tenth of the cadence, floored at one day and capped at a week. A fixed
 * number would be wrong at both ends — three days past a weekly call is a
 * different thing from three days past an annual one — and a proportion keeps
 * the two comparable without the page having to explain itself.
 */
export function dueGraceDays(cadenceDays: number): number {
  return Math.min(7, Math.max(1, Math.floor(cadenceDays / 10)));
}

export type ContactStatus = {
  readonly state: ContactState;
  /** Days since the last recorded contact, or `null` if there has been none. */
  readonly daysSince: number | null;
  /** How many days past the cadence, negative when still inside it. */
  readonly daysOver: number | null;
};

/**
 * Status for one person as of `todayDayKey`.
 *
 * `lastContactDayKey` is the day of the most recent interaction, not an
 * instant. A call at 23:50 and one at 00:10 the next morning are a day apart in
 * the only sense this page cares about, and comparing instants would report
 * "0 days" for one and "1 day" for the other on the strength of twenty minutes.
 */
export function contactStatus(
  person: Pick<Person, 'cadenceDays'>,
  lastContactDayKey: string | null,
  todayDayKey: string,
): ContactStatus {
  const cadence = person.cadenceDays;
  const today = dayKeyIndex(todayDayKey);
  const last = lastContactDayKey === null ? null : dayKeyIndex(lastContactDayKey);

  const daysSince = today === null || last === null ? null : today - last;

  if (cadence === null) return { state: 'untracked', daysSince, daysOver: null };
  if (daysSince === null) return { state: 'never', daysSince: null, daysOver: null };

  const daysOver = daysSince - cadence;
  if (daysOver < 0) return { state: 'current', daysSince, daysOver };
  if (daysOver <= dueGraceDays(cadence)) return { state: 'due', daysSince, daysOver };
  return { state: 'overdue', daysSince, daysOver };
}

/** Sort order for the list: the ones that need attention, then the rest. */
const STATE_RANK: Readonly<Record<ContactState, number>> = Object.freeze({
  overdue: 0,
  due: 1,
  never: 2,
  current: 3,
  untracked: 4,
});

export type PersonWithStatus = {
  readonly person: Person;
  readonly status: ContactStatus;
  readonly lastContactDayKey: string | null;
};

/**
 * Order for the page: attention first, then longest silence, then by name.
 *
 * `never` ranks below `due` rather than above `overdue`, which looks wrong for
 * about a second. Someone with a cadence and no recorded contact is almost
 * always someone added five minutes ago, and putting a fresh row at the top of
 * an alarm list every time one is created would make the top of the list mean
 * nothing within a fortnight.
 */
export function orderByAttention(entries: readonly PersonWithStatus[]): readonly PersonWithStatus[] {
  return [...entries].sort((left, right) => {
    const byState = STATE_RANK[left.status.state] - STATE_RANK[right.status.state];
    if (byState !== 0) return byState;

    const bySilence = (right.status.daysSince ?? -1) - (left.status.daysSince ?? -1);
    if (bySilence !== 0) return bySilence;

    return left.person.name.localeCompare(right.person.name);
  });
}

/* =========================================================================
 * Birthdays
 * ====================================================================== */

export type UpcomingBirthday = {
  readonly person: Person;
  /** Days from today, 0 meaning today. */
  readonly inDays: number;
  /** `--MM-DD`, as stored. */
  readonly monthDay: string;
};

/**
 * Birthdays within {@link BIRTHDAY_HORIZON_DAYS}, soonest first.
 *
 * The year is not stored, so the arithmetic is on month and day against the
 * day key alone — no `Date` construction, no zone, and no leap-year edge case
 * beyond the one below. `todayDayKey` is already the operator's local day,
 * which is the only frame in which "is it their birthday" has an answer.
 *
 * A 29 February birthday is shown on 28 February in a common year. Choosing 1
 * March instead would put it in the wrong month, and choosing to hide it would
 * be worse than either.
 */
export function upcomingBirthdays(
  people: readonly Person[],
  todayDayKey: string,
  horizonDays: number = BIRTHDAY_HORIZON_DAYS,
): readonly UpcomingBirthday[] {
  const parts = todayDayKey.split('-');
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  if (!Number.isInteger(month) || !Number.isInteger(day)) return [];

  const isLeap = isLeapYear(Number(parts[0]));
  const todayOrdinal = ordinalOf(month, day, isLeap);
  const yearLength = isLeap ? 366 : 365;

  const upcoming: UpcomingBirthday[] = [];
  for (const person of people) {
    if (person.birthday === null) continue;

    let birthMonth = Number(person.birthday.slice(2, 4));
    let birthDay = Number(person.birthday.slice(5, 7));
    if (!isLeap && birthMonth === 2 && birthDay === 29) {
      birthMonth = 2;
      birthDay = 28;
    }

    const ordinal = ordinalOf(birthMonth, birthDay, isLeap);
    /* Wraps across the year end, so a 3 January birthday is 4 days away on
     * 30 December rather than 361 days ago. */
    const inDays = (ordinal - todayOrdinal + yearLength) % yearLength;
    if (inDays <= horizonDays) {
      upcoming.push({ person, inDays, monthDay: person.birthday });
    }
  }

  return upcoming.sort((left, right) => left.inDays - right.inDays || left.person.name.localeCompare(right.person.name));
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Day of year, 1-based. */
function ordinalOf(month: number, day: number, leap: boolean): number {
  const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let total = day;
  for (let index = 0; index < month - 1; index += 1) total += lengths[index] ?? 0;
  return total;
}
