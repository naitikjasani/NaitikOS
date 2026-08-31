/**
 * iCalendar import — §4.8's "read-only import in V3".
 *
 * ## Why this is hand-written rather than a dependency
 *
 * The ICS format is large and this system needs a strict subset of it: expanded
 * `VEVENT`s with a `UID`, a start, and optionally an end, a summary, a location
 * and a partstat. Every general-purpose parser brings recurrence expansion with
 * it, and §4.8 is explicit that the import is read-only — expansion is the
 * source system's job, and reimplementing it here means getting it subtly wrong
 * against the calendar this is only supposed to be reading.
 *
 * So: `RRULE` is not expanded. An event carrying one is imported as its single
 * `DTSTART` occurrence and flagged, because silently importing one instance of
 * a weekly standup as though it were the whole series would understate a year
 * of meeting load by a factor of fifty.
 *
 * ## What is deliberately not extracted
 *
 * **Attendee identities.** Only the count. §4.8 wants meeting density; the
 * names of the operator's colleagues are other people's personal data arriving
 * in a system with no consent model for them, and §10.10's "unrepresentable
 * harmful output" is easiest to guarantee by never storing it.
 *
 * **DESCRIPTION.** Meeting bodies contain agendas, links, dial-ins and
 * occasionally confidential text belonging to an employer. The load signal does
 * not need it.
 */

/** One parsed occurrence. Shaped for `calendar_event` directly. */
export type IcsEvent = {
  readonly externalId: string;
  readonly title: string | null;
  readonly location: string | null;
  readonly startsAt: string;
  readonly endsAt: string | null;
  readonly isAllDay: boolean;
  readonly isAccepted: boolean | null;
  readonly attendeeCount: number | null;
  /** True when the source carried an RRULE this import did not expand. */
  readonly hasUnexpandedRecurrence: boolean;
};

export type IcsParse = {
  readonly events: readonly IcsEvent[];
  readonly calendarName: string | null;
  /** Blocks skipped, and why. Reported rather than swallowed. */
  readonly skipped: readonly { readonly reason: string; readonly uid: string | null }[];
};

/**
 * Words in a summary or location that mark a day as travel.
 *
 * A hand-written list rather than anything inferred. §4.8 names travel as one of
 * three things this data explains, and a guess dressed as a fact is worse than
 * an unset flag — which is why the field is correctable by hand once imported.
 */
export const TRAVEL_WORDS: readonly string[] = Object.freeze([
  'flight',
  'flying',
  'airport',
  'train to',
  'travel to',
  'travelling',
  'traveling',
  'boarding',
  'layover',
]);

export function looksLikeTravel(summary: string | null, location: string | null): boolean {
  const haystack = `${summary ?? ''} ${location ?? ''}`.toLowerCase();
  return TRAVEL_WORDS.some((word) => haystack.includes(word));
}

/**
 * Parse an ICS document into occurrences.
 *
 * Tolerant by design: an unparseable `VEVENT` is skipped with a reason rather
 * than failing the import. A calendar export with one malformed block out of
 * four hundred should produce three hundred and ninety-nine events and a note,
 * not an error page.
 */
export function parseIcs(source: string): IcsParse {
  const lines = unfold(source);

  const events: IcsEvent[] = [];
  const skipped: { reason: string; uid: string | null }[] = [];
  let calendarName: string | null = null;

  let current: Map<string, { value: string; params: Map<string, string> }> | null = null;

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      current = new Map();
      continue;
    }

    if (line === 'END:VEVENT') {
      if (current !== null) {
        const parsed = toEvent(current);
        if ('reason' in parsed) skipped.push(parsed);
        else events.push(parsed);
      }
      current = null;
      continue;
    }

    const parsedLine = splitLine(line);
    if (parsedLine === null) continue;

    if (current === null) {
      if (parsedLine.name === 'X-WR-CALNAME') calendarName = parsedLine.value;
      continue;
    }

    /*
     * First value wins for a repeated property. ATTENDEE legitimately repeats
     * and is counted separately below; everything else repeating is a malformed
     * export, and taking the first is more predictable than taking the last.
     */
    if (parsedLine.name === 'ATTENDEE') {
      const count = current.get('__attendees')?.value ?? '0';
      current.set('__attendees', { value: String(Number(count) + 1), params: new Map() });
      /* The operator's own PARTSTAT is on their ATTENDEE line. Any DECLINED
       * line is treated as theirs — a personal calendar export contains one
       * attendee record for the owner, and the alternative is matching on an
       * email address this system has no business storing. */
      const partstat = parsedLine.params.get('PARTSTAT');
      if (partstat !== undefined && !current.has('__partstat')) {
        current.set('__partstat', { value: partstat, params: new Map() });
      }
      continue;
    }

    if (!current.has(parsedLine.name)) {
      current.set(parsedLine.name, { value: parsedLine.value, params: parsedLine.params });
    }
  }

  return { events, calendarName, skipped };
}

function toEvent(
  fields: Map<string, { value: string; params: Map<string, string> }>,
): IcsEvent | { reason: string; uid: string | null } {
  const uid = fields.get('UID')?.value ?? null;
  if (uid === null || uid === '') {
    return { reason: 'no UID — the re-import key would be missing', uid: null };
  }

  const dtstart = fields.get('DTSTART');
  if (dtstart === undefined) return { reason: 'no DTSTART', uid };

  const start = parseIcsInstant(dtstart.value, dtstart.params);
  if (start === null) return { reason: `unparseable DTSTART: ${dtstart.value}`, uid };

  const dtend = fields.get('DTEND');
  const end = dtend === undefined ? null : parseIcsInstant(dtend.value, dtend.params);

  const summary = fields.get('SUMMARY')?.value ?? null;
  const location = fields.get('LOCATION')?.value ?? null;
  const partstat = fields.get('__partstat')?.value ?? null;
  const attendees = fields.get('__attendees')?.value;

  return {
    externalId: uid,
    title: summary === '' ? null : summary,
    location: location === '' ? null : location,
    startsAt: start.iso,
    endsAt: end?.iso ?? null,
    isAllDay: start.isAllDay,
    /*
     * `null` for an absent PARTSTAT, not `true`. An invitation nobody answered
     * and an invitation nobody was asked about are different, and `dailyLoad`
     * counts the unanswered one — but the distinction is recorded rather than
     * flattened here.
     */
    isAccepted: partstat === null ? null : partstat.toUpperCase() !== 'DECLINED',
    attendeeCount: attendees === undefined ? null : Number(attendees),
    hasUnexpandedRecurrence: fields.has('RRULE'),
  };
}

/**
 * Unfold RFC 5545 line continuations.
 *
 * A line beginning with a space or tab continues the previous one. This is not
 * cosmetic: a long SUMMARY is routinely folded at 75 octets, and reading the
 * lines separately turns one meeting into a property line and a fragment of
 * text that parses as nothing.
 */
function unfold(source: string): readonly string[] {
  const raw = source.split(/\r\n|\n|\r/u);
  const out: string[] = [];
  for (const line of raw) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length > 0) {
      out[out.length - 1] = `${out[out.length - 1] ?? ''}${line.slice(1)}`;
      continue;
    }
    out.push(line);
  }
  return out.map((line) => line.trimEnd()).filter((line) => line !== '');
}

function splitLine(
  line: string,
): { name: string; value: string; params: Map<string, string> } | null {
  const colon = line.indexOf(':');
  if (colon === -1) return null;

  const head = line.slice(0, colon);
  const value = unescapeText(line.slice(colon + 1));

  const parts = head.split(';');
  const name = (parts[0] ?? '').toUpperCase();
  const params = new Map<string, string>();
  for (const part of parts.slice(1)) {
    const equals = part.indexOf('=');
    if (equals === -1) continue;
    params.set(part.slice(0, equals).toUpperCase(), part.slice(equals + 1).replaceAll('"', ''));
  }

  return { name, value, params };
}

/** RFC 5545 escaping: `\,` `\;` `\n` `\\`. */
function unescapeText(value: string): string {
  return value
    .replaceAll('\\n', '\n')
    .replaceAll('\\N', '\n')
    .replaceAll('\\,', ',')
    .replaceAll('\\;', ';')
    .replaceAll('\\\\', '\\');
}

/**
 * An ICS date-time, as an ISO instant.
 *
 * Three forms exist and all three appear in real exports:
 *
 *   - `20260830T093000Z` — UTC. Unambiguous.
 *   - `20260830` with `VALUE=DATE` — an all-day marker, no time at all.
 *   - `20260830T093000` with `TZID=Asia/Kolkata` — local to a named zone.
 *
 * The third is the one that cannot be resolved here. Converting it needs the
 * zone database, and §11.3 puts zone interpretation in `core/temporal` behind
 * `zonedDayBounds` — which takes a day key, not a wall-clock time. Rather than
 * open-coding an offset lookup in a parser, the local form is returned with its
 * zone attached so the caller resolves it. That keeps the one place that knows
 * about zones the one place that knows about zones.
 */
export function parseIcsInstant(
  value: string,
  params: Map<string, string>,
): { iso: string; isAllDay: boolean; zone: string | null } | null {
  const trimmed = value.trim();

  /* All-day: YYYYMMDD, no time component. */
  if (params.get('VALUE') === 'DATE' || /^\d{8}$/u.test(trimmed)) {
    const day = /^(\d{4})(\d{2})(\d{2})$/u.exec(trimmed);
    if (day === null) return null;
    /* Noon, not midnight. Midnight sits on a boundary a DST rule can push into
     * the previous day, and an all-day event landing on the wrong date is the
     * exact failure this convention exists to prevent — the same reason every
     * day-anchored instant in this codebase is written at noon. */
    return { iso: `${day[1] ?? ''}-${day[2] ?? ''}-${day[3] ?? ''}T12:00:00.000Z`, isAllDay: true, zone: null };
  }

  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/u.exec(trimmed);
  if (match === null) return null;

  const [, year, month, day, hour, minute, second, utc] = match;
  const local = `${year ?? ''}-${month ?? ''}-${day ?? ''}T${hour ?? ''}:${minute ?? ''}:${second ?? ''}.000`;

  if (utc === 'Z') return { iso: `${local}Z`, isAllDay: false, zone: null };

  /*
   * Floating or zoned local time. Returned as a UTC-suffixed string with the
   * zone alongside so the caller can correct it; an importer that ignores the
   * zone gets a value that is wrong by an offset rather than one that is
   * missing, which is the lesser of the two failures for a load series.
   */
  return { iso: `${local}Z`, isAllDay: false, zone: params.get('TZID') ?? null };
}
