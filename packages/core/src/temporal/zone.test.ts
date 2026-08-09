import { describe, expect, it } from 'vitest';

import { isIanaZone, zonedDayBounds, zonedDayStart } from './zone';

describe('isIanaZone', () => {
  it('accepts real zones, including aliases a phone might report', () => {
    expect(isIanaZone('Asia/Kolkata')).toBe(true);
    expect(isIanaZone('UTC')).toBe(true);
    expect(isIanaZone('Europe/London')).toBe(true);
    expect(isIanaZone('America/Argentina/Buenos_Aires')).toBe(true);
    // An alias `supportedValuesOf` omits but every device still reports.
    expect(isIanaZone('Asia/Calcutta')).toBe(true);
    // A fixed-offset zone. Legal, and the sign convention is famously inverted.
    expect(isIanaZone('Etc/GMT+5')).toBe(true);
  });

  /**
   * These all pass a bare `new Intl.DateTimeFormat({ timeZone })` probe. `IST`
   * resolves to Asia/Calcutta on this build and would resolve elsewhere on
   * another — it is Indian, Irish *and* Israel Standard Time. `+05:30` is
   * accepted as a "zone", which is exactly the offset-is-not-a-zone confusion
   * §5.3 exists to prevent.
   */
  it('rejects abbreviations and bare offsets that Intl would happily accept', () => {
    expect(isIanaZone('IST')).toBe(false);
    expect(isIanaZone('EST')).toBe(false);
    expect(isIanaZone('PST')).toBe(false);
    expect(isIanaZone('GMT')).toBe(false);
    expect(isIanaZone('Zulu')).toBe(false);
    expect(isIanaZone('+05:30')).toBe(false);
    expect(isIanaZone('Asia/Kolkatta')).toBe(false);
    expect(isIanaZone('')).toBe(false);
  });

  /**
   * The reason `Intl.supportedValuesOf('timeZone')` is not the membership test:
   * this build canonicalises the operator's own zone the *other* way, so a
   * membership check against the canonical list would reject `Asia/Kolkata`.
   */
  it('accepts both spellings of the operator’s zone, whichever is canonical today', () => {
    expect(isIanaZone('Asia/Kolkata')).toBe(true);
    expect(isIanaZone('Asia/Calcutta')).toBe(true);
    expect(isIanaZone('US/Pacific')).toBe(true);
  });

  it('is memoised without changing its answers', () => {
    expect(isIanaZone('Asia/Kolkata')).toBe(true);
    expect(isIanaZone('Asia/Kolkata')).toBe(true);
    expect(isIanaZone('Nowhere/Nothing')).toBe(false);
    expect(isIanaZone('Nowhere/Nothing')).toBe(false);
  });

  it('accepts whatever zone the runtime is actually set to', () => {
    // The machine running the tests reports its own zone, and that zone must be
    // storable — otherwise every observation written on this machine is refused.
    expect(isIanaZone(Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe(true);
  });
});

describe('zonedDayStart', () => {
  it('resolves a local midnight to the right instant', () => {
    // IST is +05:30 year-round.
    expect(zonedDayStart('2026-08-03', 'Asia/Kolkata')).toBe('2026-08-02T18:30:00.000Z');
    expect(zonedDayStart('2026-08-03', 'UTC')).toBe('2026-08-03T00:00:00.000Z');
    // BST, +01:00 in August.
    expect(zonedDayStart('2026-08-03', 'Europe/London')).toBe('2026-08-02T23:00:00.000Z');
    // GMT, +00:00 in January — the same zone, a different offset.
    expect(zonedDayStart('2026-01-03', 'Europe/London')).toBe('2026-01-03T00:00:00.000Z');
  });

  /**
   * The reason for the second offset pass. The naive UTC guess for a
   * spring-forward day samples the offset on the wrong side of the transition,
   * and a single pass produces an instant one hour out.
   */
  it('is correct across a DST transition', () => {
    // Clocks go forward 02:00 → 03:00 on 29 March 2026 in London.
    expect(zonedDayStart('2026-03-29', 'Europe/London')).toBe('2026-03-29T00:00:00.000Z');
    expect(zonedDayStart('2026-03-30', 'Europe/London')).toBe('2026-03-29T23:00:00.000Z');
    // Clocks go back 02:00 → 01:00 on 25 October 2026.
    expect(zonedDayStart('2026-10-25', 'Europe/London')).toBe('2026-10-24T23:00:00.000Z');
    expect(zonedDayStart('2026-10-26', 'Europe/London')).toBe('2026-10-26T00:00:00.000Z');
  });

  it('refuses a malformed key or an unknown zone', () => {
    expect(zonedDayStart('2026-8-3', 'UTC')).toBeNull();
    expect(zonedDayStart('not-a-day', 'UTC')).toBeNull();
    expect(zonedDayStart('2026-08-03', 'IST')).toBeNull();
  });
});

describe('zonedDayBounds', () => {
  it('produces half-open bounds one nominal day apart', () => {
    expect(zonedDayBounds('2026-08-03', 'Asia/Kolkata')).toEqual({
      start: '2026-08-02T18:30:00.000Z',
      end: '2026-08-03T18:30:00.000Z',
    });
  });

  /**
   * The reason the end is the *next day's start* rather than start + 24 h. A
   * DST day is 23 or 25 hours long, and a fixed 24-hour window either drops an
   * hour of observations or double-counts one.
   */
  it('spans 23 hours on a spring-forward day and 25 on a fall-back day', () => {
    const spring = zonedDayBounds('2026-03-29', 'Europe/London');
    expect(spring).not.toBeNull();
    const springHours =
      (Date.parse((spring as { end: string }).end) - Date.parse((spring as { start: string }).start)) / 3_600_000;
    expect(springHours).toBe(23);

    const autumn = zonedDayBounds('2026-10-25', 'Europe/London');
    const autumnHours =
      (Date.parse((autumn as { end: string }).end) - Date.parse((autumn as { start: string }).start)) / 3_600_000;
    expect(autumnHours).toBe(25);
  });

  it('refuses what zonedDayStart refuses', () => {
    expect(zonedDayBounds('2026-08-03', 'IST')).toBeNull();
    expect(zonedDayBounds('nonsense', 'UTC')).toBeNull();
  });
});
