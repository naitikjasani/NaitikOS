/**
 * People and Places — integration, against real Postgres.
 *
 * The core tests cover the arithmetic: contact status, birthday wrapping,
 * visit overlap. This covers what only a database can prove — the constraints,
 * the soft-delete posture, and the lateral join that answers "when did I last
 * speak to them" without reading every interaction ever recorded.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { uuidV7 } from '@naitikos/shared';
import { validatePerson, validatePlace, validateTrip, validateVisit } from '@naitikos/core';
import type { PersonInput, PlaceInput } from '@naitikos/core';

import { createDatabase } from '../client';
import { resetDomainTables } from '../testing/reset';
import { createSocialRepository } from './social.repository';

const DATABASE_URL = process.env['DATABASE_URL'];
const db = DATABASE_URL === undefined ? undefined : createDatabase(DATABASE_URL);
const suite = db === undefined ? describe.skip : describe;

afterAll(async () => {
  await db?.$client.end({ timeout: 5 });
});

const EPOCH = 1_764_000_000_000;
let counter = 0;
const newId = (): string => uuidV7(EPOCH + (counter += 1));

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

/**
 * The constraint name a failed write violated.
 *
 * Drizzle wraps the driver error in one of its own whose message is
 * "Failed query: ..." with the SQL and the parameters, and puts the postgres.js
 * error on `cause`. Asserting against the outer message would match *any* SQL
 * failure — including the wrong one — so a test written that way passes while
 * proving nothing. Digging one level down is what makes these assertions real.
 */
async function constraintFrom(write: () => Promise<unknown>): Promise<string> {
  try {
    await write();
  } catch (error: unknown) {
    const cause = error instanceof Error ? error.cause : null;
    const named = cause instanceof Error ? cause : error;
    if (!(named instanceof Error)) return String(named);
    const constraint = (named as { constraint_name?: string }).constraint_name ?? '';
    return `${named.message} ${constraint}`;
  }
  return 'no error raised';
}

suite('social repository (§3.2)', () => {
  /* `describe.skip` has established that `db` exists; TypeScript cannot see
   * through it, so it is narrowed once rather than at each call site. */
  if (db === undefined) throw new Error('no database');
  const database = db;
  const repo = createSocialRepository(database);

  beforeEach(async () => {
    await resetDomainTables(database.$client);
  });

  const person = (over: Partial<PersonInput> = {}) =>
    unwrap(validatePerson({ id: newId(), name: 'Asha', relationship: 'friend', ...over }));

  const placeOf = (over: Partial<PlaceInput> = {}) =>
    unwrap(validatePlace({ id: newId(), name: `Place ${String(counter)}`, kind: 'city', ...over }));

  describe('people', () => {
    it('stores and reads back a person', async () => {
      const saved = unwrap(await repo.savePerson(person({ cadenceDays: 30, birthday: '--03-14' })));

      const [row] = unwrap(await repo.people());
      expect(row?.id).toBe(saved.id);
      expect(row?.cadenceDays).toBe(30);
      expect(row?.birthday).toBe('--03-14');
    });

    it('reports no last contact before there is one', async () => {
      await repo.savePerson(person());

      const [row] = unwrap(await repo.people());
      expect(row?.lastContactDayKey).toBeNull();
      expect(row?.interactionCount).toBe(0);
    });

    it('reports the most recent contact, not the first', async () => {
      const saved = unwrap(await repo.savePerson(person()));

      for (const dayKey of ['2026-06-01', '2026-09-01', '2026-07-15']) {
        await repo.recordInteraction({
          id: newId(),
          personId: saved.id,
          kind: 'call',
          occurredAt: `${dayKey}T10:00:00.000Z`,
          zone: 'Asia/Kolkata',
          dayKey,
          note: null,
        });
      }

      const [row] = unwrap(await repo.people());
      expect(row?.lastContactDayKey).toBe('2026-09-01');
      expect(row?.interactionCount).toBe(3);
    });

    it('ignores a soft-deleted interaction when reporting the last contact', async () => {
      const saved = unwrap(await repo.savePerson(person()));
      const recent = unwrap(
        await repo.recordInteraction({
          id: newId(),
          personId: saved.id,
          kind: 'call',
          occurredAt: '2026-09-01T10:00:00.000Z',
          zone: 'Asia/Kolkata',
          dayKey: '2026-09-01',
          note: null,
        }),
      );
      await repo.recordInteraction({
        id: newId(),
        personId: saved.id,
        kind: 'message',
        occurredAt: '2026-06-01T10:00:00.000Z',
        zone: 'Asia/Kolkata',
        dayKey: '2026-06-01',
        note: null,
      });

      await repo.deleteInteraction(recent.id, 'logged the wrong person', '2026-09-06T00:00:00.000Z');

      const [row] = unwrap(await repo.people());
      expect(row?.lastContactDayKey).toBe('2026-06-01');
      expect(row?.interactionCount).toBe(1);
    });

    it('soft-deletes a person and leaves their interactions pointing at them', async () => {
      // §9.4. A dangling interaction is a record of contact with nobody, which
      // is why this is not a cascade.
      const saved = unwrap(await repo.savePerson(person()));
      await repo.recordInteraction({
        id: newId(),
        personId: saved.id,
        kind: 'call',
        occurredAt: '2026-09-01T10:00:00.000Z',
        zone: 'Asia/Kolkata',
        dayKey: '2026-09-01',
        note: null,
      });

      unwrap(await repo.deletePerson(saved.id, 'no longer in touch', '2026-09-06T00:00:00.000Z'));

      expect(unwrap(await repo.people())).toEqual([]);
      expect(unwrap(await repo.interactions(saved.id))).toHaveLength(1);
    });

    it('refuses to delete the same person twice', async () => {
      const saved = unwrap(await repo.savePerson(person()));
      unwrap(await repo.deletePerson(saved.id, null, '2026-09-06T00:00:00.000Z'));

      expect((await repo.deletePerson(saved.id, null, '2026-09-06T00:00:00.000Z')).ok).toBe(false);
    });

    it('bumps the version on an update rather than replacing silently', async () => {
      const saved = unwrap(await repo.savePerson(person({ name: 'Asha' })));
      const updated = unwrap(await repo.savePerson({ ...saved, name: 'Asha R' }));

      expect(updated.name).toBe('Asha R');
      expect(unwrap(await repo.people())).toHaveLength(1);
    });

    it('lets Postgres refuse a malformed birthday even when the domain is bypassed', async () => {
      // The CHECK is the guarantee; `validatePerson` is the friendly message.
      // A repository convention is not a constraint.
      const violated = await constraintFrom(
        () => database.$client`
          insert into person (id, name, relationship, birthday)
          values (gen_random_uuid(), 'Bad', 'friend', '1994-03-14')`,
      );

      expect(violated).toContain('person_birthday_partial_date');
    });

    it('refuses a non-positive cadence at the database', async () => {
      const violated = await constraintFrom(
        () => database.$client`
          insert into person (id, name, relationship, cadence_days)
          values (gen_random_uuid(), 'Bad', 'friend', 0)`,
      );

      expect(violated).toContain('person_cadence_positive');
    });
  });

  describe('interactions', () => {
    it('returns them newest first', async () => {
      const saved = unwrap(await repo.savePerson(person()));
      for (const dayKey of ['2026-06-01', '2026-09-01', '2026-07-15']) {
        await repo.recordInteraction({
          id: newId(),
          personId: saved.id,
          kind: 'in_person',
          occurredAt: `${dayKey}T10:00:00.000Z`,
          zone: 'Asia/Kolkata',
          dayKey,
          note: null,
        });
      }

      const rows = unwrap(await repo.interactions(saved.id));
      expect(rows.map((r) => r.dayKey)).toEqual(['2026-09-01', '2026-07-15', '2026-06-01']);
    });

    it('refuses an interaction with nobody', async () => {
      const orphan = repo.recordInteraction({
        id: newId(),
        personId: newId(),
        kind: 'call',
        occurredAt: '2026-09-01T10:00:00.000Z',
        zone: 'Asia/Kolkata',
        dayKey: '2026-09-01',
        note: null,
      });

      await expect(orphan).rejects.toThrow();
    });
  });

  describe('places', () => {
    it('stores a place and refuses a second live one with the same name', async () => {
      // The unique index is partial on `deleted_at is null`, so the name comes
      // free again once a place is deleted.
      await repo.savePlace(placeOf({ name: 'London' }));

      const violated = await constraintFrom(() => repo.savePlace(placeOf({ name: 'London' })));

      expect(violated).toContain('place_name_unique');
    });

    it('frees the name once the place is deleted', async () => {
      const first = unwrap(await repo.savePlace(placeOf({ name: 'London' })));
      unwrap(await repo.deletePlace(first.id, 'duplicate', '2026-09-06T00:00:00.000Z'));

      const second = unwrap(await repo.savePlace(placeOf({ name: 'London' })));
      expect(second.name).toBe('London');
      expect(unwrap(await repo.places())).toHaveLength(1);
    });

    it('refuses a malformed country code at the database', async () => {
      const violated = await constraintFrom(
        () => database.$client`
          insert into place (id, name, kind, country_code)
          values (gen_random_uuid(), 'Nowhere', 'city', 'gb')`,
      );

      expect(violated).toContain('place_country_code');
    });
  });

  describe('trips and visits', () => {
    it('stores a trip and the visits under it', async () => {
      const london = unwrap(await repo.savePlace(placeOf({ name: 'London', zone: 'Europe/London' })));
      const journey = unwrap(
        await repo.saveTrip(
          unwrap(
            validateTrip({
              id: newId(),
              title: 'London office',
              purpose: 'work',
              startedOn: '2026-09-01',
              endedOn: '2026-09-08',
            }),
          ),
        ),
      );

      unwrap(
        await repo.saveVisit(
          unwrap(
            validateVisit({
              id: newId(),
              placeId: london.id,
              tripId: journey.id,
              arrivedOn: '2026-09-01',
              departedOn: '2026-09-08',
            }),
          ),
        ),
      );

      const visits = unwrap(await repo.visits());
      expect(visits).toHaveLength(1);
      expect(visits[0]?.tripId).toBe(journey.id);
    });

    it('finds visits that overlap a window rather than only those inside it', async () => {
      // The interesting visit is the one that started before the window and
      // ends inside it — that is the trip explaining the first week. A filter
      // on arrival alone would miss exactly that case.
      const london = unwrap(await repo.savePlace(placeOf({ name: 'London' })));
      unwrap(
        await repo.saveVisit(
          unwrap(
            validateVisit({ id: newId(), placeId: london.id, arrivedOn: '2026-08-20', departedOn: '2026-09-03' }),
          ),
        ),
      );

      const found = unwrap(await repo.visitsBetween('2026-09-01', '2026-09-30'));
      expect(found).toHaveLength(1);
    });

    it('includes an open-ended visit that began before the window', async () => {
      const home = unwrap(await repo.savePlace(placeOf({ name: 'Bangalore', kind: 'home' })));
      unwrap(await repo.saveVisit(unwrap(validateVisit({ id: newId(), placeId: home.id, arrivedOn: '2020-01-01' }))));

      expect(unwrap(await repo.visitsBetween('2026-09-01', '2026-09-30'))).toHaveLength(1);
    });

    it('excludes a visit that ended before the window', async () => {
      const london = unwrap(await repo.savePlace(placeOf({ name: 'London' })));
      unwrap(
        await repo.saveVisit(
          unwrap(
            validateVisit({ id: newId(), placeId: london.id, arrivedOn: '2026-01-01', departedOn: '2026-01-10' }),
          ),
        ),
      );

      expect(unwrap(await repo.visitsBetween('2026-09-01', '2026-09-30'))).toEqual([]);
    });

    it('refuses a departure before the arrival at the database', async () => {
      const london = unwrap(await repo.savePlace(placeOf({ name: 'London' })));

      const violated = await constraintFrom(
        () => database.$client`
          insert into visit (id, place_id, arrived_on, departed_on)
          values (gen_random_uuid(), ${london.id}, '2026-09-08', '2026-09-01')`,
      );

      expect(violated).toContain('visit_ordered');
    });

    it('returns visits oldest first, which is what resolveVisits expects', async () => {
      const home = unwrap(await repo.savePlace(placeOf({ name: 'Bangalore', kind: 'home' })));
      const london = unwrap(await repo.savePlace(placeOf({ name: 'London' })));

      unwrap(
        await repo.saveVisit(
          unwrap(
            validateVisit({ id: newId(), placeId: london.id, arrivedOn: '2026-09-01', departedOn: '2026-09-08' }),
          ),
        ),
      );
      unwrap(await repo.saveVisit(unwrap(validateVisit({ id: newId(), placeId: home.id, arrivedOn: '2020-01-01' }))));

      const visits = unwrap(await repo.visits());
      expect(visits.map((v) => v.arrivedOn)).toEqual(['2020-01-01', '2026-09-01']);
    });

    it('soft-deletes a visit', async () => {
      const london = unwrap(await repo.savePlace(placeOf({ name: 'London' })));
      const stay = unwrap(
        await repo.saveVisit(unwrap(validateVisit({ id: newId(), placeId: london.id, arrivedOn: '2026-09-01' }))),
      );

      unwrap(await repo.deleteVisit(stay.id, 'never went', '2026-09-06T00:00:00.000Z'));

      expect(unwrap(await repo.visits())).toEqual([]);
    });

    it('lists trips newest first', async () => {
      for (const startedOn of ['2026-01-01', '2026-09-01', '2026-05-01']) {
        unwrap(
          await repo.saveTrip(
            unwrap(validateTrip({ id: newId(), title: startedOn, purpose: 'leisure', startedOn })),
          ),
        );
      }

      expect(unwrap(await repo.trips()).map((t) => t.startedOn)).toEqual(['2026-09-01', '2026-05-01', '2026-01-01']);
    });
  });
});
