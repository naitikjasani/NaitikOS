import { describe, expect, it } from 'vitest';

import { hourInZone } from '../../timeline/grouping';
import {
  MIN_FOCUS_MINUTES,
  busiestHours,
  focusByHour,
  totalFocusMinutes,
  validateFocusSession,
  type FocusSession,
} from './focus';

const base: FocusSession = {
  id: '01900000-0000-7000-8000-000000000001',
  startedAt: '2026-08-30T03:30:00.000Z',
  endedAt: '2026-08-30T05:30:00.000Z',
  zone: 'Asia/Kolkata',
  dayKey: '2026-08-30',
  projectId: null,
  taskId: null,
  label: 'Blueprint',
  quality: 4,
  interruptions: 1,
  note: null,
};

const session = (overrides: Partial<FocusSession>): FocusSession => ({ ...base, ...overrides });

describe('validateFocusSession', () => {
  it('refuses a session shorter than the deep-work floor', () => {
    const result = validateFocusSession({
      id: base.id,
      startedAt: '2026-08-30T03:30:00.000Z',
      endedAt: '2026-08-30T03:35:00.000Z',
      zone: base.zone,
      dayKey: base.dayKey,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('focus_too_short');
  });

  it('accepts a session exactly at the floor', () => {
    const end = new Date(Date.parse(base.startedAt) + MIN_FOCUS_MINUTES * 60_000).toISOString();
    expect(
      validateFocusSession({ id: base.id, startedAt: base.startedAt, endedAt: end, zone: base.zone, dayKey: base.dayKey })
        .ok,
    ).toBe(true);
  });

  it('accepts a session still running, with no end at all', () => {
    expect(
      validateFocusSession({ id: base.id, startedAt: base.startedAt, zone: base.zone, dayKey: base.dayKey }).ok,
    ).toBe(true);
  });

  it('refuses a quality outside the Daily Close scale', () => {
    const result = validateFocusSession({
      id: base.id,
      startedAt: base.startedAt,
      zone: base.zone,
      dayKey: base.dayKey,
      quality: 7,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('focus_quality_range');
  });

  it('refuses a negative interruption count', () => {
    const result = validateFocusSession({
      id: base.id,
      startedAt: base.startedAt,
      zone: base.zone,
      dayKey: base.dayKey,
      interruptions: -1,
    });
    expect(result.ok).toBe(false);
  });
});

describe('totalFocusMinutes', () => {
  it('counts only sessions that ended', () => {
    expect(totalFocusMinutes([session({}), session({ id: 'open', endedAt: null })])).toBe(120);
  });
});

describe('focusByHour', () => {
  it('attributes a session wholly to the hour it started in, in its own zone', () => {
    /* 03:30 UTC is 09:00 in Asia/Kolkata. A session filed under hour 3 would put
     * every Indian morning in the middle of the night. */
    const bands = focusByHour([session({})], hourInZone);
    expect(bands.find((band) => band.hour === 9)?.minutes).toBe(120);
    expect(bands.find((band) => band.hour === 3)?.minutes).toBe(0);
  });

  it('returns all twenty-four hours, so an empty hour is drawn as empty', () => {
    expect(focusByHour([], hourInZone)).toHaveLength(24);
  });

  it('does not spread a long session across the hours it spans', () => {
    const bands = focusByHour([session({ endedAt: '2026-08-30T07:30:00.000Z' })], hourInZone);
    expect(bands.find((band) => band.hour === 9)?.minutes).toBe(240);
    expect(bands.find((band) => band.hour === 10)?.minutes).toBe(0);
  });
});

describe('busiestHours', () => {
  it('excludes hours with nothing recorded', () => {
    const bands = focusByHour([session({})], hourInZone);
    expect(busiestHours(bands).map((band) => band.hour)).toEqual([9]);
  });
});
