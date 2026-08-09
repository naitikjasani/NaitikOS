import { describe, expect, it } from 'vitest';

import type { AnxietyEpisode, EpisodeInput } from './episode';
import {
  EPISODE_SUBJECT_TYPE,
  MAX_EPISODE_MINUTES,
  episodeDurationMinutes,
  planEpisode,
  severityFor,
  summariseEpisodes,
} from './episode';

function input(overrides: Partial<EpisodeInput> = {}): EpisodeInput {
  return {
    id: 'ep-1',
    startedAt: '2026-08-24T09:00:00.000Z',
    zone: 'Asia/Kolkata',
    ...overrides,
  };
}

function unwrap(result: ReturnType<typeof planEpisode>) {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}`);
  return result.value;
}

describe('severityFor', () => {
  it('bands wide, because a five-point self-report does not support five classes', () => {
    expect(severityFor(1)).toBe('mild');
    expect(severityFor(2)).toBe('mild');
    expect(severityFor(3)).toBe('moderate');
    expect(severityFor(4)).toBe('severe');
    expect(severityFor(5)).toBe('severe');
  });

  it('is null for anything that is not an integer on the scale', () => {
    expect(severityFor(null)).toBeNull();
    expect(severityFor(undefined)).toBeNull();
    expect(severityFor(3.5)).toBeNull();
    expect(severityFor(9)).toBeNull();
  });
});

describe('planEpisode', () => {
  it('accepts an episode with nothing but a start time and a zone', () => {
    const planned = unwrap(planEpisode(input()));
    expect(planned.episode.intensity).toBeNull();
    expect(planned.episode.trigger).toBeNull();
    expect(planned.observations).toEqual([]);
  });

  it('writes the intensity as an observation subject-referenced to the episode', () => {
    const planned = unwrap(planEpisode(input({ intensity: 4 })));
    expect(planned.observations).toHaveLength(1);
    expect(planned.observations[0]).toMatchObject({
      metricKey: 'mind.anxiety',
      value: { kind: 'integer', value: 4 },
      subject: { type: EPISODE_SUBJECT_TYPE, id: 'ep-1' },
    });
    expect(planned.episode.severity).toBe('severe');
  });

  it('writes no observation when no intensity was given', () => {
    // §9.1 makes observations permanent; a placeholder would be permanent too.
    expect(unwrap(planEpisode(input({ intensity: null }))).observations).toEqual([]);
  });

  it('trims free text to null rather than storing whitespace', () => {
    const planned = unwrap(planEpisode(input({ trigger: '   ', copingResponse: '  box breathing ' })));
    expect(planned.episode.trigger).toBeNull();
    expect(planned.episode.copingResponse).toBe('box breathing');
  });

  it('rejects an end before the start', () => {
    const result = planEpisode(input({ endedAt: '2026-08-24T08:00:00.000Z' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('episode_ends_before_start');
  });

  it('rejects an episode longer than a day', () => {
    const result = planEpisode(input({ endedAt: '2026-08-26T09:00:00.000Z' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('episode_too_long');
  });

  it('accepts an episode exactly at the limit', () => {
    const planned = unwrap(planEpisode(input({ endedAt: '2026-08-25T09:00:00.000Z' })));
    expect(episodeDurationMinutes(planned.episode)).toBe(MAX_EPISODE_MINUTES);
  });

  it.each([
    ['episode_started_at_invalid', input({ startedAt: 'yesterday' })],
    ['episode_zone_invalid', input({ zone: 'IST' })],
    ['episode_ended_at_invalid', input({ endedAt: 'later' })],
    ['episode_intensity_range', input({ intensity: 7 })],
    ['episode_intensity_range', input({ intensity: 2.5 })],
  ])('rejects with %s', (code, candidate) => {
    const result = planEpisode(candidate);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(code);
  });
});

describe('episodeDurationMinutes', () => {
  it('is null while the episode is open, not zero', () => {
    expect(episodeDurationMinutes({ startedAt: '2026-08-24T09:00:00.000Z', endedAt: null })).toBeNull();
  });

  it('is null when either instant is unparseable', () => {
    expect(episodeDurationMinutes({ startedAt: 'nope', endedAt: '2026-08-24T09:00:00.000Z' })).toBeNull();
    expect(episodeDurationMinutes({ startedAt: '2026-08-24T09:00:00.000Z', endedAt: 'nope' })).toBeNull();
  });
});

describe('summariseEpisodes', () => {
  function episode(overrides: Partial<AnxietyEpisode> = {}): AnxietyEpisode {
    return {
      id: 'ep',
      startedAt: '2026-08-24T09:00:00.000Z',
      endedAt: '2026-08-24T09:30:00.000Z',
      zone: 'Asia/Kolkata',
      intensity: 3,
      severity: 'moderate',
      physicalSymptoms: null,
      trigger: null,
      copingResponse: null,
      outcome: null,
      note: null,
      ...overrides,
    };
  }

  it('averages closed episodes only', () => {
    const summary = summariseEpisodes([
      episode({ id: 'a', endedAt: '2026-08-24T09:30:00.000Z' }),
      episode({ id: 'b', endedAt: '2026-08-24T10:30:00.000Z' }),
      episode({ id: 'c', endedAt: null }),
    ]);
    expect(summary.count).toBe(3);
    expect(summary.openCount).toBe(1);
    expect(summary.closedCount).toBe(2);
    expect(summary.meanClosedMinutes).toBe(60);
  });

  it('has no mean when nothing is closed', () => {
    expect(summariseEpisodes([episode({ endedAt: null })]).meanClosedMinutes).toBeNull();
  });

  it('folds trigger case but keeps the first spelling the operator used', () => {
    const summary = summariseEpisodes([
      episode({ id: 'a', trigger: 'Work' }),
      episode({ id: 'b', trigger: 'work' }),
      episode({ id: 'c', trigger: 'sleep' }),
      episode({ id: 'd', trigger: '  ' }),
    ]);
    expect(summary.namedTriggers).toEqual([
      { trigger: 'Work', count: 2 },
      { trigger: 'sleep', count: 1 },
    ]);
  });

  it('tallies coping responses the same way', () => {
    const summary = summariseEpisodes([
      episode({ id: 'a', copingResponse: 'walk' }),
      episode({ id: 'b', copingResponse: 'walk' }),
    ]);
    expect(summary.namedCoping).toEqual([{ response: 'walk', count: 2 }]);
  });

  it('is empty for an empty run', () => {
    expect(summariseEpisodes([])).toMatchObject({ count: 0, namedTriggers: [], namedCoping: [] });
  });
});
