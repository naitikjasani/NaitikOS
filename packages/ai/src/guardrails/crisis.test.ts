/**
 * §4.7's one permitted behaviour.
 *
 * Every test here is written from the asymmetry: a false positive costs one
 * dismissible screen, a false negative costs something without a price. Where a
 * test looks over-eager, that is the design and not an oversight.
 */

import { describe, expect, it } from 'vitest';

import { routeForReadings } from './crisis';

describe('crisis routing', () => {
  it('routes to the plan on two sustained severe days', () => {
    const routing = routeForReadings([
      { dayKey: '2026-12-01', mood: 1, anxiety: 4 },
      { dayKey: '2026-12-02', mood: 1, anxiety: 4 },
    ]);
    expect(routing.route).toBe('crisis_plan');
  });

  it('routes to the plan on sustained severe anxiety even with mood unrecorded', () => {
    const routing = routeForReadings([
      { dayKey: '2026-12-01', mood: null, anxiety: 5 },
      { dayKey: '2026-12-02', mood: null, anxiety: 5 },
    ]);
    expect(routing.route).toBe('crisis_plan');
  });

  it('does not treat an unlogged day as a zero', () => {
    /*
     * §8.9(3)'s "gaps are gaps" applies to a safety decision at least as
     * strongly as it does to a chart. A person who did not open the app is not
     * a person in crisis, and routing them to their own crisis plan on the
     * strength of an absence would teach them to ignore it.
     */
    const routing = routeForReadings([
      { dayKey: '2026-12-01', mood: 1, anxiety: null },
      { dayKey: '2026-12-02', mood: null, anxiety: null },
      { dayKey: '2026-12-03', mood: 4, anxiety: 2 },
    ]);
    /* The two most recent *recorded* days are the 1st and the 3rd, and the 3rd
     * is not severe. */
    expect(routing.route).toBe('model');
  });

  it('does not fire on a single severe day', () => {
    const routing = routeForReadings([
      { dayKey: '2026-12-01', mood: 3, anxiety: 3 },
      { dayKey: '2026-12-02', mood: 1, anxiety: 5 },
    ]);
    expect(routing.route).toBe('model');
  });

  it('does not fire before there is enough recorded to be sustained', () => {
    expect(routeForReadings([{ dayKey: '2026-12-02', mood: 1, anxiety: 5 }]).route).toBe('model');
    expect(routeForReadings([]).route).toBe('model');
  });

  it('reads the most recent days regardless of the order it is handed', () => {
    const routing = routeForReadings([
      { dayKey: '2026-11-01', mood: 4, anxiety: 1 },
      { dayKey: '2026-12-02', mood: 1, anxiety: 1 },
      { dayKey: '2026-12-01', mood: 1, anxiety: 1 },
    ]);
    expect(routing.route).toBe('crisis_plan');
    if (routing.route !== 'crisis_plan') return;
    expect([...routing.dayKeys].sort()).toEqual(['2026-12-01', '2026-12-02']);
  });
});
