import { describe, expect, it } from 'vitest';

import { GATE_REQUIRED_DAYS, evaluateGate, gateWindowDays } from './gate';

const WINDOW = { startDayKey: '2026-08-30', endDayKey: '2026-09-29' };

describe('evaluateGate', () => {
  it('derives the window from the dates, which are 31 days, not 30', () => {
    // §12 says "25 of 30" and dates the phase 30 August to 29 September, which
    // is thirty-one days inclusive. The dates win; see the note in gate.ts.
    expect(evaluateGate({ ...WINDOW, todayDayKey: '2026-09-29', closes: 0 }).windowDays).toBe(31);
  });

  it('passes the moment the threshold is met, even mid-window', () => {
    const gate = evaluateGate({ ...WINDOW, todayDayKey: '2026-09-25', closes: GATE_REQUIRED_DAYS });
    expect(gate.verdict).toBe('passed');
    expect(gate.shortfall).toBe(0);
    expect(gate.consequence).toContain('V2 begins in October');
  });

  it('is on track while there is margin to spare', () => {
    // Day 11 of 31, ten closed: 10 + 20 remaining = 30, five days of margin.
    const gate = evaluateGate({ ...WINDOW, todayDayKey: '2026-09-09', closes: 10 });
    expect(gate.verdict).toBe('on_track');
    expect(gate.daysRemaining).toBe(20);
    expect(gate.slack).toBe(5);
    expect(gate.sentence).toContain('5 days of margin');
  });

  it('is at risk when every remaining day is required', () => {
    // 21 closed, 4 remaining, 25 needed: exactly no room left.
    const gate = evaluateGate({ ...WINDOW, todayDayKey: '2026-09-25', closes: 21 });
    expect(gate.slack).toBe(0);
    expect(gate.verdict).toBe('at_risk');
    expect(gate.sentence).toContain('Every remaining day is now required');
  });

  it('says so as soon as the gate is arithmetically out of reach', () => {
    // 15 closed with 4 days left cannot reach 25.
    const gate = evaluateGate({ ...WINDOW, todayDayKey: '2026-09-25', closes: 15 });
    expect(gate.verdict).toBe('unreachable');
    expect(gate.slack).toBeLessThan(0);
    expect(gate.consequence).toContain('October is spent on capture friction');
  });

  it('reports the verdict after the window closes', () => {
    expect(evaluateGate({ ...WINDOW, todayDayKey: '2026-09-30', closes: 26 }).verdict).toBe('passed');

    const missed = evaluateGate({ ...WINDOW, todayDayKey: '2026-09-30', closes: 24 });
    expect(missed.verdict).toBe('missed');
    expect(missed.daysRemaining).toBe(0);
    expect(missed.consequence).toContain('graveyard of half-built modules');
  });

  it('carries the consequence on every verdict, not only on failure', () => {
    for (const closes of [0, 10, 25, 31]) {
      const gate = evaluateGate({ ...WINDOW, todayDayKey: '2026-09-15', closes });
      expect(gate.consequence.length).toBeGreaterThan(20);
    }
  });

  it('treats a day before the window as not started', () => {
    const gate = evaluateGate({ ...WINDOW, todayDayKey: '2026-08-01', closes: 0 });
    expect(gate.daysRemaining).toBe(31);
    expect(gate.verdict).toBe('on_track');
  });

  it('does not take the dashboard down on a malformed day key', () => {
    const gate = evaluateGate({ ...WINDOW, todayDayKey: 'not-a-day', closes: 4 });
    expect(gate.verdict).toBe('on_track');
    expect(gate.sentence).toBe('The validation window has not started.');
  });

  it('clamps a negative or fractional count', () => {
    expect(evaluateGate({ ...WINDOW, todayDayKey: '2026-09-15', closes: -3 }).closes).toBe(0);
    expect(evaluateGate({ ...WINDOW, todayDayKey: '2026-09-15', closes: 7.8 }).closes).toBe(7);
  });

  it('honours a custom threshold', () => {
    const gate = evaluateGate({ ...WINDOW, todayDayKey: '2026-09-15', closes: 5, required: 5 });
    expect(gate.verdict).toBe('passed');
  });
});

describe('gateWindowDays', () => {
  it('returns the window oldest first, ending on the given day', () => {
    const days = gateWindowDays('2026-09-29', 30);
    expect(days).toHaveLength(30);
    expect(days[0]).toBe('2026-08-31');
    expect(days.at(-1)).toBe('2026-09-29');
  });

  it('is empty for a malformed key', () => {
    expect(gateWindowDays('nope')).toEqual([]);
  });
});
