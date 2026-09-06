import { describe, expect, it } from 'vitest';

import {
  BIRTHDAY_HORIZON_DAYS,
  MAX_CADENCE_DAYS,
  contactStatus,
  dueGraceDays,
  orderByAttention,
  upcomingBirthdays,
  validateInteraction,
  validatePerson,
} from './person';
import type { Person, PersonInput, PersonWithStatus } from './person';

function input(over: Partial<PersonInput> = {}): PersonInput {
  return { id: 'p1', name: 'Asha', relationship: 'friend', ...over };
}

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe('validatePerson', () => {
  it('trims and keeps what was given', () => {
    const person = unwrap(validatePerson(input({ name: '  Asha  ', context: ' met in 2019 ' })));

    expect(person.name).toBe('Asha');
    expect(person.context).toBe('met in 2019');
  });

  it('turns an empty optional into null rather than an empty string', () => {
    // The column is nullable and the difference matters on read: `''` renders
    // as a blank line, `null` renders as absent.
    const person = unwrap(validatePerson(input({ context: '   ', birthday: '' })));

    expect(person.context).toBeNull();
    expect(person.birthday).toBeNull();
  });

  it('requires a name', () => {
    const result = validatePerson(input({ name: '   ' }));

    expect(result.ok).toBe(false);
  });

  it('accepts a day-and-month birthday and names the format when refusing', () => {
    expect(unwrap(validatePerson(input({ birthday: '--03-14' }))).birthday).toBe('--03-14');

    const result = validatePerson(input({ birthday: '1994-03-14' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('--MM-DD');
  });

  it('refuses a day that does not exist, which the column CHECK cannot', () => {
    // `^--[0-1][0-9]-[0-3][0-9]$` passes 30 February. A calendar in SQL is not
    // the answer, so the domain owns this one.
    expect(validatePerson(input({ birthday: '--02-30' })).ok).toBe(false);
    expect(validatePerson(input({ birthday: '--04-31' })).ok).toBe(false);
  });

  it('accepts 29 February, because the year is unknown by construction', () => {
    expect(unwrap(validatePerson(input({ birthday: '--02-29' }))).birthday).toBe('--02-29');
  });

  it('bounds the cadence', () => {
    expect(validatePerson(input({ cadenceDays: 0 })).ok).toBe(false);
    expect(validatePerson(input({ cadenceDays: MAX_CADENCE_DAYS + 1 })).ok).toBe(false);
    expect(validatePerson(input({ cadenceDays: 1.5 })).ok).toBe(false);
    expect(unwrap(validatePerson(input({ cadenceDays: 30 }))).cadenceDays).toBe(30);
  });
});

describe('validateInteraction', () => {
  const base = {
    id: 'i1',
    personId: 'p1',
    kind: 'call' as const,
    occurredAt: '2026-09-06T10:00:00.000Z',
    zone: 'Asia/Kolkata',
    dayKey: '2026-09-06',
  };

  it('accepts a contact with a note', () => {
    expect(unwrap(validateInteraction({ ...base, note: ' caught up ' })).note).toBe('caught up');
  });

  it('refuses an unreadable day key', () => {
    expect(validateInteraction({ ...base, dayKey: 'yesterday' }).ok).toBe(false);
  });
});

describe('contactStatus', () => {
  it('says untracked when no cadence is set, rather than fine', () => {
    // §8.9 applied to an absent intention: the operator has not said how often
    // they want to be in touch, so the system has nothing to report.
    const status = contactStatus({ cadenceDays: null }, '2026-01-01', '2026-09-06');

    expect(status.state).toBe('untracked');
    expect(status.daysOver).toBeNull();
    // The gap is still counted — it is a fact — it just is not a verdict.
    expect(status.daysSince).toBe(248);
  });

  it('says never when there is a cadence and no recorded contact', () => {
    const status = contactStatus({ cadenceDays: 30 }, null, '2026-09-06');

    expect(status.state).toBe('never');
    expect(status.daysSince).toBeNull();
  });

  it('is current inside the cadence', () => {
    expect(contactStatus({ cadenceDays: 30 }, '2026-08-20', '2026-09-06').state).toBe('current');
  });

  it('is due at the cadence and through the grace', () => {
    // 30-day cadence gives a 3-day grace.
    expect(contactStatus({ cadenceDays: 30 }, '2026-08-07', '2026-09-06').state).toBe('due');
    expect(contactStatus({ cadenceDays: 30 }, '2026-08-04', '2026-09-06').state).toBe('due');
  });

  it('is overdue past the grace', () => {
    expect(contactStatus({ cadenceDays: 30 }, '2026-08-03', '2026-09-06').state).toBe('overdue');
  });

  it('scales the grace with the cadence', () => {
    // Three days past a weekly call is a different thing from three days past
    // an annual one, and a fixed grace would be wrong at both ends.
    expect(dueGraceDays(7)).toBe(1);
    expect(dueGraceDays(30)).toBe(3);
    expect(dueGraceDays(365)).toBe(7);
  });

  it('compares days, not instants', () => {
    // A call at 23:50 and one at 00:10 the next morning are a day apart in the
    // only sense this page cares about.
    expect(contactStatus({ cadenceDays: 7 }, '2026-09-05', '2026-09-06').daysSince).toBe(1);
  });
});

describe('orderByAttention', () => {
  const person = (id: string, name: string): Person => ({
    id,
    name,
    relationship: 'friend',
    context: null,
    birthday: null,
    cadenceDays: 30,
  });

  const entry = (id: string, name: string, lastContactDayKey: string | null): PersonWithStatus => ({
    person: person(id, name),
    status: contactStatus({ cadenceDays: 30 }, lastContactDayKey, '2026-09-06'),
    lastContactDayKey,
  });

  it('puts overdue first and current last', () => {
    const ordered = orderByAttention([
      entry('a', 'Current', '2026-09-01'),
      entry('b', 'Overdue', '2026-06-01'),
      entry('c', 'Due', '2026-08-06'),
    ]);

    expect(ordered.map((e) => e.person.name)).toEqual(['Overdue', 'Due', 'Current']);
  });

  it('ranks never below due, so a fresh row does not head the alarm list', () => {
    // Someone with a cadence and no contact is almost always someone added five
    // minutes ago. Putting them above a genuine overdue would make the top of
    // the list mean nothing within a fortnight.
    const ordered = orderByAttention([entry('a', 'New', null), entry('b', 'Overdue', '2026-06-01')]);

    expect(ordered.map((e) => e.person.name)).toEqual(['Overdue', 'New']);
  });

  it('breaks ties by longest silence, then by name', () => {
    const ordered = orderByAttention([
      entry('a', 'Zed', '2026-06-01'),
      entry('b', 'Amy', '2026-05-01'),
      entry('c', 'Bob', '2026-06-01'),
    ]);

    expect(ordered.map((e) => e.person.name)).toEqual(['Amy', 'Bob', 'Zed']);
  });
});

describe('upcomingBirthdays', () => {
  const person = (name: string, birthday: string | null): Person => ({
    id: name,
    name,
    relationship: 'friend',
    context: null,
    birthday,
    cadenceDays: null,
  });

  it('finds birthdays inside the horizon, soonest first', () => {
    const found = upcomingBirthdays(
      [person('Later', '--09-30'), person('Soon', '--09-10'), person('Today', '--09-06')],
      '2026-09-06',
    );

    expect(found.map((b) => b.person.name)).toEqual(['Today', 'Soon', 'Later']);
    expect(found[0]?.inDays).toBe(0);
    expect(found[1]?.inDays).toBe(4);
  });

  it('excludes anything past the horizon', () => {
    const found = upcomingBirthdays([person('Far', '--12-25')], '2026-09-06');

    expect(found).toEqual([]);
    expect(BIRTHDAY_HORIZON_DAYS).toBe(30);
  });

  it('wraps across the year end', () => {
    // A 3 January birthday is four days away on 30 December, not 361 days ago.
    const found = upcomingBirthdays([person('NewYear', '--01-03')], '2026-12-30');

    expect(found[0]?.inDays).toBe(4);
  });

  it('shows a 29 February birthday on the 28th in a common year', () => {
    // 2027 is not a leap year. Moving it to 1 March would put it in the wrong
    // month; hiding it would be worse than either.
    const found = upcomingBirthdays([person('Leapling', '--02-29')], '2027-02-20');

    expect(found[0]?.inDays).toBe(8);
  });

  it('keeps 29 February on its own day in a leap year', () => {
    const found = upcomingBirthdays([person('Leapling', '--02-29')], '2028-02-20');

    expect(found[0]?.inDays).toBe(9);
  });

  it('ignores people with no birthday recorded', () => {
    expect(upcomingBirthdays([person('Unknown', null)], '2026-09-06')).toEqual([]);
  });
});
