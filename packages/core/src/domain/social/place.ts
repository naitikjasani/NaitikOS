/**
 * Places, trips and visits — §3.2's `/life/places`.
 *
 * ## The reason this is not a travel diary
 *
 * §10.6's detectors watch for changes in series. A fortnight abroad moves sleep
 * midpoint, weight, skin state, training volume and step count simultaneously,
 * for reasons that have nothing to do with anything the system is measuring —
 * and the detectors have no way to know that unless it is written down.
 *
 * §5.3 already insists on the point one row at a time: "A workout at '7am'
 * during travel is a materially different fact from one at 7am at home." A
 * {@link Visit} is that same fact at the scale of a fortnight, and
 * {@link travelDays} is what an insight can consult before reporting a
 * disruption as a finding.
 *
 * ## Days, not instants
 *
 * Every boundary here is a day key. An arrival has a precise moment, but the
 * question is "where was I on the 14th", and an instant range puts a red-eye
 * landing at 02:00 on the wrong side of it. Both ends are inclusive, because a
 * one-day visit is `arrivedOn === departedOn` and a half-open range cannot say
 * that without an off-by-one nobody remembers a year later.
 *
 * ## Overlaps are allowed, and reported
 *
 * A person is in one place at a time, so two overlapping visits are a mistake.
 * They are not *rejected*, because the mistake is usually a departure date the
 * operator has not got round to filling in, and refusing the write would make
 * the fix impossible from the page that shows the problem. {@link findOverlaps}
 * surfaces them instead — P5's "the operator is always right, and always able
 * to correct the record".
 */

import type { Result } from '@naitikos/shared';
import { err, ok } from '@naitikos/shared';

import type { DomainError } from '../../errors/domain-error';
import { validationError } from '../../errors/domain-error';
import { dayKeyIndex } from '../../temporal/instant';
import { isIanaZone } from '../../temporal/zone';

/** Mirrors the `place_kind` pgEnum exactly. */
export const PLACE_KINDS = Object.freeze(['home', 'city', 'country', 'venue', 'workplace', 'other'] as const);

export type PlaceKind = (typeof PLACE_KINDS)[number];

export const PLACE_LABELS: Readonly<Record<PlaceKind, string>> = Object.freeze({
  home: 'Home',
  city: 'City',
  country: 'Country',
  venue: 'Venue',
  workplace: 'Workplace',
  other: 'Other',
});

/** Mirrors the `trip_purpose` pgEnum exactly. */
export const TRIP_PURPOSES = Object.freeze(['leisure', 'work', 'family', 'medical', 'other'] as const);

export type TripPurpose = (typeof TRIP_PURPOSES)[number];

export const TRIP_PURPOSE_LABELS: Readonly<Record<TripPurpose, string>> = Object.freeze({
  leisure: 'Leisure',
  work: 'Work',
  family: 'Family',
  medical: 'Medical',
  other: 'Other',
});

export function isPlaceKind(value: string): value is PlaceKind {
  return (PLACE_KINDS as readonly string[]).includes(value);
}

export function isTripPurpose(value: string): value is TripPurpose {
  return (TRIP_PURPOSES as readonly string[]).includes(value);
}

export type Place = {
  readonly id: string;
  readonly name: string;
  readonly kind: PlaceKind;
  readonly countryCode: string | null;
  readonly zone: string | null;
  readonly latitude: string | null;
  readonly longitude: string | null;
  readonly notes: string | null;
};

export type PlaceInput = {
  readonly id: string;
  readonly name: string;
  readonly kind: PlaceKind;
  readonly countryCode?: string | null;
  readonly zone?: string | null;
  readonly latitude?: string | null;
  readonly longitude?: string | null;
  readonly notes?: string | null;
};

export type Trip = {
  readonly id: string;
  readonly title: string;
  readonly purpose: TripPurpose;
  readonly startedOn: string;
  readonly endedOn: string | null;
  readonly notes: string | null;
};

export type TripInput = {
  readonly id: string;
  readonly title: string;
  readonly purpose: TripPurpose;
  readonly startedOn: string;
  readonly endedOn?: string | null;
  readonly notes?: string | null;
};

export type Visit = {
  readonly id: string;
  readonly placeId: string;
  readonly tripId: string | null;
  readonly arrivedOn: string;
  readonly departedOn: string | null;
  readonly notes: string | null;
};

export type VisitInput = {
  readonly id: string;
  readonly placeId: string;
  readonly tripId?: string | null;
  readonly arrivedOn: string;
  readonly departedOn?: string | null;
  readonly notes?: string | null;
};

const NAME_MAX = 120;
const TITLE_MAX = 200;
const NOTES_MAX = 2000;

/** Two upper-case letters. Mirrored by a CHECK on the column. */
const COUNTRY_CODE = /^[A-Z]{2}$/;
/** A decimal with an optional sign. Stored as text, never as a float (§5.3). */
const DECIMAL = /^-?\d{1,3}(\.\d{1,8})?$/;

export function validatePlace(input: PlaceInput): Result<Place, DomainError> {
  const name = input.name.trim();
  if (name === '') return err(validationError('name', 'A place needs a name.'));
  if (name.length > NAME_MAX) {
    return err(validationError('name', `A name is at most ${String(NAME_MAX)} characters.`));
  }

  const country = input.countryCode?.trim().toUpperCase() ?? '';
  if (country !== '' && !COUNTRY_CODE.test(country)) {
    return err(validationError('countryCode', 'A country code is two letters, like IN or GB.'));
  }

  const zone = input.zone?.trim() ?? '';
  if (zone !== '' && !isIanaZone(zone)) {
    /*
     * Checked here rather than only at the wire. This zone is what lets a visit
     * explain a run of foreign observation offsets; a typo would leave the
     * explanation silently unable to match, which is a bug that looks like
     * missing data.
     */
    return err(validationError('zone', `${zone} is not a time zone this system recognises.`));
  }

  const latitude = input.latitude?.trim() ?? '';
  const longitude = input.longitude?.trim() ?? '';
  if (latitude !== '' && (!DECIMAL.test(latitude) || Math.abs(Number(latitude)) > 90)) {
    return err(validationError('latitude', 'A latitude is between -90 and 90.'));
  }
  if (longitude !== '' && (!DECIMAL.test(longitude) || Math.abs(Number(longitude)) > 180)) {
    return err(validationError('longitude', 'A longitude is between -180 and 180.'));
  }
  /* One coordinate is not a location, and half a pin on a future map is worse
   * than none — it would render somewhere real and wrong. */
  if ((latitude === '') !== (longitude === '')) {
    return err(validationError('latitude', 'Give both coordinates or neither.'));
  }

  const notes = input.notes?.trim() ?? '';
  if (notes.length > NOTES_MAX) {
    return err(validationError('notes', `Keep the notes under ${String(NOTES_MAX)} characters.`));
  }

  return ok({
    id: input.id,
    name,
    kind: input.kind,
    countryCode: country === '' ? null : country,
    zone: zone === '' ? null : zone,
    latitude: latitude === '' ? null : latitude,
    longitude: longitude === '' ? null : longitude,
    notes: notes === '' ? null : notes,
  });
}

export function validateTrip(input: TripInput): Result<Trip, DomainError> {
  const title = input.title.trim();
  if (title === '') return err(validationError('title', 'A trip needs a name — where, or why.'));
  if (title.length > TITLE_MAX) {
    return err(validationError('title', `A trip name is at most ${String(TITLE_MAX)} characters.`));
  }

  const start = dayKeyIndex(input.startedOn);
  if (start === null) return err(validationError('startedOn', 'The start date could not be read.'));

  const endedOn = input.endedOn ?? null;
  if (endedOn !== null) {
    const end = dayKeyIndex(endedOn);
    if (end === null) return err(validationError('endedOn', 'The end date could not be read.'));
    if (end < start) {
      return err(validationError('endedOn', 'A trip cannot end before it starts.'));
    }
  }

  const notes = input.notes?.trim() ?? '';
  if (notes.length > NOTES_MAX) {
    return err(validationError('notes', `Keep the notes under ${String(NOTES_MAX)} characters.`));
  }

  return {
    ok: true,
    value: {
      id: input.id,
      title,
      purpose: input.purpose,
      startedOn: input.startedOn,
      endedOn,
      notes: notes === '' ? null : notes,
    },
  };
}

export function validateVisit(input: VisitInput): Result<Visit, DomainError> {
  const arrived = dayKeyIndex(input.arrivedOn);
  if (arrived === null) return err(validationError('arrivedOn', 'The arrival date could not be read.'));

  const departedOn = input.departedOn ?? null;
  if (departedOn !== null) {
    const departed = dayKeyIndex(departedOn);
    if (departed === null) return err(validationError('departedOn', 'The departure date could not be read.'));
    if (departed < arrived) {
      return err(validationError('departedOn', 'A visit cannot end before it starts.'));
    }
  }

  const notes = input.notes?.trim() ?? '';
  if (notes.length > NOTES_MAX) {
    return err(validationError('notes', `Keep the notes under ${String(NOTES_MAX)} characters.`));
  }

  return ok({
    id: input.id,
    placeId: input.placeId,
    tripId: input.tripId ?? null,
    arrivedOn: input.arrivedOn,
    departedOn,
    notes: notes === '' ? null : notes,
  });
}

/* =========================================================================
 * Reading the record
 * ====================================================================== */

/**
 * A visit with its *effective* end resolved.
 *
 * An open-ended visit means "still there", and the usual open-ended visit is
 * home. Taken literally, that makes home overlap every trip ever recorded —
 * which would fill {@link findOverlaps} with the one arrangement that is not a
 * mistake, and an overlap list that is mostly noise is an overlap list nobody
 * reads.
 *
 * So an open-ended visit is **implicitly closed by the next arrival**. That is
 * not a workaround; it is how people actually keep this record. Home is where
 * you are when you are not somewhere else, and nobody types a departure date
 * for their own house before a weekend away.
 */
export type ResolvedVisit = {
  readonly visit: Visit;
  readonly from: string;
  /** Inclusive. `null` only for the visit that is genuinely current. */
  readonly to: string | null;
};

/**
 * Sort by arrival and close each open-ended visit at the next arrival.
 *
 * The handover day belongs to both — you departed and arrived on it — which is
 * why the effective end is the next arrival rather than the day before it.
 * {@link placeOnDay} resolves the tie in favour of the arrival, since that is
 * where the night was spent.
 */
export function resolveVisits(visits: readonly Visit[]): readonly ResolvedVisit[] {
  const sorted = [...visits].sort(
    (left, right) => left.arrivedOn.localeCompare(right.arrivedOn) || left.id.localeCompare(right.id),
  );

  return sorted.map((visit, index) => {
    if (visit.departedOn !== null) return { visit, from: visit.arrivedOn, to: visit.departedOn };
    const next = sorted[index + 1];
    return { visit, from: visit.arrivedOn, to: next === undefined ? null : next.arrivedOn };
  });
}

/** Whether a resolved visit covers a day. Both ends inclusive. */
export function resolvedCovers(resolved: ResolvedVisit, dayKey: string): boolean {
  if (dayKey < resolved.from) return false;
  return resolved.to === null || dayKey <= resolved.to;
}

/**
 * Whether a visit covers a day, read on its own.
 *
 * Takes the stored dates literally, so an open-ended visit runs forever. Use
 * {@link placeOnDay} for the question "where was I", which resolves open ends
 * against the visits around them; this is the raw predicate, and it is exported
 * because a page showing one visit has no list to resolve against.
 */
export function visitCovers(visit: Visit, dayKey: string): boolean {
  const day = dayKeyIndex(dayKey);
  const arrived = dayKeyIndex(visit.arrivedOn);
  if (day === null || arrived === null || day < arrived) return false;

  if (visit.departedOn === null) return true;
  const departed = dayKeyIndex(visit.departedOn);
  return departed !== null && day <= departed;
}

/**
 * Where the operator was on a day, or `null` if nothing says.
 *
 * The *last* matching visit in arrival order wins, which resolves the handover
 * day in favour of the place arrived at — the night was spent there. It also
 * quietly resolves a genuine overlap, and that is a tie-break rather than an
 * answer: {@link findOverlaps} is what reports the problem.
 */
export function placeOnDay(visits: readonly Visit[], dayKey: string): Visit | null {
  let found: Visit | null = null;
  for (const resolved of resolveVisits(visits)) {
    if (resolvedCovers(resolved, dayKey)) found = resolved.visit;
  }
  return found;
}

/**
 * Day keys within the given window spent away from home.
 *
 * "Away" means covered by a visit to a place that is not of kind `home`. A day
 * covered by nothing is *not* counted as travel — absence of a record is not
 * evidence of a journey, and §8.9's rule against inventing data applies as much
 * to a count as to a chart.
 *
 * This is the function an insight consults before reporting a fortnight of
 * disrupted sleep as a finding. It returns the days rather than a count so the
 * caller can intersect them with whatever window it is looking at.
 */
export function travelDays(
  visits: readonly Visit[],
  placesById: ReadonlyMap<string, Place>,
  dayKeys: readonly string[],
): readonly string[] {
  const resolved = resolveVisits(visits);
  const away: string[] = [];

  for (const dayKey of dayKeys) {
    let current: Visit | null = null;
    for (const entry of resolved) {
      if (resolvedCovers(entry, dayKey)) current = entry.visit;
    }
    if (current === null) continue;

    const place = placesById.get(current.placeId);
    if (place !== undefined && place.kind !== 'home') away.push(dayKey);
  }

  return away;
}

export type VisitOverlap = {
  readonly earlier: Visit;
  readonly later: Visit;
};

/**
 * Pairs of visits that claim the same day, once open ends are resolved.
 *
 * A person is in one place at a time, so any pair here is a mistake — nearly
 * always a departure date typed later than it should have been. Reported rather
 * than rejected: the fix is editing one of the two rows, and a write that
 * refused the newer one would make that impossible from the page showing the
 * problem. P5, "the operator is always right, and always able to correct the
 * record".
 *
 * Touching is not overlapping. Departing and arriving on the same day is a
 * travel day, and it is how every journey with a connection looks.
 *
 * Quadratic in the worst case, with an early break that makes the common case —
 * no overlaps — linear. The sweep over sorted intervals is the right algorithm
 * for a hundred thousand rows and the wrong one for the forty a person
 * accumulates in a decade (§5.5).
 */
export function findOverlaps(visits: readonly Visit[]): readonly VisitOverlap[] {
  const resolved = resolveVisits(visits);
  const overlaps: VisitOverlap[] = [];

  for (let outer = 0; outer < resolved.length; outer += 1) {
    const earlier = resolved[outer];
    if (earlier === undefined) continue;

    for (let inner = outer + 1; inner < resolved.length; inner += 1) {
      const later = resolved[inner];
      if (later === undefined) continue;

      /* Sorted by arrival, so once one starts after this ends, all do. */
      if (earlier.to !== null && later.from > earlier.to) break;
      /* Strict, so a shared handover day is not an overlap. */
      if (earlier.to !== null && later.from === earlier.to) continue;

      overlaps.push({ earlier: earlier.visit, later: later.visit });
    }
  }

  return overlaps;
}

/** Nights away, counted as days between arrival and departure. Open-ended is null. */
export function nightsAway(visit: Visit): number | null {
  if (visit.departedOn === null) return null;
  const arrived = dayKeyIndex(visit.arrivedOn);
  const departed = dayKeyIndex(visit.departedOn);
  if (arrived === null || departed === null) return null;
  return departed - arrived;
}
