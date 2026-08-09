import { describe, expect, it } from 'vitest';

import type { DailyEstimate } from '../../statistics/types';
import type { CrisisPlan } from './crisis';
import {
  CRISIS_CONSECUTIVE_DAYS,
  crisisSurface,
  evaluateCrisisState,
  parseContacts,
  shouldInvitePlanning,
} from './crisis';

const plan: CrisisPlan = {
  id: 'plan-1',
  isActive: true,
  warningSigns: 'Not sleeping, avoiding messages.',
  copingStrategies: 'Walk. Text R.',
  reasonsToLive: null,
  contacts: [{ name: 'R.', relationship: 'friend', phone: '+910000000000', notes: null }],
  professionalContacts: [],
  lastReviewedAt: '2026-05-01T00:00:00.000Z',
};

function days(values: readonly (number | null)[]): DailyEstimate[] {
  return values.map((value, index) => ({
    dayKey: `2026-08-${String(index + 1).padStart(2, '0')}`,
    value,
  }));
}

describe('evaluateCrisisState', () => {
  it('does not surface on a single severe day', () => {
    const evaluation = evaluateCrisisState({ anxiety: days([1, 2, 5]) }, plan);
    expect(evaluation.consecutiveDays).toBe(1);
    expect(evaluation.surface).toBe(false);
  });

  it('surfaces at the threshold', () => {
    const evaluation = evaluateCrisisState({ anxiety: days([1, 5, 5, 5]) }, plan);
    expect(evaluation.consecutiveDays).toBe(CRISIS_CONSECUTIVE_DAYS);
    expect(evaluation.surface).toBe(true);
  });

  it('counts a low mood day as severe too', () => {
    expect(evaluateCrisisState({ mood: days([2, 1, 2]) }, plan).surface).toBe(true);
  });

  it('treats a gap as silence — it neither breaks nor extends the run', () => {
    // Severe, gap, severe, severe: three recorded severe days in a row.
    const evaluation = evaluateCrisisState({ anxiety: days([5, null, 5, 5]) }, plan);
    expect(evaluation.consecutiveDays).toBe(3);
  });

  it('resets on a recorded day that is not severe', () => {
    expect(evaluateCrisisState({ anxiety: days([5, 5, 2, 5]) }, plan).consecutiveDays).toBe(1);
  });

  it('merges the two series by day', () => {
    const evaluation = evaluateCrisisState(
      { anxiety: days([1, 1, 1]), mood: days([1, 1, 1]) },
      plan,
    );
    expect(evaluation.consecutiveDays).toBe(3);
  });

  it('never surfaces when there is no plan, however severe the run', () => {
    const evaluation = evaluateCrisisState({ anxiety: days([5, 5, 5, 5, 5]) }, null);
    expect(evaluation.consecutiveDays).toBe(5);
    expect(evaluation.surface).toBe(false);
    expect(evaluation.hasPlan).toBe(false);
  });

  it('is inert on empty input', () => {
    expect(evaluateCrisisState({}, plan)).toMatchObject({ surface: false, consecutiveDays: 0 });
  });
});

describe('crisisSurface', () => {
  it('carries the stored plan and nothing else', () => {
    const evaluation = evaluateCrisisState({ anxiety: days([5, 5, 5]) }, plan);
    const surface = crisisSurface(evaluation, plan);
    expect(surface).not.toBeNull();
    expect(Object.keys(surface ?? {})).toEqual(['plan']);
    expect(surface?.plan.copingStrategies).toBe(plan.copingStrategies);
  });

  it('is null when the evaluation says not to surface', () => {
    expect(crisisSurface(evaluateCrisisState({ anxiety: days([5]) }, plan), plan)).toBeNull();
  });
});

describe('parseContacts', () => {
  it('keeps the entries it can read and drops the ones it cannot', () => {
    expect(
      parseContacts([
        { name: 'R.', relationship: 'friend', phone: '+91', notes: 'evenings' },
        { name: '   ' },
        { relationship: 'sister' },
        'not an object',
        null,
      ]),
    ).toEqual([{ name: 'R.', relationship: 'friend', phone: '+91', notes: 'evenings' }]);
  });

  it('nulls fields of the wrong type rather than refusing the contact', () => {
    expect(parseContacts([{ name: 'R.', phone: 12345 }])).toEqual([
      { name: 'R.', relationship: null, phone: null, notes: null },
    ]);
  });

  it('is empty for anything that is not an array', () => {
    expect(parseContacts(null)).toEqual([]);
    expect(parseContacts({ name: 'R.' })).toEqual([]);
  });
});

describe('shouldInvitePlanning', () => {
  it('invites on a settled week with no plan', () => {
    expect(shouldInvitePlanning(evaluateCrisisState({ mood: days([4, 4, 4]) }, null))).toBe(true);
  });

  it('does not invite during a run that is building', () => {
    expect(shouldInvitePlanning(evaluateCrisisState({ anxiety: days([4, 4]) }, null))).toBe(false);
  });

  it('does not invite when a plan already exists', () => {
    expect(shouldInvitePlanning(evaluateCrisisState({ mood: days([4, 4, 4]) }, plan))).toBe(false);
  });
});
