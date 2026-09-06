/**
 * People and Places, assembled — §3.2's `/life/people` and `/life/places`.
 *
 * Two boards, one module, because the composition each needs is four lines and
 * two files would be four lines each plus two headers.
 *
 * ## The status is computed here and stored nowhere
 *
 * `contactStatus` runs on every read. The alternative — a materialised
 * `is_overdue` column refreshed nightly — would be wrong for most of the day
 * after a contact is recorded, and the arithmetic is a subtraction over a
 * number the page already has. §5.6 reserves materialisation for aggregates
 * over millions of rows; this is forty subtractions.
 *
 * ## The travel window is thirty days and it is not a setting
 *
 * Long enough to contain the trip that explains a disrupted fortnight, short
 * enough that the figure describes now. It exists so the Places page can answer
 * "how much of the last month was I away", which is the number that makes the
 * page worth opening at all.
 */

import 'server-only';

import type { Result } from '@naitikos/shared';
import { ok } from '@naitikos/shared';
import type {
  ContactStatus,
  DomainError,
  Interaction,
  Person,
  Place,
  Trip,
  UpcomingBirthday,
  Visit,
  VisitOverlap,
} from '@naitikos/core';
import {
  BIRTHDAY_HORIZON_DAYS,
  contactStatus,
  dayKeyInZone,
  findOverlaps,
  isoFromMillis,
  orderByAttention,
  placeOnDay,
  systemClock,
  travelDays,
  upcomingBirthdays,
  windowDayKeys,
} from '@naitikos/core';
import type { PersonWithStatus } from '@naitikos/core';
import type { Database } from '@naitikos/db';
import { createSocialRepository } from '@naitikos/db';

/** How far back the Places page counts travel. */
export const TRAVEL_WINDOW_DAYS = 30;

export type PeopleBoard = {
  readonly todayDayKey: string;
  /** Attention first — overdue, then due, then the rest. */
  readonly people: readonly PersonWithStatus[];
  readonly birthdays: readonly UpcomingBirthday[];
  readonly birthdayHorizonDays: number;
  /** How many have a cadence set, so the page can say what it is measuring. */
  readonly tracked: number;
};

export async function loadPeople(db: Database, zone: string): Promise<Result<PeopleBoard, DomainError>> {
  const social = createSocialRepository(db);

  const rows = await social.people();
  if (!rows.ok) return rows;

  const todayDayKey = dayKeyInZone(isoFromMillis(systemClock.nowMillis()), zone);

  const withStatus: PersonWithStatus[] = rows.value.map((row) => {
    const person: Person = {
      id: row.id,
      name: row.name,
      relationship: row.relationship,
      context: row.context,
      birthday: row.birthday,
      cadenceDays: row.cadenceDays,
    };
    return {
      person,
      status: contactStatus(person, row.lastContactDayKey, todayDayKey),
      lastContactDayKey: row.lastContactDayKey,
    };
  });

  return ok({
    todayDayKey,
    people: orderByAttention(withStatus),
    birthdays: upcomingBirthdays(
      withStatus.map((entry) => entry.person),
      todayDayKey,
    ),
    birthdayHorizonDays: BIRTHDAY_HORIZON_DAYS,
    tracked: withStatus.filter((entry) => entry.person.cadenceDays !== null).length,
  });
}

export type PersonDetail = {
  readonly person: Person;
  readonly interactions: readonly Interaction[];
  readonly status: ContactStatus;
  readonly todayDayKey: string;
};

export type PlacesBoard = {
  readonly todayDayKey: string;
  readonly places: readonly Place[];
  readonly trips: readonly Trip[];
  readonly visits: readonly Visit[];
  /** Where the operator is now, or `null` when nothing covers today. */
  readonly currentVisit: Visit | null;
  /** Days in the last {@link TRAVEL_WINDOW_DAYS} spent somewhere that is not home. */
  readonly travelDayKeys: readonly string[];
  readonly windowDays: number;
  /**
   * Pairs of visits claiming the same day.
   *
   * Surfaced rather than prevented: the usual cause is a departure date left
   * blank, and the fix is on this page. P5 — the operator is always right, and
   * always able to correct the record.
   */
  readonly overlaps: readonly VisitOverlap[];
};

export async function loadPlaces(db: Database, zone: string): Promise<Result<PlacesBoard, DomainError>> {
  const social = createSocialRepository(db);

  const [places, trips, visits] = await Promise.all([social.places(), social.trips(), social.visits()]);
  if (!places.ok) return places;
  if (!trips.ok) return trips;
  if (!visits.ok) return visits;

  const todayDayKey = dayKeyInZone(isoFromMillis(systemClock.nowMillis()), zone);
  const placesById = new Map(places.value.map((entry) => [entry.id, entry]));

  return ok({
    todayDayKey,
    places: places.value,
    trips: trips.value,
    visits: [...visits.value].reverse(),
    currentVisit: placeOnDay(visits.value, todayDayKey),
    /*
     * `windowDayKeys` counts back from today, and `travelDays` returns only the
     * days a visit actually covers. A day with no record contributes nothing —
     * absence of a record is not evidence of a journey, and §8.9's rule against
     * inventing data applies to a count as much as to a chart.
     */
    travelDayKeys: travelDays(visits.value, placesById, windowDayKeys(todayDayKey, TRAVEL_WINDOW_DAYS)),
    windowDays: TRAVEL_WINDOW_DAYS,
    overlaps: findOverlaps(visits.value),
  });
}

export async function loadPerson(
  db: Database,
  zone: string,
  personId: string,
): Promise<Result<PersonDetail | null, DomainError>> {
  const social = createSocialRepository(db);

  const rows = await social.people();
  if (!rows.ok) return rows;

  const row = rows.value.find((entry) => entry.id === personId);
  if (row === undefined) return ok(null);

  const interactions = await social.interactions(personId);
  if (!interactions.ok) return interactions;

  const person: Person = {
    id: row.id,
    name: row.name,
    relationship: row.relationship,
    context: row.context,
    birthday: row.birthday,
    cadenceDays: row.cadenceDays,
  };
  const todayDayKey = dayKeyInZone(isoFromMillis(systemClock.nowMillis()), zone);

  return ok({
    person,
    interactions: interactions.value,
    status: contactStatus(person, row.lastContactDayKey, todayDayKey),
    todayDayKey,
  });
}
