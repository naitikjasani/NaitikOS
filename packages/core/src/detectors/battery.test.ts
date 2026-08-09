import { describe, expect, it } from 'vitest';

import type { AdherenceDay, AdherenceSeries } from './adherence';
import type { StreakSeries } from './streak';
import { BASELINE_DAYS, PRE_REGISTERED, baselineState, runBattery } from './battery';

function days(count: number, completed: number, offset = 0): AdherenceDay[] {
  return Array.from({ length: count }, (_, index) => ({
    dayKey: `d${String(offset + index).padStart(4, '0')}`,
    expected: 1,
    completed: index < completed ? 1 : 0,
    recorded: true,
  }));
}

function droppingSeries(subject: string, recentCompleted: number): AdherenceSeries {
  return {
    subject,
    label: subject,
    kind: 'medication',
    days: [...days(60, 59), ...days(14, recentCompleted, 60)],
  };
}

const TODAY = '2026-08-24';

describe('baselineState', () => {
  it('is closed before day 60 and says how long is left', () => {
    const state = baselineState(45);
    expect(state.inferentialAllowed).toBe(false);
    expect(state.daysRemaining).toBe(15);
    expect(state.message).toContain('15 to go');
    expect(state.message).toContain('Counts are shown throughout');
  });

  it('opens exactly at the boundary', () => {
    expect(baselineState(BASELINE_DAYS).inferentialAllowed).toBe(true);
    expect(baselineState(BASELINE_DAYS - 1).inferentialAllowed).toBe(false);
  });

  it('copes with nonsense input', () => {
    expect(baselineState(Number.NaN).daysOfHistory).toBe(0);
    expect(baselineState(-5).daysOfHistory).toBe(0);
  });
});

describe('PRE_REGISTERED', () => {
  it('declares a mechanism for every eligible hypothesis (§10.6 control 3)', () => {
    expect(PRE_REGISTERED.length).toBeGreaterThan(0);
    for (const hypothesis of PRE_REGISTERED) {
      expect(hypothesis.mechanism.length).toBeGreaterThan(20);
    }
  });
});

describe('runBattery', () => {
  it('surfaces descriptive findings before day 60 and no inferential ones', () => {
    const outcome = runBattery({
      dayKey: TODAY,
      daysOfHistory: 20,
      adherence: [droppingSeries('medication:a', 5)],
      streaks: [],
    });

    expect(outcome.baseline.inferentialAllowed).toBe(false);
    expect(outcome.surfaced.length).toBeGreaterThan(0);
    expect(outcome.surfaced.every((finding) => finding.confidence === 'descriptive')).toBe(true);
    expect(outcome.held).toEqual([]);
    expect(outcome.comparisons).toBe(0);
  });

  it('holds an inferential finding on first detection rather than surfacing it', () => {
    const outcome = runBattery({
      dayKey: TODAY,
      daysOfHistory: 120,
      adherence: [droppingSeries('medication:a', 4)],
      streaks: [],
    });

    expect(outcome.held).toHaveLength(1);
    expect(outcome.held[0]?.confidence).toBe('exploratory');
    expect(outcome.surfaced.every((finding) => finding.pValue === null)).toBe(true);
  });

  it('promotes it to confirmed once a previous run held the same id', () => {
    const input = {
      dayKey: TODAY,
      daysOfHistory: 120,
      adherence: [droppingSeries('medication:a', 4)],
      streaks: [] as StreakSeries[],
    };
    const first = runBattery(input);
    const second = runBattery({ ...input, heldFindingIds: first.held.map((finding) => finding.id) });

    expect(second.held).toEqual([]);
    const confirmed = second.surfaced.find((finding) => finding.confidence === 'confirmed');
    expect(confirmed).toBeDefined();
    expect(confirmed?.pValue ?? 1).toBeLessThan(0.01);
  });

  it('applies the correction across the whole battery, not per detector', () => {
    // One genuine drop among many series that are merely a little below their
    // baseline. Without a battery-wide correction the marginal ones survive.
    const marginal = Array.from({ length: 40 }, (_, index) => droppingSeries(`medication:m${String(index)}`, 13));
    const outcome = runBattery({
      dayKey: TODAY,
      daysOfHistory: 120,
      adherence: [droppingSeries('medication:real', 3), ...marginal],
      streaks: [],
    });

    expect(outcome.comparisons).toBe(41);
    expect(outcome.discarded.length).toBeGreaterThan(0);
    expect(outcome.held.map((finding) => finding.subject)).toEqual(['medication:real']);
  });

  it('keeps discarded findings so the comparison count is auditable', () => {
    const outcome = runBattery({
      dayKey: TODAY,
      daysOfHistory: 120,
      adherence: Array.from({ length: 30 }, (_, index) => droppingSeries(`medication:m${String(index)}`, 13)),
      streaks: [],
    });
    expect(outcome.discarded.length + outcome.held.length).toBe(outcome.comparisons);
  });

  it('collects insufficient-data reports from every detector', () => {
    const outcome = runBattery({
      dayKey: TODAY,
      daysOfHistory: 5,
      adherence: [{ subject: 'medication:a', label: 'A', kind: 'medication', days: days(2, 2) }],
      streaks: [{ subject: 'routine:r', label: 'r', days: [{ dayKey: '2026-08-01', complete: true }] }],
    });
    expect(outcome.insufficient.map((item) => item.detector).sort()).toEqual(['adherence', 'streak']);
  });

  it('orders confirmed before exploratory before descriptive', () => {
    const input = {
      dayKey: TODAY,
      daysOfHistory: 120,
      adherence: [droppingSeries('medication:a', 4)],
      streaks: [] as StreakSeries[],
    };
    const first = runBattery(input);
    const second = runBattery({ ...input, heldFindingIds: first.held.map((finding) => finding.id) });
    const order = second.surfaced.map((finding) => finding.confidence);
    expect(order[0]).toBe('confirmed');
    expect(order.slice(1).every((confidence) => confidence === 'descriptive')).toBe(true);
  });

  it('is inert with nothing to look at', () => {
    const outcome = runBattery({ dayKey: TODAY, daysOfHistory: 400, adherence: [], streaks: [] });
    expect(outcome).toMatchObject({ surfaced: [], held: [], discarded: [], comparisons: 0, fdrThreshold: null });
  });
});
