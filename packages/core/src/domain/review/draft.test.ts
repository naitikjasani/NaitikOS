import { describe, expect, it } from 'vitest';

import { EMPTY_RECORD_HEADING, REVIEW_PROMPTS, assembleDraft, draftToMarkdown, isReviewComplete } from './draft';
import type { ReviewInputs } from './draft';
import { REVIEW_KINDS, periodContaining } from './period';
import type { ReviewPeriod } from './period';

function must(period: ReviewPeriod | null): ReviewPeriod {
  if (period === null) throw new Error('expected a period');
  return period;
}

const AUGUST = must(periodContaining('monthly', '2026-08-15'));

/** An empty month. Every figure absent, which is the interesting starting point. */
const empty: ReviewInputs = {
  period: AUGUST,
  closedDays: 0,
  totalDays: 31,
  sleep: { nights: 0, meanDurationHours: null, meanQuality: null },
  training: { sessions: 0, totalVolume: null },
  mood: { mean: null, low: null, high: null, observations: 0 },
  tasksClosed: 0,
  careerEntries: [],
  learningFinished: [],
  insightsActedOn: 0,
  goalsAchieved: [],
};

const inputs = (overrides: Partial<ReviewInputs>): ReviewInputs => ({ ...empty, ...overrides });

describe('coverage', () => {
  it('leads the document, before any figure', () => {
    const draft = assembleDraft(inputs({ closedDays: 11, totalDays: 30, tasksClosed: 4 }));
    const markdown = draftToMarkdown(draft);

    expect(draft.coverage).toContain('11 of 30 days');
    /* §8.9(3) in prose: the reader must meet the size of the record before the
     * first number drawn from it. */
    expect(markdown.indexOf(draft.coverage)).toBeLessThan(markdown.indexOf('## Work'));
  });

  it('names the days that are missing rather than a percentage', () => {
    const draft = assembleDraft(inputs({ closedDays: 11, totalDays: 30 }));
    expect(draft.coverage).toContain('19 days have no Daily Close');
    expect(draft.coverage).not.toContain('%');
  });

  it('says so when nothing at all was closed', () => {
    expect(assembleDraft(inputs({ closedDays: 0, totalDays: 31 })).coverage).toContain('No day in this');
  });

  it('says so when the whole period was closed', () => {
    const draft = assembleDraft(inputs({ closedDays: 31, totalDays: 31 }));
    expect(draft.coverage).toContain('Every one of the 31 days');
  });

  it('does not divide by a period of no days', () => {
    const draft = assembleDraft(inputs({ closedDays: 0, totalDays: 0 }));
    expect(draft.coverage).toContain('no days');
    expect(draft.coverage).not.toContain('NaN');
  });

  it('uses the singular for a single missing day', () => {
    expect(assembleDraft(inputs({ closedDays: 6, totalDays: 7 })).coverage).toContain('1 day has');
  });
});

describe('assembleDraft', () => {
  it('produces a document that says the record is empty, not an empty document', () => {
    const draft = assembleDraft(empty);
    expect(draft.sections).toHaveLength(1);
    expect(draft.sections[0]?.heading).toBe(EMPTY_RECORD_HEADING);
    /* A blank page is indistinguishable from a drafting failure. */
    expect(draftToMarkdown(draft)).toContain('No sleep, training, mood, work');
    expect(draft.prompts.length).toBeGreaterThan(0);
  });

  it('omits an absent figure rather than zeroing it', () => {
    const draft = assembleDraft(inputs({ tasksClosed: 3 }));
    const headings = draft.sections.map((part) => part.heading);

    expect(headings).toContain('Work');
    /* The operator knows whether they trained. "0 sessions" is the system
     * asserting an absence it did not observe. */
    expect(headings).not.toContain('Training');
    expect(headings).not.toContain('Sleep');
    expect(headings).not.toContain('Mood');
    expect(draftToMarkdown(draft)).not.toContain('0 sessions');
  });

  it('drops a mean that is not a finite number', () => {
    const draft = assembleDraft(
      inputs({ sleep: { nights: 4, meanDurationHours: Number.NaN, meanQuality: 3.5 } }),
    );
    const sleep = draft.sections.find((part) => part.heading === 'Sleep');
    expect(sleep?.lines).toEqual(['4 nights recorded.', 'Mean quality 3.5 of 5.']);
    expect(draftToMarkdown(draft)).not.toContain('NaN');
  });

  it('trims a bare decimal so a figure reads as a person wrote it', () => {
    const draft = assembleDraft(
      // eslint-disable-next-line @naitikos/no-bare-quantity -- A mean over nights is a derived statistic, not a measured value crossing a boundary; `ReviewInputs` fixes the unit in the field name and takes a plain number.
      inputs({ sleep: { nights: 1, meanDurationHours: 7, meanQuality: null } }),
    );
    expect(draft.sections[0]?.lines).toEqual(['1 night recorded.', 'Mean duration 7 hours.']);
  });

  it('prints a mood range only when both ends are known', () => {
    const halfOpen = assembleDraft(inputs({ mood: { mean: 3, low: 2, high: null, observations: 9 } }));
    expect(halfOpen.sections[0]?.lines).toEqual(['9 observations recorded.', 'Mean 3 of 5.']);

    const closed = assembleDraft(inputs({ mood: { mean: 3, low: 2, high: 5, observations: 9 } }));
    expect(closed.sections[0]?.lines).toContain('Range 2 to 5.');
  });

  it('does not invent a unit for a training volume', () => {
    const draft = assembleDraft(inputs({ training: { sessions: 2, totalVolume: '12340.000000' } }));
    expect(draft.sections[0]?.lines).toEqual(['2 sessions completed.', 'Total volume 12340.000000.']);
  });

  it('labels a career entry kind it knows and passes through one it does not', () => {
    const draft = assembleDraft(
      inputs({
        careerEntries: [
          { kind: 'shipped', title: 'The outbox', occurredAt: '2026-08-20T12:00:00.000Z' },
          { kind: 'sabbatical', title: 'Four weeks off', occurredAt: '2026-08-02T12:00:00.000Z' },
        ],
      }),
    );
    /* Oldest first: a review reads the period forward. */
    expect(draft.sections[0]?.lines).toEqual([
      'sabbatical: Four weeks off (2026-08-02).',
      'Shipped: The outbox (2026-08-20).',
    ]);
  });
});

describe('prompts', () => {
  it('asks questions and never states a conclusion', () => {
    for (const kind of REVIEW_KINDS) {
      const prompts = REVIEW_PROMPTS[kind];
      expect(prompts.length).toBeGreaterThan(0);
      /* §10.0: the model — and the system drafting for it — never asserts. A
       * prompt that does not end in a question mark is a finding in disguise. */
      for (const prompt of prompts) expect(prompt.endsWith('?')).toBe(true);
    }
  });

  it("carries the prompts for the period's own kind", () => {
    const week = assembleDraft(inputs({ period: must(periodContaining('weekly', '2026-08-30')) }));
    expect(week.prompts).toEqual(REVIEW_PROMPTS.weekly);
  });
});

describe('draftToMarkdown', () => {
  const rich = inputs({
    closedDays: 28,
    totalDays: 31,
    // eslint-disable-next-line @naitikos/no-bare-quantity -- As above: a pre-aggregated mean, whose unit `ReviewInputs` carries in the field name.
    sleep: { nights: 27, meanDurationHours: 7.24, meanQuality: 3.5 },
    training: { sessions: 12, totalVolume: '48210.000000' },
    mood: { mean: 3.8, low: 2, high: 5, observations: 28 },
    tasksClosed: 41,
    careerEntries: [{ kind: 'shipped', title: 'Reviews', occurredAt: '2026-08-28T12:00:00.000Z' }],
    learningFinished: ['Designing Data-Intensive Applications'],
    insightsActedOn: 2,
    goalsAchieved: ['Hold a 100 kg bench'],
  });

  it('is byte-identical across runs, so a re-draft can be diffed against the edit', () => {
    expect(draftToMarkdown(assembleDraft(rich))).toBe(draftToMarkdown(assembleDraft(rich)));
  });

  it('does not depend on the order career entries arrived in', () => {
    const forwards = assembleDraft(
      inputs({
        careerEntries: [
          { kind: 'shipped', title: 'A', occurredAt: '2026-08-02T12:00:00.000Z' },
          { kind: 'shipped', title: 'B', occurredAt: '2026-08-20T12:00:00.000Z' },
        ],
      }),
    );
    const backwards = assembleDraft(
      inputs({
        careerEntries: [
          { kind: 'shipped', title: 'B', occurredAt: '2026-08-20T12:00:00.000Z' },
          { kind: 'shipped', title: 'A', occurredAt: '2026-08-02T12:00:00.000Z' },
        ],
      }),
    );
    expect(draftToMarkdown(forwards)).toBe(draftToMarkdown(backwards));
  });

  it('carries no clock reading, which is what makes it stable', () => {
    const markdown = draftToMarkdown(assembleDraft(rich));
    /* Every date in the document belongs to the record. If a generation
     * timestamp crept in, every re-draft would diff against every edit. */
    expect(markdown).not.toMatch(/T\d{2}:\d{2}/u);
  });

  it('renders the title, the window, the sections and the questions, in that order', () => {
    const markdown = draftToMarkdown(assembleDraft(rich));
    expect(markdown.startsWith('# Monthly review — August 2026\n')).toBe(true);
    expect(markdown).toContain('2026-08-01 to 2026-08-31');
    expect(markdown.indexOf('## Sleep')).toBeLessThan(markdown.indexOf('## Questions'));
    expect(markdown.endsWith('?\n')).toBe(true);
  });
});

describe('isReviewComplete', () => {
  it('refuses an unedited draft, whatever the state column says', () => {
    /* §4.12: "a review the user did not edit is a review they did not do." */
    expect(isReviewComplete('complete', null)).toBe(false);
    expect(isReviewComplete('complete', '')).toBe(false);
    expect(isReviewComplete('complete', '   \n\t ')).toBe(false);
  });

  it('refuses an edited review that has not been marked complete', () => {
    expect(isReviewComplete('drafted', 'A real edit.')).toBe(false);
    expect(isReviewComplete('editing', 'A real edit.')).toBe(false);
  });

  it('accepts an edited, completed review', () => {
    expect(isReviewComplete('complete', 'A real edit.')).toBe(true);
  });
});
