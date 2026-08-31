import { describe, expect, it } from 'vitest';

import {
  SLEEP_DISTURBANCES,
  SLEEP_DISTURBANCE_LABELS,
  describeNight,
  sleepEfficiency,
  timeInBedHours,
  validateSleepNight,
  type SleepNight,
  type SleepNightInput,
} from './night';

/*
 * 23:10 to 06:40 in Asia/Kolkata — seven and a half hours in bed, of which
 * seven asleep. The endpoints straddle midnight in both UTC and the local zone,
 * which is the ordinary case for a night and the one every off-by-one lives in.
 */
const BED_AT = '2026-08-29T17:40:00.000Z';
const WOKE_AT = '2026-08-30T01:10:00.000Z';

const base: SleepNight = {
  id: '01900000-0000-7000-8000-000000000001',
  dayKey: '2026-08-30',
  zone: 'Asia/Kolkata',
  bedAt: BED_AT,
  wokeAt: WOKE_AT,
  durationHours: '7.000000',
  quality: 4,
  latencyMinutes: 20,
  wakings: 1,
  disturbance: null,
  disturbanceNote: null,
  note: null,
};

const night = (overrides: Partial<SleepNight>): SleepNight => ({ ...base, ...overrides });

const input = (overrides: Partial<SleepNightInput>): SleepNightInput => ({
  id: base.id,
  dayKey: base.dayKey,
  zone: base.zone,
  ...overrides,
});

const codeOf = (result: ReturnType<typeof validateSleepNight>): string | null =>
  result.ok ? null : result.error.code;

describe('the disturbance vocabulary', () => {
  it('has a label for every value the pgEnum allows', () => {
    for (const value of SLEEP_DISTURBANCES) {
      expect(SLEEP_DISTURBANCE_LABELS[value]).not.toBe('');
    }
    expect(Object.keys(SLEEP_DISTURBANCE_LABELS)).toHaveLength(SLEEP_DISTURBANCES.length);
  });
});

describe('validateSleepNight', () => {
  it('accepts a night that is only a duration', () => {
    /* What the Daily Close produces: hours slept, no timing at all. §4.6 puts
     * sleep in the MVP ritual precisely so this record is cheap to make. */
    expect(validateSleepNight(input({ durationHours: '7.5', quality: 4 })).ok).toBe(true);
  });

  it('accepts a night that is only a day key', () => {
    expect(validateSleepNight(input({})).ok).toBe(true);
  });

  it('refuses a day key that is not a day key', () => {
    expect(codeOf(validateSleepNight(input({ dayKey: '2026-8-30' })))).toBe('sleep_day_key_invalid');
    expect(codeOf(validateSleepNight(input({ dayKey: '2026-02-31' })))).toBe('sleep_day_key_invalid');
  });

  it('refuses an endpoint that does not parse', () => {
    expect(codeOf(validateSleepNight(input({ bedAt: 'last night' })))).toBe('sleep_bed_at_invalid');
    expect(codeOf(validateSleepNight(input({ wokeAt: '' })))).toBe('sleep_woke_at_invalid');
  });

  it('requires the endpoints to be ordered, strictly', () => {
    expect(
      codeOf(
        validateSleepNight(
          input({ bedAt: '2026-08-30T01:10:00.000Z', wokeAt: '2026-08-29T17:40:00.000Z' }),
        ),
      ),
    ).toBe('sleep_not_ordered');

    /* Equal endpoints are a night of zero length, which is not a night. The
     * column CHECK says `bed_at < woke_at` and this says the same thing. */
    expect(
      codeOf(
        validateSleepNight(
          input({ bedAt: '2026-08-29T17:40:00.000Z', wokeAt: '2026-08-29T17:40:00.000Z' }),
        ),
      ),
    ).toBe('sleep_not_ordered');
  });

  it('allows one endpoint without the other', () => {
    expect(validateSleepNight(input({ bedAt: BED_AT })).ok).toBe(true);
    expect(validateSleepNight(input({ wokeAt: WOKE_AT })).ok).toBe(true);
  });

  it('holds quality to the Daily Close scale', () => {
    expect(codeOf(validateSleepNight(input({ quality: 0 })))).toBe('sleep_quality_range');
    expect(codeOf(validateSleepNight(input({ quality: 6 })))).toBe('sleep_quality_range');
    expect(codeOf(validateSleepNight(input({ quality: 3.5 })))).toBe('sleep_quality_range');
    expect(validateSleepNight(input({ quality: 1 })).ok).toBe(true);
    expect(validateSleepNight(input({ quality: 5 })).ok).toBe(true);
  });

  it('holds latency to nought through six hundred minutes', () => {
    expect(codeOf(validateSleepNight(input({ latencyMinutes: -1 })))).toBe('sleep_latency_range');
    expect(codeOf(validateSleepNight(input({ latencyMinutes: 601 })))).toBe('sleep_latency_range');
    expect(codeOf(validateSleepNight(input({ latencyMinutes: 12.5 })))).toBe('sleep_latency_range');
    expect(validateSleepNight(input({ latencyMinutes: 0 })).ok).toBe(true);
    expect(validateSleepNight(input({ latencyMinutes: 600 })).ok).toBe(true);
  });

  it('requires a whole, non-negative count of wakings', () => {
    expect(codeOf(validateSleepNight(input({ wakings: -1 })))).toBe('sleep_wakings_invalid');
    expect(codeOf(validateSleepNight(input({ wakings: 1.5 })))).toBe('sleep_wakings_invalid');
    expect(validateSleepNight(input({ wakings: 0 })).ok).toBe(true);
  });

  it('requires a duration that is a decimal string in range', () => {
    expect(codeOf(validateSleepNight(input({ durationHours: 'seven' })))).toBe('sleep_duration_invalid');
    expect(codeOf(validateSleepNight(input({ durationHours: 'NaN' })))).toBe('sleep_duration_invalid');
    expect(codeOf(validateSleepNight(input({ durationHours: '-0.5' })))).toBe('sleep_duration_range');
    expect(codeOf(validateSleepNight(input({ durationHours: '24.000001' })))).toBe('sleep_duration_range');
    expect(validateSleepNight(input({ durationHours: '24' })).ok).toBe(true);
    expect(validateSleepNight(input({ durationHours: '0' })).ok).toBe(true);
  });

  describe('a duration longer than the time in bed', () => {
    const bedAt = BED_AT;
    const wokeAt = WOKE_AT;

    it('is refused, because it is a typo rather than a finding', () => {
      /*
       * Seven and a half hours in bed, eight and a half claimed asleep. Every
       * column constraint passes — the duration is inside 0–24, the endpoints
       * are ordered — and the record would then lift the mean, cap the
       * efficiency above 1, and skew every correlation drawn against sleep.
       * This is the only place it is still visible.
       */
      expect(codeOf(validateSleepNight(input({ bedAt, wokeAt, durationHours: '8.5' })))).toBe(
        'sleep_duration_exceeds_bed',
      );
    });

    it('is refused by a fraction of a second, because the comparison is exact', () => {
      /* Under four milliseconds over. The endpoints are integers and the duration is
       * scaled up to meet them, so there is no epsilon in which a wrong record
       * can hide. */
      expect(codeOf(validateSleepNight(input({ bedAt, wokeAt, durationHours: '7.500001' })))).toBe(
        'sleep_duration_exceeds_bed',
      );
    });

    it('accepts a duration exactly equal to the time in bed', () => {
      /* The boundary the exact-decimal comparison exists for. A float round
       * trip through 7.5 hours of milliseconds is where an epsilon-based check
       * would reject a legitimate record. */
      expect(validateSleepNight(input({ bedAt, wokeAt, durationHours: '7.5' })).ok).toBe(true);
      expect(validateSleepNight(input({ bedAt, wokeAt, durationHours: '7.500000' })).ok).toBe(true);
    });

    it('is not checked when there is no interval to check against', () => {
      /* No endpoints, so there is nothing the duration can contradict. A
       * duration-only night is complete, not suspicious. */
      expect(validateSleepNight(input({ durationHours: '9' })).ok).toBe(true);
      expect(validateSleepNight(input({ bedAt, durationHours: '9' })).ok).toBe(true);
    });
  });
});

describe('timeInBedHours', () => {
  it('measures the interval between the endpoints', () => {
    expect(timeInBedHours(base)).toBe(7.5);
  });

  it('is null unless both endpoints exist', () => {
    expect(timeInBedHours(night({ bedAt: null }))).toBeNull();
    expect(timeInBedHours(night({ wokeAt: null }))).toBeNull();
    expect(timeInBedHours(night({ bedAt: null, wokeAt: null }))).toBeNull();
  });
});

describe('sleepEfficiency', () => {
  it('divides time asleep by time in bed', () => {
    expect(sleepEfficiency(base)).toBeCloseTo(7 / 7.5, 10);
  });

  it('is null when the duration is unknown, never a default of one', () => {
    /* The failure this guards: an efficiency of 1.0 for a night nobody
     * measured is indistinguishable on a chart from a perfect night. */
    expect(sleepEfficiency(night({ durationHours: null }))).toBeNull();
  });

  it('is null when the timing is unknown', () => {
    expect(sleepEfficiency(night({ bedAt: null }))).toBeNull();
    expect(sleepEfficiency(night({ bedAt: null, wokeAt: null }))).toBeNull();
  });
});

describe('describeNight', () => {
  it('says only what was recorded when only a duration was', () => {
    expect(
      describeNight(
        night({
          bedAt: null,
          wokeAt: null,
          durationHours: '7.500000',
          quality: null,
          latencyMinutes: null,
          wakings: null,
        }),
      ),
    ).toBe('7.5 h asleep.');
  });

  it('distinguishes time in bed from time asleep', () => {
    expect(
      describeNight(
        night({ durationHours: null, quality: null, latencyMinutes: null, wakings: null }),
      ),
    ).toBe('7.5 h in bed, time asleep not recorded.');
  });

  it('reports an empty night as empty rather than as an empty string', () => {
    expect(
      describeNight(
        night({
          bedAt: null,
          wokeAt: null,
          durationHours: null,
          quality: null,
          latencyMinutes: null,
          wakings: null,
        }),
      ),
    ).toBe('Nothing recorded for this night.');
  });

  it('assembles everything that is there and nothing that is not', () => {
    expect(describeNight(night({ disturbance: 'noise', wakings: 3 }))).toBe(
      '7 h asleep, quality 4/5, 20 min to fall asleep, 3 wakings, disturbed by noise.',
    );
  });

  it('does not mention nought wakings, which is the good outcome and not an event', () => {
    expect(describeNight(night({ wakings: 0, latencyMinutes: null }))).toBe('7 h asleep, quality 4/5.');
  });
});
