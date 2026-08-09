/**
 * IANA time-zone validation.
 *
 * §5.3 stores a zone name alongside every instant, and stores it *as a name*
 * rather than an offset:
 *
 *   "The offset alone is insufficient — `+05:30` does not tell you the rule
 *    that produced it, and rules change."
 *
 * Which makes the name load-bearing, and therefore worth validating on write.
 * A typo'd `Asia/Calcutta` (a real alias) or `IST` (not a zone at all) is
 * silently tolerated by `dayKeyInZone`, which falls back rather than throwing —
 * correct behaviour for a *read*, since one mis-filed row beats an unrenderable
 * timeline. On a *write* the tolerance is wrong: the bad value persists, and
 * every future read of that row inherits the fallback.
 */

/**
 * `Intl.supportedValuesOf` gives the full list, but it is an allocation of a
 * few hundred strings per call. Zone names arrive on every observation write,
 * so results are memoised — the set of valid zones does not change within a
 * process.
 */
const VERDICTS = new Map<string, boolean>();

/**
 * Whether this string names a zone that is safe to persist for twenty years.
 *
 * ## A constructor probe alone is not enough, and the reason is alarming
 *
 * `new Intl.DateTimeFormat('en', { timeZone: z })` accepts far more than IANA
 * zone names. Measured on this project's Node build:
 *
 * ```
 * 'IST'      → Asia/Calcutta        'EST'  → America/Panama
 * 'PST'      → America/Los_Angeles  'GMT'  → UTC
 * '+05:30'   → +05:30               'Zulu' → UTC
 * ```
 *
 * Two of those are genuinely dangerous in a medical record. `IST` is Indian,
 * Irish *and* Israel Standard Time depending on who typed it, and ICU silently
 * picks one. And `+05:30` is accepted **as a time zone** — the precise
 * confusion §5.3 was written to prevent: "the offset alone is insufficient —
 * `+05:30` does not tell you the rule that produced it, and rules change."
 *
 * So the probe is combined with a shape rule: a zone name must contain a `/`,
 * with `UTC` as the single permitted exception. That admits every name a real
 * device reports (`Asia/Kolkata`, `Asia/Calcutta`, `US/Pacific`, `Etc/GMT+5`)
 * and rejects every abbreviation and every bare offset.
 *
 * `Intl.supportedValuesOf('timeZone')` was considered as the membership test
 * and rejected: it returns *canonical* names only, and which name is canonical
 * moves between CLDR releases — this build canonicalises `Asia/Kolkata` to
 * `Asia/Calcutta`, so the operator's own zone would have failed the test.
 */
export function isIanaZone(zone: string): boolean {
  const cached = VERDICTS.get(zone);
  if (cached !== undefined) return cached;

  let valid: boolean;
  if (zone !== 'UTC' && !zone.includes('/')) {
    valid = false;
  } else {
    try {
      // The constructor throws `RangeError` for an unknown zone. Nothing else
      // in this call can throw, so the catch swallows nothing else.
      new Intl.DateTimeFormat('en-CA', { timeZone: zone });
      valid = true;
    } catch {
      valid = false;
    }
  }

  VERDICTS.set(zone, valid);
  return valid;
}

/* -------------------------------------------------------------------------
 * Local day boundaries
 * ---------------------------------------------------------------------- */

/**
 * The zone's UTC offset at a given instant, in milliseconds.
 *
 * Derived by formatting the instant *in* the zone and diffing the resulting
 * wall-clock reading against UTC. That is the only way to get this right: an
 * offset is a function of the instant, not a property of the zone, so any
 * approach that looks the offset up once and reuses it is wrong for half the
 * year in every zone with DST.
 */
function zoneOffsetMs(zone: string, instant: Date): number | null {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(instant);
  } catch {
    return null;
  }

  const field = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((part) => part.type === type);
    return found === undefined ? Number.NaN : Number(found.value);
  };

  const year = field('year');
  const month = field('month');
  const day = field('day');
  // `hour12: false` emits `24` for midnight on some ICU versions. Left alone it
  // would put local midnight a day early.
  const hour = field('hour') % 24;
  const minute = field('minute');
  const second = field('second');
  if ([year, month, day, hour, minute, second].some(Number.isNaN)) return null;

  const asIfUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  // Floor to the second: `asIfUtc` has no milliseconds, and leaving them in the
  // subtrahend would make every offset a few hundred milliseconds off.
  return asIfUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * The instant at which a `YYYY-MM-DD` begins in a zone.
 *
 * Two passes, and the second one is not defensive padding. The offset has to be
 * sampled at some instant, and the only instant available before the answer is
 * known is the naive UTC guess — which sits on the wrong side of a DST
 * transition for exactly the days where the answer matters. Sampling again at
 * the first estimate lands on the correct side.
 *
 * On a spring-forward day where local midnight does not exist (Chile, Lord
 * Howe), this converges to the instant the day actually starts, which is the
 * only defensible answer.
 *
 * Returns `null` for a malformed key or an unknown zone rather than guessing.
 */
export function zonedDayStart(dayKey: string, zone: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) return null;
  // Deliberately the same gate as the write path, not the looser constructor
  // probe underneath. A zone this system refuses to store is a zone it should
  // also refuse to compute with, or the two disagree about what a day is.
  if (!isIanaZone(zone)) return null;

  const naive = Date.parse(`${dayKey}T00:00:00Z`);
  if (Number.isNaN(naive)) return null;

  const firstOffset = zoneOffsetMs(zone, new Date(naive));
  if (firstOffset === null) return null;

  const estimate = naive - firstOffset;
  const secondOffset = zoneOffsetMs(zone, new Date(estimate));
  if (secondOffset === null) return null;

  return new Date(naive - secondOffset).toISOString();
}

/**
 * The half-open bounds of a local day: `[start, end)`.
 *
 * Half-open, because the alternative — an inclusive end at 23:59:59.999 — is
 * wrong on the day a leap second or a DST shift makes the day 23 or 25 hours
 * long, and is wrong by one millisecond every other day. §9.6's day query is a
 * range scan over `observed_at >= start AND observed_at < end`, so the bounds
 * have to be expressed the same way the index is used.
 */
export function zonedDayBounds(dayKey: string, zone: string): { start: string; end: string } | null {
  const start = zonedDayStart(dayKey, zone);
  if (start === null) return null;

  // Advance by a nominal 24 h and re-derive the *next* day's start, rather than
  // adding 24 h and calling it the end: a DST day is 23 or 25 hours long.
  const nextKey = new Date(Date.parse(`${dayKey}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const end = zonedDayStart(nextKey, zone);
  if (end === null) return null;

  return { start, end };
}
