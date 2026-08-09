import { describe, expect, it } from 'vitest';

import type { StreakSeries } from './streak';
import { BREAK_REPORT_WINDOW_DAYS, MIN_STREAK_DAYS, detectStreak } from './streak';

function series(pattern: readonly boolean[]): StreakSeries {
  return {
    subject: 'routine:rt-pm',
    label: 'the evening routine',
    days: pattern.map((complete, index) => ({
      dayKey: `2026-08-${String(index + 1).padStart(2, '0')}`,
      complete,
    })),
  };
}

const TODAY = '2026-08-31';

describe('detectStreak', () => {
  it('reports insufficient history rather than nothing', () => {
    const outcome = detectStreak(series([true, true, true]), TODAY);
    expect(outcome.findings).toEqual([]);
    expect(outcome.insufficient[0]).toMatchObject({ required: MIN_STREAK_DAYS, available: 3 });
  });

  it('says nothing about a run shorter than the minimum', () => {
    const outcome = detectStreak(series([false, false, false, true, true, true, true]), TODAY);
    expect(outcome.findings).toEqual([]);
  });

  it('reports a current run at the minimum', () => {
    const outcome = detectStreak(series(Array<boolean>(MIN_STREAK_DAYS).fill(true)), TODAY);
    expect(outcome.findings[0]?.headline).toBe(
      'the evening routine has a complete log on 7 consecutive days.',
    );
    expect(outcome.findings[0]?.confidence).toBe('descriptive');
    expect(outcome.findings[0]?.pValue).toBeNull();
  });

  it('reports a run that ended, as a fact and without characterising it', () => {
    // Eight complete days ending 2026-08-08, then a gap; today is 2026-08-10.
    const outcome = detectStreak(series([...Array<boolean>(8).fill(true), false]), '2026-08-10');
    const finding = outcome.findings[0];

    expect(finding?.headline).toBe('An 8-day run of the evening routine ended on 2026-08-08.');
    expect(finding?.headline).not.toMatch(/missed|broke|lost|again/iu);
    expect(finding?.detail).toBe('The run started on 2026-08-01.');
  });

  it('stops mentioning an ended run once it is no longer news', () => {
    const pattern = [...Array<boolean>(8).fill(true), ...Array<boolean>(10).fill(false)];
    const outcome = detectStreak(series(pattern), '2026-08-25');
    expect(outcome.findings).toEqual([]);
  });

  it('mentions it right up to the edge of the window', () => {
    const pattern = [...Array<boolean>(8).fill(true), false, false, false];
    const lastNewsDay = `2026-08-${String(8 + BREAK_REPORT_WINDOW_DAYS).padStart(2, '0')}`;
    expect(detectStreak(series(pattern), lastNewsDay).findings).toHaveLength(1);
  });

  it('prefers the current run over a historical one', () => {
    const pattern = [...Array<boolean>(9).fill(true), false, ...Array<boolean>(8).fill(true)];
    const outcome = detectStreak(series(pattern), '2026-08-18');
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.findings[0]?.headline).toContain('8 consecutive days');
  });

  it('says nothing when there has never been a complete day', () => {
    expect(detectStreak(series(Array<boolean>(20).fill(false)), TODAY).findings).toEqual([]);
  });

  it('says nothing about an ended run for a malformed today key', () => {
    const pattern = [...Array<boolean>(8).fill(true), false];
    expect(detectStreak(series(pattern), 'not-a-day').findings).toEqual([]);
  });

  it('ids an ended run by the day it ended, so it stays the same finding', () => {
    const pattern = [...Array<boolean>(8).fill(true), false];
    const monday = detectStreak(series(pattern), '2026-08-09').findings[0];
    const tuesday = detectStreak(series(pattern), '2026-08-10').findings[0];
    expect(monday?.id).toBe(tuesday?.id);
  });
});
