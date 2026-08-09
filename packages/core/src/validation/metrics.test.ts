import { describe, expect, it } from 'vitest';

import {
  CAPTURE_LATENCY_BUDGET_MS,
  captureLatency,
  closeFunnel,
  correctionRate,
  derivedFactRatio,
  detectGaming,
  distributionOf,
  foregroundMinutesByDay,
  timeInApp,
} from './metrics';

describe('distributionOf', () => {
  it('is empty rather than zero for no samples', () => {
    expect(distributionOf([])).toMatchObject({ count: 0, p50: null, p90: null });
  });

  it('uses nearest-rank, so every percentile is a measured value', () => {
    const values = [10, 20, 30, 40];
    const distribution = distributionOf(values);
    expect(values).toContain(distribution.p50);
    expect(values).toContain(distribution.p90);
    expect(distribution.p50).toBe(20);
    expect(distribution.p90).toBe(40);
  });

  it('sorts before it selects', () => {
    expect(distributionOf([50, 10, 30]).p50).toBe(30);
  });

  it('drops non-finite samples', () => {
    expect(distributionOf([10, Number.NaN, 30, Number.POSITIVE_INFINITY]).count).toBe(2);
  });
});

describe('captureLatency', () => {
  it('is unknown with no captures, never a passing zero', () => {
    const metric = captureLatency([]);
    expect(metric.status).toBe('unknown');
    expect(metric.value).toBeNull();
  });

  it('reports within budget with the sample size attached', () => {
    const metric = captureLatency([1200, 1800, 2400]);
    expect(metric.status).toBe('within');
    expect(metric.n).toBe(3);
    expect(metric.sentence).toContain('over 3 captures');
    expect(metric.sentence).toContain('budget of 5.0 s');
  });

  it('reports over budget at the §1.4 bound', () => {
    expect(captureLatency([CAPTURE_LATENCY_BUDGET_MS]).status).toBe('within');
    expect(captureLatency([CAPTURE_LATENCY_BUDGET_MS + 1]).status).toBe('over');
  });
});

describe('timeInApp', () => {
  it('flags the counter-metric over its ceiling', () => {
    expect(timeInApp([4, 5, 6]).status).toBe('within');
    expect(timeInApp([8, 9, 12]).status).toBe('over');
  });

  it('is unknown with no measured days', () => {
    expect(timeInApp([]).status).toBe('unknown');
  });
});

describe('correctionRate', () => {
  it('is unknown at 0/0 rather than a passing zero', () => {
    expect(correctionRate(0, 0).status).toBe('unknown');
  });

  it('checks against the §1.4 ceiling', () => {
    expect(correctionRate(1000, 20).status).toBe('within');
    expect(correctionRate(1000, 21).status).toBe('over');
  });

  it('states both counts, not only the percentage', () => {
    expect(correctionRate(500, 5).sentence).toContain('5 of 500');
  });
});

describe('derivedFactRatio', () => {
  it('is context rather than a verdict while imports do not exist', () => {
    const metric = derivedFactRatio({ manual: 90, derived: 10 });
    expect(metric.value).toBeCloseTo(0.1, 10);
    // Not `over`: this is the one §1.4 metric where higher is better, and a red
    // bar for six months would train the operator to ignore the dashboard.
    expect(metric.status).toBe('unknown');
    expect(metric.sentence).toContain('day-180 figure');
  });

  it('is unknown with no observations', () => {
    expect(derivedFactRatio({}).value).toBeNull();
  });

  it('counts everything that is not manual as derived', () => {
    expect(derivedFactRatio({ manual: 0, import: 4, derivation: 6 }).value).toBe(1);
  });
});

describe('foregroundMinutesByDay', () => {
  const base = Date.UTC(2026, 8, 1, 8, 0, 0);

  function event(dayKey: string, minutesAfterBase: number) {
    return { dayKey, atMillis: base + minutesAfterBase * 60_000 };
  }

  it('sums the spans inside a session', () => {
    const minutes = foregroundMinutesByDay([
      event('2026-09-01', 0),
      event('2026-09-01', 2),
      event('2026-09-01', 3),
    ]);
    expect(minutes.get('2026-09-01')).toBeCloseTo(3, 6);
  });

  it('does not count the gap between two sessions', () => {
    const minutes = foregroundMinutesByDay([
      event('2026-09-01', 0),
      event('2026-09-01', 2),
      // Ninety minutes later — a different session.
      event('2026-09-01', 92),
      event('2026-09-01', 94),
    ]);
    expect(minutes.get('2026-09-01')).toBeCloseTo(4, 6);
  });

  it('records zero for a single-transition session — a known understatement', () => {
    const minutes = foregroundMinutesByDay([event('2026-09-01', 0)]);
    expect(minutes.get('2026-09-01')).toBe(0);
  });

  it('keeps days separate', () => {
    const minutes = foregroundMinutesByDay([
      event('2026-09-01', 0),
      event('2026-09-01', 4),
      event('2026-09-02', 1440),
      event('2026-09-02', 1442),
    ]);
    expect(minutes.get('2026-09-01')).toBeCloseTo(4, 6);
    expect(minutes.get('2026-09-02')).toBeCloseTo(2, 6);
  });

  it('sorts before it measures', () => {
    const ordered = foregroundMinutesByDay([event('2026-09-01', 0), event('2026-09-01', 3)]);
    const shuffled = foregroundMinutesByDay([event('2026-09-01', 3), event('2026-09-01', 0)]);
    expect(shuffled.get('2026-09-01')).toBe(ordered.get('2026-09-01'));
  });

  it('ignores a non-finite timestamp', () => {
    const minutes = foregroundMinutesByDay([
      { dayKey: '2026-09-01', atMillis: Number.NaN },
      event('2026-09-01', 0),
      event('2026-09-01', 1),
    ]);
    expect(minutes.get('2026-09-01')).toBeCloseTo(1, 6);
  });
});

describe('closeFunnel', () => {
  it('reports abandonment as a fact about the form', () => {
    const funnel = closeFunnel(10, 7);
    expect(funnel.abandoned).toBe(3);
    expect(funnel.rate).toBeCloseTo(0.7, 10);
    expect(funnel.sentence).toBe('The Close was opened 10 times and submitted 7. 3 were opened and left.');
    // No second person, no "you", no verdict about the operator.
    expect(funnel.sentence).not.toMatch(/\byou\b/iu);
  });

  it('says so plainly when nothing was left', () => {
    expect(closeFunnel(5, 5).sentence).toContain('submitted every time');
  });

  it('has no rate when the Close was never opened', () => {
    expect(closeFunnel(0, 0).rate).toBeNull();
  });

  it('never reports a rate above 1', () => {
    // A submit whose `started` event was lost offline.
    expect(closeFunnel(3, 4).rate).toBe(1);
    expect(closeFunnel(3, 4).abandoned).toBe(0);
  });
});

describe('detectGaming — §1.5’s anti-goal', () => {
  it('fires when Compounding Days and latency both rise', () => {
    const verdict = detectGaming({
      compoundingDaysNow: 26,
      compoundingDaysBefore: 20,
      latencyP50Now: 7000,
      latencyP50Before: 3000,
      timeInAppNow: null,
      timeInAppBefore: null,
    });
    expect(verdict.gamed).toBe(true);
    expect(verdict.sentence).toContain('§1.5');
  });

  it('fires on the counter-metric too', () => {
    const verdict = detectGaming({
      compoundingDaysNow: 26,
      compoundingDaysBefore: 20,
      latencyP50Now: 3000,
      latencyP50Before: 3000,
      timeInAppNow: 9,
      timeInAppBefore: 4,
    });
    expect(verdict.gamed).toBe(true);
  });

  it('does not fire when the ritual got cheaper', () => {
    expect(
      detectGaming({
        compoundingDaysNow: 26,
        compoundingDaysBefore: 20,
        latencyP50Now: 2000,
        latencyP50Before: 3000,
        timeInAppNow: 3,
        timeInAppBefore: 5,
      }).gamed,
    ).toBe(false);
  });

  it('does not fire on a small wobble', () => {
    expect(
      detectGaming({
        compoundingDaysNow: 26,
        compoundingDaysBefore: 25,
        latencyP50Now: 3050,
        latencyP50Before: 3000,
        timeInAppNow: 4.1,
        timeInAppBefore: 4,
      }).gamed,
    ).toBe(false);
  });

  it('does not fire without both windows populated', () => {
    expect(
      detectGaming({
        compoundingDaysNow: 26,
        compoundingDaysBefore: 20,
        latencyP50Now: 9000,
        latencyP50Before: null,
        timeInAppNow: null,
        timeInAppBefore: null,
      }).gamed,
    ).toBe(false);
  });

  it('does not fire when Compounding Days fell', () => {
    expect(
      detectGaming({
        compoundingDaysNow: 15,
        compoundingDaysBefore: 20,
        latencyP50Now: 9000,
        latencyP50Before: 3000,
        timeInAppNow: null,
        timeInAppBefore: null,
      }).gamed,
    ).toBe(false);
  });
});
