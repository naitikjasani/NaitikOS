import { describe, expect, it } from 'vitest';

import {
  bandPath,
  dataExtent,
  formatTick,
  linePath,
  linearScale,
  niceStep,
  placePoints,
  plotBox,
  resolveXDomain,
  resolveYDomain,
} from './scales';
import type { Series } from './types';

function series(points: Series['points'], overrides: Partial<Series> = {}): Series {
  return { id: 's1', label: 'Series', slot: 1, points, ...overrides };
}

describe('niceStep', () => {
  it('rounds up to a step a person reads without effort', () => {
    expect(niceStep(0.9)).toBe(1);
    expect(niceStep(1.5)).toBe(2);
    expect(niceStep(2.3)).toBe(2.5);
    expect(niceStep(4)).toBe(5);
    expect(niceStep(7)).toBe(10);
    expect(niceStep(120)).toBe(200);
    expect(niceStep(0.03)).toBe(0.05);
  });

  it('survives inputs that would otherwise produce Infinity', () => {
    expect(niceStep(0)).toBe(1);
    expect(niceStep(-5)).toBe(1);
    expect(niceStep(Number.NaN)).toBe(1);
  });
});

describe('resolveYDomain', () => {
  /**
   * §8.9(1): "An unlabelled truncated axis is a lie told in a health
   * application." There is no way to get a truncated axis out of this function
   * without `isTruncated` coming back true — the renderer draws the break from
   * the flag, not from a prop someone might forget.
   */
  it('reports truncation whenever the axis excludes zero', () => {
    const weight = series([
      { at: '2026-08-01', value: 74 },
      { at: '2026-08-02', value: 76 },
    ]);

    const truncated = resolveYDomain([weight], { zeroBaseline: false });
    expect(truncated.isTruncated).toBe(true);
    expect(truncated.min).toBeGreaterThan(0);

    const honest = resolveYDomain([weight], { zeroBaseline: true });
    expect(honest.isTruncated).toBe(false);
    expect(honest.min).toBe(0);
  });

  it('does not badge a domain that happens to contain zero', () => {
    const spanning = series([
      { at: '2026-08-01', value: -2 },
      { at: '2026-08-02', value: 5 },
    ]);
    expect(resolveYDomain([spanning], { zeroBaseline: false }).isTruncated).toBe(false);
  });

  it('includes band bounds, so a band is never drawn off the axis', () => {
    const banded = series([
      { at: '2026-08-01', value: 74, lower: 70, upper: 78 },
      { at: '2026-08-02', value: 75, lower: 71, upper: 79 },
    ]);
    const domain = resolveYDomain([banded], { zeroBaseline: false });
    expect(domain.min).toBeLessThanOrEqual(70);
    expect(domain.max).toBeGreaterThanOrEqual(79);
  });

  it('gives a flat series a legible axis instead of dividing by zero', () => {
    const flat = series([
      { at: '2026-08-01', value: 74 },
      { at: '2026-08-02', value: 74 },
    ]);
    const domain = resolveYDomain([flat], { zeroBaseline: false });
    expect(domain.max).toBeGreaterThan(domain.min);
    expect(domain.ticks.every((tick) => Number.isFinite(tick))).toBe(true);
  });

  it('produces ticks free of floating-point noise', () => {
    const small = series([
      { at: '2026-08-01', value: 0 },
      { at: '2026-08-02', value: 0.3 },
    ]);
    for (const tick of resolveYDomain([small], { zeroBaseline: true }).ticks) {
      expect(String(tick)).not.toContain('000000');
    }
  });

  it('honours an explicit min and max', () => {
    const domain = resolveYDomain([series([{ at: '2026-08-01', value: 5 }])], {
      zeroBaseline: false,
      min: 0,
      max: 10,
    });
    expect(domain.min).toBe(0);
    expect(domain.max).toBe(10);
  });
});

describe('dataExtent', () => {
  it('is null when there is nothing finite to measure', () => {
    expect(dataExtent([])).toBeNull();
    expect(dataExtent([series([{ at: '2026-08-01', value: null }])])).toBeNull();
    expect(dataExtent([series([{ at: '2026-08-01', value: Number.NaN }])])).toBeNull();
  });
});

describe('resolveXDomain', () => {
  it('spans the days present, ignoring malformed keys', () => {
    const domain = resolveXDomain([
      series([
        { at: '2026-08-01', value: 1 },
        { at: 'nonsense', value: 2 },
        { at: '2026-08-31', value: 3 },
      ]),
    ]);
    expect(domain.max - domain.min).toBe(30);
    expect(domain.ticks.length).toBeGreaterThan(1);
  });

  it('flags a range that crosses a year, so labels can carry one', () => {
    expect(
      resolveXDomain([
        series([
          { at: '2025-12-01', value: 1 },
          { at: '2026-03-01', value: 2 },
        ]),
      ]).spansYears,
    ).toBe(true);
  });

  it('gives a single-day series a width rather than dividing by zero', () => {
    const domain = resolveXDomain([series([{ at: '2026-08-01', value: 1 }])]);
    expect(domain.max).toBeGreaterThan(domain.min);
  });

  it('degrades to a usable domain when nothing is placeable', () => {
    expect(resolveXDomain([series([{ at: 'total', value: 1 }])])).toEqual({
      min: 0,
      max: 1,
      ticks: [],
      spansYears: false,
    });
  });
});

describe('linearScale', () => {
  it('maps the domain onto the range', () => {
    const scale = linearScale({ min: 0, max: 10 }, 0, 100);
    expect(scale(0)).toBe(0);
    expect(scale(5)).toBe(50);
    expect(scale(10)).toBe(100);
  });

  it('inverts when the range does', () => {
    const scale = linearScale({ min: 0, max: 10 }, 100, 0);
    expect(scale(0)).toBe(100);
    expect(scale(10)).toBe(0);
  });

  it('returns the midpoint for a zero-width domain instead of NaN', () => {
    expect(linearScale({ min: 5, max: 5 }, 0, 100)(5)).toBe(50);
  });
});

describe('linePath', () => {
  const x = linearScale({ min: 0, max: 4 }, 0, 400);
  const y = linearScale({ min: 0, max: 10 }, 100, 0);

  /**
   * §8.9(3): "Gaps are gaps. Lines break. Interpolation across a week of no
   * data is fabrication." A gap starts a new subpath — the `M` in the middle
   * of the path is the whole test.
   */
  it('breaks the line at a gap rather than drawing through it', () => {
    const placed = placePoints(
      [
        { at: '1970-01-01', value: 1 },
        { at: '1970-01-02', value: 2 },
        { at: '1970-01-03', value: null },
        { at: '1970-01-04', value: 4 },
        { at: '1970-01-05', value: 5 },
      ],
      x,
      y,
    );

    const path = linePath(placed);
    // Two subpaths: one before the gap, one after.
    expect(path.match(/M/g)).toHaveLength(2);
  });

  it('is empty when nothing can be placed', () => {
    expect(linePath([null, null])).toBe('');
    expect(linePath(placePoints([{ at: 'total', value: 1 }], x, y))).toBe('');
  });
});

describe('bandPath', () => {
  const x = linearScale({ min: 0, max: 4 }, 0, 400);
  const y = linearScale({ min: 0, max: 10 }, 100, 0);

  it('closes one shape per contiguous run', () => {
    const path = bandPath(
      [
        { at: '1970-01-01', value: 1, lower: 0, upper: 2 },
        { at: '1970-01-02', value: 2, lower: 1, upper: 3 },
        { at: '1970-01-03', value: null },
        { at: '1970-01-04', value: 4, lower: 3, upper: 5 },
        { at: '1970-01-05', value: 5, lower: 4, upper: 6 },
      ],
      x,
      y,
    );
    // Two closed shapes, not one polygon spanning the gap.
    expect(path.match(/Z/g)).toHaveLength(2);
  });

  it('draws nothing for points with no band', () => {
    expect(bandPath([{ at: '1970-01-01', value: 1 }], x, y)).toBe('');
  });

  it('draws nothing for a run of one, which has no area', () => {
    expect(bandPath([{ at: '1970-01-01', value: 1, lower: 0, upper: 2 }], x, y)).toBe('');
  });
});

describe('plotBox', () => {
  it('never produces a negative plot area, however narrow the container', () => {
    const box = plotBox(10, 10);
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(0);
  });
});

describe('formatTick', () => {
  it('matches the axis precision and separates thousands', () => {
    expect(formatTick(1250, 250)).toBe('1,250');
    expect(formatTick(0.25, 0.05)).toBe('0.25');
    expect(formatTick(1, 1)).toBe('1');
  });

  /**
   * The defect this guards. A `2.5` step is `>= 1`, so a magnitude test gives
   * it zero decimals — and a 72.5 / 75 / 77.5 axis then labels itself 73, 75,
   * 78. Two of the three ticks are wrong, and `2.5` is exactly the step a
   * bodyweight axis picks.
   */
  it('keeps the half on a 2.5 step', () => {
    expect(formatTick(72.5, 2.5)).toBe('72.5');
    expect(formatTick(75, 2.5)).toBe('75.0');
    expect(formatTick(77.5, 2.5)).toBe('77.5');
  });
});
