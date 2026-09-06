/**
 * People and Places, persisted.
 *
 * Two aggregates in one repository because they share nothing but a section of
 * §3.2 and a page group, and splitting them would mean two files each holding
 * four soft-deleting CRUD methods. The interesting reads are the two below;
 * everything else is bookkeeping.
 *
 * ## The last contact is joined in SQL, not reduced in Node
 *
 * The list page needs, per person, the day of their most recent interaction.
 * Loading every interaction and reducing in JavaScript would work at forty
 * people and stop working at four hundred — and `interaction_person_idx` is
 * ordered `(person_id, occurred_at DESC)` precisely so a correlated `LATERAL`
 * with `limit 1` walks a single index entry per person.
 *
 * The status itself is computed in `core`, not here. §5.0 puts that judgement
 * below the database, and `contactStatus` is what a test can exercise without
 * Postgres.
 *
 * ## Soft delete throughout (§9.4)
 *
 * `person` in particular: interactions point at it, and a dangling interaction
 * is a record of contact with nobody. Purge remains the one path that actually
 * removes data, and it is the right one when the answer is "this person should
 * not be in my database at all".
 */

import { and, asc, desc, eq, isNull, lte, sql } from 'drizzle-orm';
import type { Result } from '@naitikos/shared';
import { ok } from '@naitikos/shared';
import type {
  DomainError,
  Interaction,
  InteractionInput,
  InteractionKind,
  Person,
  Place,
  PlaceKind,
  RelationshipKind,
  Trip,
  TripPurpose,
  Visit,
} from '@naitikos/core';
import { notFoundError } from '@naitikos/core';

import type { Database } from '../client';
import { interaction, person, place, trip, visit } from '../schema/social';

/** A person plus the day they were last in contact, which the list needs. */
export type PersonRow = Person & {
  readonly lastContactDayKey: string | null;
  readonly interactionCount: number;
};

function toPerson(row: typeof person.$inferSelect): Person {
  return {
    id: row.id,
    name: row.name,
    relationship: row.relationship as RelationshipKind,
    context: row.context,
    birthday: row.birthday,
    cadenceDays: row.cadenceDays,
  };
}

function toInteraction(row: typeof interaction.$inferSelect): Interaction {
  return {
    id: row.id,
    personId: row.personId,
    kind: row.kind as InteractionKind,
    occurredAt: row.occurredAt,
    zone: row.zone,
    dayKey: row.dayKey,
    note: row.note,
  };
}

function toPlace(row: typeof place.$inferSelect): Place {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as PlaceKind,
    countryCode: row.countryCode,
    zone: row.zone,
    latitude: row.latitude,
    longitude: row.longitude,
    notes: row.notes,
  };
}

function toTrip(row: typeof trip.$inferSelect): Trip {
  return {
    id: row.id,
    title: row.title,
    purpose: row.purpose as TripPurpose,
    startedOn: row.startedOn,
    endedOn: row.endedOn,
    notes: row.notes,
  };
}

function toVisit(row: typeof visit.$inferSelect): Visit {
  return {
    id: row.id,
    placeId: row.placeId,
    tripId: row.tripId,
    arrivedOn: row.arrivedOn,
    departedOn: row.departedOn,
    notes: row.notes,
  };
}

export type SocialRepository = {
  /* --- People ---------------------------------------------------------- */

  /** Everyone, with the day of their most recent contact. */
  people(): Promise<Result<readonly PersonRow[], DomainError>>;
  savePerson(input: Person): Promise<Result<Person, DomainError>>;
  deletePerson(id: string, reason: string | null, at: string): Promise<Result<void, DomainError>>;

  /** One person's contacts, newest first. */
  interactions(personId: string, limit?: number): Promise<Result<readonly Interaction[], DomainError>>;
  recordInteraction(input: InteractionInput): Promise<Result<Interaction, DomainError>>;
  deleteInteraction(id: string, reason: string | null, at: string): Promise<Result<void, DomainError>>;

  /* --- Places ---------------------------------------------------------- */

  places(): Promise<Result<readonly Place[], DomainError>>;
  savePlace(input: Place): Promise<Result<Place, DomainError>>;
  deletePlace(id: string, reason: string | null, at: string): Promise<Result<void, DomainError>>;

  trips(): Promise<Result<readonly Trip[], DomainError>>;
  saveTrip(input: Trip): Promise<Result<Trip, DomainError>>;
  deleteTrip(id: string, reason: string | null, at: string): Promise<Result<void, DomainError>>;

  /** Every visit, oldest first — the order `resolveVisits` expects to be given. */
  visits(): Promise<Result<readonly Visit[], DomainError>>;
  /** Visits overlapping a day range, for the timeline and for travel days. */
  visitsBetween(fromDayKey: string, toDayKey: string): Promise<Result<readonly Visit[], DomainError>>;
  saveVisit(input: Visit): Promise<Result<Visit, DomainError>>;
  deleteVisit(id: string, reason: string | null, at: string): Promise<Result<void, DomainError>>;
};

export function createSocialRepository(db: Database): SocialRepository {
  return {
    async people() {
      /*
       * One lateral per person rather than a `GROUP BY` over the join.
       *
       * The index is `(person_id, occurred_at DESC)` filtered on live rows, so
       * the `limit 1` walks a single index entry. Aggregating the join would
       * read every interaction ever recorded in order to answer a question
       * about the most recent one — fine at forty rows, and the wrong shape to
       * leave in place for twenty years.
       *
       * Raw rather than composed through the query builder because a `LATERAL`
       * correlated on the outer table is not something Drizzle's `leftJoin`
       * expresses; writing it as SQL is honest about what it is.
       */
      const rows = await db.execute(sql`
        select p.id,
               p.name,
               p.relationship,
               p.context,
               p.birthday,
               p.cadence_days,
               latest.day_key as last_contact_day_key,
               counts.total as interaction_count
          from person p
          left join lateral (
            select i.day_key
              from interaction i
             where i.person_id = p.id and i.deleted_at is null
             order by i.occurred_at desc
             limit 1
          ) latest on true
          left join lateral (
            select count(*)::int as total
              from interaction i
             where i.person_id = p.id and i.deleted_at is null
          ) counts on true
         where p.deleted_at is null
         order by p.name asc
      `);

      const typed = rows as unknown as readonly {
        id: string;
        name: string;
        relationship: string;
        context: string | null;
        birthday: string | null;
        cadence_days: number | null;
        last_contact_day_key: string | null;
        interaction_count: number | null;
      }[];

      return ok(
        typed.map((row) => ({
          id: row.id,
          name: row.name,
          relationship: row.relationship as RelationshipKind,
          context: row.context,
          birthday: row.birthday,
          cadenceDays: row.cadence_days,
          lastContactDayKey: row.last_contact_day_key,
          interactionCount: Number(row.interaction_count ?? 0),
        })),
      );
    },

    async savePerson(input) {
      const rows = await db
        .insert(person)
        .values({
          id: input.id,
          name: input.name,
          relationship: input.relationship,
          context: input.context,
          birthday: input.birthday,
          cadenceDays: input.cadenceDays,
        })
        .onConflictDoUpdate({
          target: person.id,
          set: {
            name: input.name,
            relationship: input.relationship,
            context: input.context,
            birthday: input.birthday,
            cadenceDays: input.cadenceDays,
            updatedAt: sql`now()`,
            version: sql`${person.version} + 1`,
          },
        })
        .returning();

      const row = rows[0];
      if (row === undefined) return { ok: false, error: notFoundError('person', input.id) };
      return ok(toPerson(row));
    },

    async deletePerson(id, reason, at) {
      const rows = await db
        .update(person)
        .set({ deletedAt: at, deleteReason: reason, updatedAt: at })
        .where(and(eq(person.id, id), isNull(person.deletedAt)))
        .returning({ id: person.id });

      if (rows[0] === undefined) return { ok: false, error: notFoundError('person', id) };
      return ok(undefined);
    },

    async interactions(personId, limit = 100) {
      const rows = await db
        .select()
        .from(interaction)
        .where(and(eq(interaction.personId, personId), isNull(interaction.deletedAt)))
        .orderBy(desc(interaction.occurredAt))
        .limit(limit);

      return ok(rows.map(toInteraction));
    },

    async recordInteraction(input) {
      const rows = await db
        .insert(interaction)
        .values({
          id: input.id,
          personId: input.personId,
          kind: input.kind,
          occurredAt: input.occurredAt,
          zone: input.zone,
          dayKey: input.dayKey,
          note: input.note ?? null,
        })
        .onConflictDoUpdate({
          target: interaction.id,
          set: {
            kind: input.kind,
            occurredAt: input.occurredAt,
            zone: input.zone,
            dayKey: input.dayKey,
            note: input.note ?? null,
            updatedAt: sql`now()`,
            version: sql`${interaction.version} + 1`,
          },
        })
        .returning();

      const row = rows[0];
      if (row === undefined) return { ok: false, error: notFoundError('interaction', input.id) };
      return ok(toInteraction(row));
    },

    async deleteInteraction(id, reason, at) {
      const rows = await db
        .update(interaction)
        .set({ deletedAt: at, deleteReason: reason, updatedAt: at })
        .where(and(eq(interaction.id, id), isNull(interaction.deletedAt)))
        .returning({ id: interaction.id });

      if (rows[0] === undefined) return { ok: false, error: notFoundError('interaction', id) };
      return ok(undefined);
    },

    async places() {
      const rows = await db.select().from(place).where(isNull(place.deletedAt)).orderBy(asc(place.name));
      return ok(rows.map(toPlace));
    },

    async savePlace(input) {
      const rows = await db
        .insert(place)
        .values({
          id: input.id,
          name: input.name,
          kind: input.kind,
          countryCode: input.countryCode,
          zone: input.zone,
          latitude: input.latitude,
          longitude: input.longitude,
          notes: input.notes,
        })
        .onConflictDoUpdate({
          target: place.id,
          set: {
            name: input.name,
            kind: input.kind,
            countryCode: input.countryCode,
            zone: input.zone,
            latitude: input.latitude,
            longitude: input.longitude,
            notes: input.notes,
            updatedAt: sql`now()`,
            version: sql`${place.version} + 1`,
          },
        })
        .returning();

      const row = rows[0];
      if (row === undefined) return { ok: false, error: notFoundError('place', input.id) };
      return ok(toPlace(row));
    },

    async deletePlace(id, reason, at) {
      const rows = await db
        .update(place)
        .set({ deletedAt: at, deleteReason: reason, updatedAt: at })
        .where(and(eq(place.id, id), isNull(place.deletedAt)))
        .returning({ id: place.id });

      if (rows[0] === undefined) return { ok: false, error: notFoundError('place', id) };
      return ok(undefined);
    },

    async trips() {
      const rows = await db.select().from(trip).where(isNull(trip.deletedAt)).orderBy(desc(trip.startedOn));
      return ok(rows.map(toTrip));
    },

    async saveTrip(input) {
      const rows = await db
        .insert(trip)
        .values({
          id: input.id,
          title: input.title,
          purpose: input.purpose,
          startedOn: input.startedOn,
          endedOn: input.endedOn,
          notes: input.notes,
        })
        .onConflictDoUpdate({
          target: trip.id,
          set: {
            title: input.title,
            purpose: input.purpose,
            startedOn: input.startedOn,
            endedOn: input.endedOn,
            notes: input.notes,
            updatedAt: sql`now()`,
            version: sql`${trip.version} + 1`,
          },
        })
        .returning();

      const row = rows[0];
      if (row === undefined) return { ok: false, error: notFoundError('trip', input.id) };
      return ok(toTrip(row));
    },

    async deleteTrip(id, reason, at) {
      const rows = await db
        .update(trip)
        .set({ deletedAt: at, deleteReason: reason, updatedAt: at })
        .where(and(eq(trip.id, id), isNull(trip.deletedAt)))
        .returning({ id: trip.id });

      if (rows[0] === undefined) return { ok: false, error: notFoundError('trip', id) };
      return ok(undefined);
    },

    async visits() {
      const rows = await db.select().from(visit).where(isNull(visit.deletedAt)).orderBy(asc(visit.arrivedOn));
      return ok(rows.map(toVisit));
    },

    async visitsBetween(fromDayKey, toDayKey) {
      /*
       * Overlap, not containment. A visit that started before the window and
       * ends inside it is the interesting one — it is the trip that explains
       * the first week of whatever is being looked at — and a filter on
       * `arrived_on` alone would miss exactly that case.
       *
       * An open-ended visit has no `departed_on` to compare, so it qualifies on
       * arrival alone. `resolveVisits` in `core` is what closes it against the
       * next arrival; the database's job here is to return enough rows for that
       * to be possible.
       */
      const rows = await db
        .select()
        .from(visit)
        .where(
          and(
            isNull(visit.deletedAt),
            lte(visit.arrivedOn, toDayKey),
            sql`(${visit.departedOn} is null or ${visit.departedOn} >= ${fromDayKey})`,
          ),
        )
        .orderBy(asc(visit.arrivedOn));

      return ok(rows.map(toVisit));
    },

    async saveVisit(input) {
      const rows = await db
        .insert(visit)
        .values({
          id: input.id,
          placeId: input.placeId,
          tripId: input.tripId,
          arrivedOn: input.arrivedOn,
          departedOn: input.departedOn,
          notes: input.notes,
        })
        .onConflictDoUpdate({
          target: visit.id,
          set: {
            placeId: input.placeId,
            tripId: input.tripId,
            arrivedOn: input.arrivedOn,
            departedOn: input.departedOn,
            notes: input.notes,
            updatedAt: sql`now()`,
            version: sql`${visit.version} + 1`,
          },
        })
        .returning();

      const row = rows[0];
      if (row === undefined) return { ok: false, error: notFoundError('visit', input.id) };
      return ok(toVisit(row));
    },

    async deleteVisit(id, reason, at) {
      const rows = await db
        .update(visit)
        .set({ deletedAt: at, deleteReason: reason, updatedAt: at })
        .where(and(eq(visit.id, id), isNull(visit.deletedAt)))
        .returning({ id: visit.id });

      if (rows[0] === undefined) return { ok: false, error: notFoundError('visit', id) };
      return ok(undefined);
    },
  };
}
