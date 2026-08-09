import { describe, expect, it } from 'vitest';

import type { SkinStateInput } from './state';
import { MAX_LESION_COUNT, isBodyRegion, planSkinState, regionTrends } from './state';

function input(overrides: Partial<SkinStateInput> = {}): SkinStateInput {
  return {
    id: 'ss-1',
    observedOn: '2026-08-24',
    zone: 'Asia/Kolkata',
    observedAt: '2026-08-24T02:30:00.000Z',
    ...overrides,
  };
}

function unwrap(result: ReturnType<typeof planSkinState>) {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}`);
  return result.value;
}

describe('planSkinState', () => {
  it('accepts a day with only a region measured', () => {
    const planned = unwrap(
      planSkinState(input({ regions: [{ id: 'r1', region: 'chest', activeLesionCount: 6 }] })),
    );
    expect(planned.state.overallState).toBeNull();
    expect(planned.observations).toHaveLength(1);
    expect(planned.observations[0]).toMatchObject({
      metricKey: 'body.skin.lesion_count',
      value: { kind: 'integer', value: 6 },
      subject: { type: 'skin_region_state', id: 'r1' },
      context: { region: 'chest' },
    });
  });

  it('writes the overall state and each region state', () => {
    const planned = unwrap(
      planSkinState(
        input({
          overallState: 3,
          regions: [
            { id: 'r1', region: 'face', state: 4 },
            { id: 'r2', region: 'chest', state: 2, activeLesionCount: 11 },
          ],
        }),
      ),
    );
    expect(planned.observations.map((o) => o.metricKey)).toEqual([
      'body.skin.state',
      'body.skin.region.state',
      'body.skin.region.state',
      'body.skin.lesion_count',
    ]);
  });

  it('keeps a flare as the operator’s annotation', () => {
    const planned = unwrap(planSkinState(input({ isFlare: true, suspectedTrigger: '  whey  ' })));
    expect(planned.state.isFlare).toBe(true);
    expect(planned.state.suspectedTrigger).toBe('whey');
  });

  it('does not write scarring, inflammation, dryness or oiliness as observations', () => {
    // They are region-row detail. None is in the metric registry, and §9.2
    // rejects unregistered keys on write.
    const planned = unwrap(
      planSkinState(
        input({
          regions: [{ id: 'r1', region: 'face', scarringLevel: 3, inflammation: 2, dryness: 4, oiliness: 1 }],
        }),
      ),
    );
    expect(planned.observations).toEqual([]);
    expect(planned.state.regions[0]).toMatchObject({ scarringLevel: 3, oiliness: 1 });
  });

  it.each([
    ['skin_day_invalid', input({ observedOn: '24-08-2026' })],
    ['skin_zone_invalid', input({ zone: 'IST' })],
    ['skin_state_range', input({ overallState: 6 })],
    ['skin_region_unknown', input({ regions: [{ id: 'r', region: 'elbow' }] })],
    ['skin_region_range', input({ regions: [{ id: 'r', region: 'face', state: 0 }] })],
    [
      'skin_lesion_range',
      input({ regions: [{ id: 'r', region: 'face', activeLesionCount: MAX_LESION_COUNT + 1 }] }),
    ],
    [
      'skin_region_duplicate',
      input({
        regions: [
          { id: 'r1', region: 'face', state: 3 },
          { id: 'r2', region: 'face', state: 4 },
        ],
      }),
    ],
  ])('rejects with %s', (code, candidate) => {
    const result = planSkinState(candidate);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(code);
  });

  it('supersedes what was already recorded for the day rather than adding to it', () => {
    // §9.1: corrections are supersessions. Without this, `mean` aggregation
    // would average the mistake with the correction.
    const planned = unwrap(
      planSkinState(
        input({
          overallState: 4,
          regions: [{ id: 'r1', region: 'face', state: 3 }],
          existing: [
            { id: 'obs-overall', metricKey: 'body.skin.state', subjectId: 'ss-1' },
            { id: 'obs-face', metricKey: 'body.skin.region.state', subjectId: 'r1' },
            { id: 'obs-other-day', metricKey: 'body.skin.state', subjectId: 'ss-other' },
          ],
        }),
      ),
    );

    expect(planned.observations[0]?.supersedes).toEqual({
      id: 'obs-overall',
      reason: 'skin_state_revised',
    });
    expect(planned.observations[1]?.supersedes).toEqual({ id: 'obs-face', reason: 'skin_state_revised' });
  });

  it('supersedes nothing on a first log of the day', () => {
    const planned = unwrap(planSkinState(input({ overallState: 3 })));
    expect(planned.observations[0]?.supersedes).toBeUndefined();
  });

  it('accepts zero lesions, which is a real measurement', () => {
    const planned = unwrap(
      planSkinState(input({ regions: [{ id: 'r1', region: 'back', activeLesionCount: 0 }] })),
    );
    expect(planned.observations[0]?.value).toEqual({ kind: 'integer', value: 0 });
  });
});

describe('regionTrends', () => {
  it('carries the recorded-day count alongside every mean', () => {
    const first = unwrap(
      planSkinState(input({ id: 'a', observedOn: '2026-08-20', regions: [{ id: 'r1', region: 'face', state: 2 }] })),
    ).state;
    const second = unwrap(
      planSkinState(
        input({
          id: 'b',
          observedOn: '2026-08-21',
          regions: [
            { id: 'r2', region: 'face', state: 4, activeLesionCount: 3 },
            { id: 'r3', region: 'chest', state: 5 },
          ],
        }),
      ),
    ).state;

    const trends = regionTrends([second, first]);
    const face = trends.find((trend) => trend.region === 'face');

    expect(face).toMatchObject({ recordedDays: 2, meanState: 3, latestState: 4, latestLesionCount: 3 });
    expect(trends.find((trend) => trend.region === 'chest')?.recordedDays).toBe(1);
  });

  it('has no mean for a region that was only ever counted, never rated', () => {
    const state = unwrap(
      planSkinState(input({ regions: [{ id: 'r1', region: 'back', activeLesionCount: 4 }] })),
    ).state;
    const trend = regionTrends([state])[0];
    expect(trend?.meanState).toBeNull();
    expect(trend?.latestLesionCount).toBe(4);
  });

  it('is empty for no days', () => {
    expect(regionTrends([])).toEqual([]);
  });
});

describe('isBodyRegion', () => {
  it('matches the schema enum', () => {
    expect(isBodyRegion('face')).toBe(true);
    expect(isBodyRegion('knee')).toBe(false);
  });
});
