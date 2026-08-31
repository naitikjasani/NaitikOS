import { describe, expect, it } from 'vitest';

import { looksLikeTravel, parseIcs, parseIcsInstant } from './ics';

const CALENDAR = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'X-WR-CALNAME:Work',
  'BEGIN:VEVENT',
  'UID:standup@example.com',
  'DTSTART:20260830T033000Z',
  'DTEND:20260830T034500Z',
  'SUMMARY:Daily standup',
  'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
  'ATTENDEE;PARTSTAT=ACCEPTED:mailto:a@example.com',
  'ATTENDEE;PARTSTAT=ACCEPTED:mailto:b@example.com',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:offsite@example.com',
  'DTSTART;VALUE=DATE:20260901',
  'SUMMARY:Team offsite',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:declined@example.com',
  'DTSTART:20260830T060000Z',
  'DTEND:20260830T070000Z',
  'SUMMARY:A meeting I skipped',
  'ATTENDEE;PARTSTAT=DECLINED:mailto:a@example.com',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART:20260830T080000Z',
  'SUMMARY:No UID at all',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

describe('parseIcs', () => {
  const parsed = parseIcs(CALENDAR);

  it('reads the calendar name', () => {
    expect(parsed.calendarName).toBe('Work');
  });

  it('skips a VEVENT with no UID and says why, rather than failing the import', () => {
    expect(parsed.events).toHaveLength(3);
    expect(parsed.skipped).toEqual([{ reason: 'no UID — the re-import key would be missing', uid: null }]);
  });

  it('flags an unexpanded RRULE rather than importing one occurrence silently', () => {
    const standup = parsed.events.find((event) => event.externalId === 'standup@example.com');
    /* Fifty weekly standups imported as one would understate a year of meeting
     * load by a factor of fifty. The flag is how that becomes visible. */
    expect(standup?.hasUnexpandedRecurrence).toBe(true);
  });

  it('counts attendees without storing who they are', () => {
    const standup = parsed.events.find((event) => event.externalId === 'standup@example.com');
    expect(standup?.attendeeCount).toBe(2);
    expect(JSON.stringify(standup)).not.toContain('example.com/mailto');
    expect(JSON.stringify(standup)).not.toContain('b@example.com');
  });

  it('reads a declined PARTSTAT as not accepted', () => {
    const declined = parsed.events.find((event) => event.externalId === 'declined@example.com');
    expect(declined?.isAccepted).toBe(false);
  });

  it('leaves acceptance null when no PARTSTAT was present', () => {
    const offsite = parsed.events.find((event) => event.externalId === 'offsite@example.com');
    expect(offsite?.isAccepted).toBeNull();
  });

  it('marks a VALUE=DATE event as all-day and anchors it at noon', () => {
    const offsite = parsed.events.find((event) => event.externalId === 'offsite@example.com');
    expect(offsite?.isAllDay).toBe(true);
    /* Noon, not midnight: midnight sits on a boundary a DST rule can push into
     * the previous day, which is the one failure an all-day marker cannot have. */
    expect(offsite?.startsAt).toBe('2026-09-01T12:00:00.000Z');
    expect(offsite?.endsAt).toBeNull();
  });

  it('unfolds a continued line, so a long summary stays one summary', () => {
    const folded = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:long@example.com',
      'DTSTART:20260830T033000Z',
      'SUMMARY:Quarterly planning with the platform team and',
      '  the infrastructure group',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

    const [event] = parseIcs(folded).events;
    expect(event?.title).toBe('Quarterly planning with the platform team and the infrastructure group');
  });

  it('unescapes commas and newlines in text', () => {
    const escaped = [
      'BEGIN:VEVENT',
      'UID:escaped@example.com',
      'DTSTART:20260830T033000Z',
      'SUMMARY:Review\\, retro\\, and planning',
      'LOCATION:Bengaluru\\nRoom 4',
      'END:VEVENT',
    ].join('\r\n');

    const [event] = parseIcs(escaped).events;
    expect(event?.title).toBe('Review, retro, and planning');
    expect(event?.location).toBe('Bengaluru\nRoom 4');
  });

  it('handles LF-only line endings, which real exports do produce', () => {
    expect(parseIcs(CALENDAR.replaceAll('\r\n', '\n')).events).toHaveLength(3);
  });

  it('returns nothing for an empty document rather than throwing', () => {
    expect(parseIcs('')).toEqual({ events: [], calendarName: null, skipped: [] });
  });
});

describe('parseIcsInstant', () => {
  it('reads a UTC instant', () => {
    expect(parseIcsInstant('20260830T093000Z', new Map())).toEqual({
      iso: '2026-08-30T09:30:00.000Z',
      isAllDay: false,
      zone: null,
    });
  });

  it('returns the zone alongside a local time rather than resolving it here', () => {
    /* §11.3 keeps zone interpretation in core/temporal. A parser open-coding an
     * offset lookup is how a DST bug gets written twice. */
    expect(parseIcsInstant('20260830T093000', new Map([['TZID', 'Asia/Kolkata']]))).toEqual({
      iso: '2026-08-30T09:30:00.000Z',
      isAllDay: false,
      zone: 'Asia/Kolkata',
    });
  });

  it('refuses something that is not a date-time', () => {
    expect(parseIcsInstant('sometime next week', new Map())).toBeNull();
  });
});

describe('looksLikeTravel', () => {
  it('matches on the summary or the location', () => {
    expect(looksLikeTravel('Flight to Delhi', null)).toBe(true);
    expect(looksLikeTravel('Sync', 'Bengaluru Airport')).toBe(true);
  });

  it('does not match an ordinary meeting', () => {
    expect(looksLikeTravel('Sprint planning', 'Room 4')).toBe(false);
  });
});
