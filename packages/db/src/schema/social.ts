/**
 * People and Places — §3.2's `/life/people` and `/life/places`.
 *
 * These are the last two [V3] routes with no schema behind them, and they are
 * the two most at risk of becoming something this system is not. So the shape
 * below is defined as much by refusals as by columns.
 *
 * ## This is not a CRM, and the difference is what gets stored
 *
 * A contacts app stores facts *about people*. This stores facts about **the
 * operator's contact with them**. The distinction is not pedantry: everything
 * else in this database is the operator's own record of their own life, held
 * under P7's local-only posture because it is theirs to hold. A third party's
 * details are not theirs in the same way, and that person will never see this
 * row, never correct it, and never know it exists.
 *
 * The consequences, applied throughout:
 *
 *   - No contact details. No phone number, no email, no address. Those live in
 *     a phone's address book, which is a system built to sync them and to be
 *     wiped when a phone is lost.
 *   - No characterisation. {@link relationshipKind} is six coarse buckets and
 *     there is no closeness score, no sentiment, and no "importance". A number
 *     ranking one's friends is a thing to have written down exactly never.
 *   - No birthdays beyond a day and month. A year of birth is somebody else's
 *     personal data with no bearing on any question here.
 *   - {@link interaction} records *that* contact happened, and a note the
 *     operator chose to write. It does not record what was said.
 *
 * What is left answers one question well: **who have I not spoken to.** That is
 * the question a relationship log is actually useful for, and it is answerable
 * from a timestamp and a name.
 *
 * ## Places exist because a trip explains a discontinuity
 *
 * The compelling reason for `/life/places` is not a travel diary. It is that
 * §10.6's detectors are looking for changes in series — sleep midpoint, weight,
 * skin state, training volume — and **a trip moves all of them at once, for
 * reasons that have nothing to do with anything the system is measuring.**
 *
 * §5.3 already insists on this at the row level: "A workout at '7am' during
 * travel is a materially different fact from one at 7am at home." A {@link
 * visit} is that same fact at the scale of a fortnight, recorded once instead
 * of inferred from a hundred timezone offsets — and it is the thing that stops
 * a detector reporting a two-week sleep disruption as a finding when the honest
 * description is "was in London".
 *
 * ## Both tables are written by hand, and stay that way
 *
 * Nothing here is derived. §10.0's "the model never computes, discovers, or
 * asserts" applies with unusual force: an inferred relationship, or an inferred
 * trip from a run of foreign timezone offsets, would be the system making a
 * claim about the operator's life from a signal that is merely consistent with
 * it. `calendar_event.is_travel` is a guess and is labelled one; these are not
 * guesses.
 */

import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';

import { interactionKind, placeKind, relationshipKind, tripPurpose } from './enums';
import { entityColumns, ianaZone, instant, reference, searchVector } from './columns';

/**
 * Someone in the operator's life.
 *
 * Soft-deleted like every other entity (§9.4) rather than purged, because the
 * interactions point at it and a dangling interaction is a record of contact
 * with nobody. `purge` remains the one path that actually removes data, and it
 * is the right one to use when the answer is "this person should not be in my
 * database at all".
 */
export const person = pgTable(
  'person',
  {
    ...entityColumns,

    /** What the operator calls them. Not a legal name, and not required to be. */
    name: text().notNull(),
    relationship: relationshipKind().notNull(),

    /**
     * How they came into the operator's life, in a sentence.
     *
     * The one free-text field, and it is deliberately about the *connection*
     * rather than the person — "met at the Bangalore office, 2024" rather than
     * a description of who they are.
     */
    context: text(),

    /**
     * Day and month only, as `--MM-DD`.
     *
     * Not a `date`, because a date needs a year and the year is not this
     * system's business. Stored as text in the RFC 6350 partial-date form the
     * vCard spec uses for exactly this case, so the omission is explicit rather
     * than encoded as a sentinel year nobody remembers the meaning of.
     */
    birthday: text(),

    /**
     * How often the operator wants to be in touch, in days.
     *
     * A cadence the operator sets, never one the system infers. It is what
     * turns "last spoke in March" into "overdue", and without it the list is a
     * pile of dates that says nothing. Null means no cadence, which is the
     * right answer for most people and the default.
     */
    cadenceDays: integer(),

    searchVector: searchVector('name', 'context'),
  },
  (t) => [
    index('person_relationship_idx').on(t.relationship, t.name).where(sql`${t.deletedAt} IS NULL`),
    index('person_search_idx').using('gin', t.searchVector),
    check('person_cadence_positive', sql`${t.cadenceDays} IS NULL OR ${t.cadenceDays} > 0`),
    /*
     * `--MM-DD`, or nothing. Enforced here rather than in the application
     * because a birthday that failed to parse would show up as a missing
     * reminder rather than as an error, which is the class of bug that is
     * discovered a year late.
     */
    check('person_birthday_partial_date', sql`${t.birthday} IS NULL OR ${t.birthday} ~ '^--[0-1][0-9]-[0-3][0-9]$'`),
  ],
);

/**
 * A recorded contact.
 *
 * Append-mostly: an interaction is a fact about a moment, and editing one is
 * rewriting what happened. It is not in the `observation` log — §9.1's
 * append-only trigger — because it is an entity with a note the operator will
 * legitimately want to extend, but the `dayKey` is fixed at write time for the
 * same reason every other day-keyed row is: so it can be joined against
 * everything else that happened that day.
 */
export const interaction = pgTable(
  'interaction',
  {
    ...entityColumns,

    personId: reference()
      .notNull()
      .references(() => person.id),

    kind: interactionKind().notNull(),
    occurredAt: instant().notNull(),
    zone: ianaZone().notNull(),

    /**
     * Stored, not derived.
     *
     * `date_trunc` on a `timestamptz` is STABLE rather than IMMUTABLE, so it
     * cannot be indexed; and computing it on read in the *current* zone would
     * file a call made in London under the wrong day once the operator is
     * home. Same argument the Work tables record for task completion.
     */
    dayKey: text().notNull(),

    /** What the operator chose to write down. Never what was said. */
    note: text(),

    searchVector: searchVector('note'),
  },
  (t) => [
    index('interaction_person_idx').on(t.personId, t.occurredAt.desc()).where(sql`${t.deletedAt} IS NULL`),
    index('interaction_day_idx').on(t.dayKey).where(sql`${t.deletedAt} IS NULL`),
    index('interaction_search_idx').using('gin', t.searchVector),
  ],
);

/**
 * Somewhere the operator has been, or lives.
 *
 * Coordinates are optional and unindexed. There is no map, no geocoding and no
 * radius query; a place is a name and a country, and the latitude is there so
 * that a future map has something to read rather than because anything reads it
 * today. §5.5's position on speculative indexes applies — an index costs a
 * write on every insert forever in exchange for a query nobody has written.
 */
export const place = pgTable(
  'place',
  {
    ...entityColumns,

    name: text().notNull(),
    kind: placeKind().notNull(),

    /** ISO 3166-1 alpha-2, upper case. Two letters or nothing. */
    countryCode: text(),

    /**
     * The zone this place is in.
     *
     * The load-bearing column. §5.3 requires every instant carry the zone it
     * was captured in, and this is what makes a visit able to explain a run of
     * them — a fortnight of `Europe/London` observations is not a data quality
     * problem when there is a visit to London covering it.
     */
    zone: ianaZone(),

    latitude: text(),
    longitude: text(),

    notes: text(),

    searchVector: searchVector('name', 'notes'),
  },
  (t) => [
    uniqueIndex('place_name_unique').on(t.name).where(sql`${t.deletedAt} IS NULL`),
    index('place_kind_idx').on(t.kind, t.name).where(sql`${t.deletedAt} IS NULL`),
    index('place_search_idx').using('gin', t.searchVector),
    check('place_country_code', sql`${t.countryCode} IS NULL OR ${t.countryCode} ~ '^[A-Z]{2}$'`),
  ],
);

/**
 * A journey, which is a container for {@link visit}s rather than a location.
 *
 * Separate from `visit` because a fortnight covering three cities is one thing
 * the operator remembers and three things the timezone data shows. Collapsing
 * them would make "how many trips last year" unanswerable; splitting them
 * without a container would make it wrong.
 */
export const trip = pgTable(
  'trip',
  {
    ...entityColumns,

    title: text().notNull(),
    purpose: tripPurpose().notNull(),

    startedOn: text().notNull(),
    /** Null while it is happening. There is at most one of those. */
    endedOn: text(),

    notes: text(),

    searchVector: searchVector('title', 'notes'),
  },
  (t) => [
    index('trip_started_idx').on(t.startedOn.desc()).where(sql`${t.deletedAt} IS NULL`),
    index('trip_search_idx').using('gin', t.searchVector),
    check('trip_ordered', sql`${t.endedOn} IS NULL OR ${t.startedOn} <= ${t.endedOn}`),
  ],
);

/**
 * Time spent somewhere.
 *
 * Day-keyed rather than instant-keyed, and that is the interesting decision.
 * An arrival has a precise instant, but the question a visit answers — "where
 * was I on the 14th" — is a question about days, and a half-open instant range
 * would put the answer for a red-eye landing at 02:00 in the wrong place. The
 * range is inclusive of both ends because a one-day visit is `from = to`, which
 * a half-open range cannot express without an off-by-one nobody remembers.
 */
export const visit = pgTable(
  'visit',
  {
    ...entityColumns,

    placeId: reference()
      .notNull()
      .references(() => place.id),
    /** Null for a stay that is not part of a journey — which includes home. */
    tripId: reference().references(() => trip.id),

    arrivedOn: text().notNull(),
    /** Null while it is current. Home is the usual case. */
    departedOn: text(),

    notes: text(),
  },
  (t) => [
    index('visit_arrived_idx').on(t.arrivedOn.desc()).where(sql`${t.deletedAt} IS NULL`),
    index('visit_place_idx').on(t.placeId, t.arrivedOn.desc()).where(sql`${t.deletedAt} IS NULL`),
    index('visit_trip_idx').on(t.tripId).where(sql`${t.deletedAt} IS NULL`),
    check('visit_ordered', sql`${t.departedOn} IS NULL OR ${t.arrivedOn} <= ${t.departedOn}`),
  ],
);
