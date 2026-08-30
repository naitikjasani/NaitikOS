import { describe, expect, it } from 'vitest';

import type { AdherenceDay, AdherenceSeries } from './adherence';
import type { StreakSeries } from './streak';
import { shiftDayKey } from '../temporal/instant';
import { BASELINE_DAYS, CORRELATION_PAIRS, PRE_REGISTERED, baselineState, runBattery } from './battery';

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

  it('promotes it to confirmed once a previous run held the same signature', () => {
    const input = {
      dayKey: TODAY,
      daysOfHistory: 120,
      adherence: [droppingSeries('medication:a', 4)],
      streaks: [] as StreakSeries[],
    };
    const first = runBattery(input);
    /*
     * A *different* day, which is what the nightly job passes. Rerunning with
     * the same day would pass while the control was inoperative — a finding's
     * id contains the day key, so two consecutive nights produce two different
     * ids and a comparison on ids matches nothing.
     */
    const second = runBattery({
      ...input,
      dayKey: '2026-11-16',
      heldSignatures: first.held.map((finding) => finding.signature),
    });

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
    const second = runBattery({
      ...input,
      dayKey: '2026-11-16',
      heldSignatures: first.held.map((finding) => finding.signature),
    });
    const order = second.surfaced.map((finding) => finding.confidence);
    expect(order[0]).toBe('confirmed');
    expect(order.slice(1).every((confidence) => confidence === 'descriptive')).toBe(true);
  });

  it('is inert with nothing to look at', () => {
    const outcome = runBattery({ dayKey: TODAY, daysOfHistory: 400, adherence: [], streaks: [] });
    expect(outcome).toMatchObject({ surfaced: [], held: [], discarded: [], comparisons: 0, fdrThreshold: null });
  });
});

/* -------------------------------------------------------------------------
 * Correlation in the battery — where the five controls interact
 * ---------------------------------------------------------------------- */

describe('battery with correlation', () => {
  const PAIR = {
    id: 'test.pair',
    x: 'metric.x',
    y: 'metric.y',
    mechanism: 'A declared mechanism, so control 3 is satisfied by construction in this test.',
    provenance: 'pre_registered' as const,
  };

  function series(metricKey: string, label: string, values: readonly number[]) {
    return {
      metricKey,
      label,
      points: values.map((value, index) => ({ dayKey: shiftDayKey('2026-01-01', index) ?? '2026-01-01', value })),
    };
  }

  function relatedSeries(n: number) {
    const xs = Array.from({ length: n }, (_, index) => 5 + ((index * 3) % 5));
    return [series('metric.x', 'X', xs), series('metric.y', 'Y', xs.map((v, i) => v * 2 + (i % 2)))];
  }

  it('holds a correlation on first detection and surfaces it on the second', () => {
    /*
     * §10.6 control 4, end to end: "A correlation is not surfaced on first
     * detection. It is held, and re-tested against subsequent data." This
     * single rule eliminates the large majority of spurious findings, and it is
     * the one most easily broken by an innocent refactor of the id.
     */
    const input = {
      dayKey: '2026-06-01',
      daysOfHistory: 200,
      adherence: [],
      streaks: [],
      series: relatedSeries(120),
      pairs: [PAIR],
    };

    const first = runBattery(input);
    expect(first.surfaced).toHaveLength(0);
    expect(first.held).toHaveLength(1);

    /*
     * **A different day key**, which is what the nightly job actually passes.
     *
     * An earlier version of this test reran with the same day and passed while
     * the control was inoperative: a finding's id contains the day key, so two
     * consecutive nights produce two different ids and a comparison on ids
     * matches nothing. Every inferential finding would have been held forever
     * and the inbox would have stayed empty, indistinguishable from a system
     * with nothing to say.
     */
    const second = runBattery({
      ...input,
      dayKey: '2026-06-02',
      heldSignatures: first.held.map((f) => f.signature),
    });
    expect(second.surfaced).toHaveLength(1);
    expect(second.surfaced[0]?.confidence).toBe('confirmed');
    /* And the two nights are distinct rows, which is what `id` is for. */
    expect(second.surfaced[0]?.id).not.toBe(first.held[0]?.id);
    expect(second.surfaced[0]?.signature).toBe(first.held[0]?.signature);
  });

  it('counts the correlation in the same FDR correction as everything else', () => {
    /*
     * §10.6 control 2: "Benjamini–Hochberg across the full nightly detector
     * battery, **not per-detector**." A correlation tested in its own family
     * would be cheaper than one tested alongside adherence, which is exactly
     * the accounting the control exists to prevent.
     */
    const outcome = runBattery({
      dayKey: '2026-06-01',
      daysOfHistory: 200,
      adherence: [],
      streaks: [],
      series: relatedSeries(120),
      pairs: [PAIR],
    });

    expect(outcome.comparisons).toBeGreaterThan(0);
  });

  it('suppresses correlations entirely before day 60', () => {
    const outcome = runBattery({
      dayKey: '2026-02-15',
      daysOfHistory: 45,
      adherence: [],
      streaks: [],
      series: relatedSeries(120),
      pairs: [PAIR],
    });

    expect(outcome.surfaced).toHaveLength(0);
    expect(outcome.held).toHaveLength(0);
    expect(outcome.insufficient.some((entry) => entry.detector === 'correlation')).toBe(true);
  });

  it('skips a pair whose metrics are not recorded, silently', () => {
    /*
     * A metric the operator does not record is not a gap in their data; it is a
     * module they do not use. Reporting it nightly would be the system asking
     * for more logging, which P6 rules out.
     */
    const outcome = runBattery({
      dayKey: '2026-06-01',
      daysOfHistory: 200,
      adherence: [],
      streaks: [],
      series: [],
      pairs: [PAIR],
    });

    expect(outcome.insufficient).toHaveLength(0);
    expect(outcome.surfaced).toHaveLength(0);
  });

  it('registers every pair with a mechanism worth arguing with', () => {
    /* Control 3's real test: "these are both numbers I have" is not a
     * mechanism, and a short registry is what keeps the FDR correction from
     * punishing the pairs that matter. */
    for (const pair of CORRELATION_PAIRS) {
      expect(pair.mechanism.length).toBeGreaterThan(60);
      expect(pair.provenance).toBe('pre_registered');
    }
    expect(CORRELATION_PAIRS.length).toBeLessThanOrEqual(10);
  });
});
