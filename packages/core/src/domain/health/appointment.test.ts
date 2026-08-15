import { describe, expect, it } from 'vitest';

import type { Appointment, LabHighlight, QuestionInput } from './appointment';
import {
  MAX_QUESTIONS,
  awaitingNotes,
  deriveQuestions,
  describeWhen,
  formatDay,
  mergeQuestions,
  nextAppointment,
} from './appointment';

const NOW = '2026-10-04T09:00:00.000Z';

const EMPTY: QuestionInput = {
  labs: [],
  adherence: [],
  sideEffects: [],
  symptoms: [],
  conditions: [],
  nowIso: NOW,
};

function lab(overrides: Partial<LabHighlight> & Pick<LabHighlight, 'resultId'>): LabHighlight {
  return {
    analyte: '25-hydroxyvitamin D',
    value: '14.2',
    unit: 'ng/mL',
    flag: 'low',
    flagSource: 'printed',
    rangeText: '30 – 100 ng/mL',
    collectedAt: '2026-09-12T00:00:00.000Z',
    previous: null,
    ...overrides,
  };
}

describe('deriving questions', () => {
  it('says nothing when there is nothing to say', () => {
    expect(deriveQuestions(EMPTY)).toEqual({ questions: [], omitted: 0 });
  });

  /** §12's worked example, end to end: a lab PDF becomes a question to ask. */
  it('turns an out-of-range vitamin D into a question, not a recommendation', () => {
    const { questions } = deriveQuestions({ ...EMPTY, labs: [lab({ resultId: 'r1' })] });
    expect(questions).toHaveLength(1);

    const question = questions[0]?.question ?? '';
    expect(question).toContain('14.2 ng/mL');
    expect(question).toContain('12 September 2026');
    expect(question).toContain('30 – 100 ng/mL');
    expect(question.endsWith('?')).toBe(true);
    // P5: it states an observation and asks. It does not propose a treatment.
    expect(question.toLowerCase()).not.toContain('should i take');
    expect(question.toLowerCase()).not.toContain('increase');
  });

  it('carries the previous value into the evidence line', () => {
    const { questions } = deriveQuestions({
      ...EMPTY,
      labs: [lab({ resultId: 'r1', previous: { value: '22.0', collectedAt: '2026-03-01T00:00:00.000Z' } })],
    });
    expect(questions[0]?.evidence).toContain('22.0 ng/mL');
    expect(questions[0]?.evidence).toContain('1 March 2026');
  });

  /**
   * A flag this system computed is a weaker fact than one a laboratory printed,
   * and carrying it into a consulting room without saying so presents
   * arithmetic as a laboratory's judgement.
   */
  it('discloses when the flag was derived rather than printed', () => {
    const printed = deriveQuestions({ ...EMPTY, labs: [lab({ resultId: 'r1', flagSource: 'printed' })] });
    const derived = deriveQuestions({ ...EMPTY, labs: [lab({ resultId: 'r2', flagSource: 'derived' })] });
    expect(printed.questions[0]?.evidence).not.toContain('printed no flag');
    expect(derived.questions[0]?.evidence).toContain('printed no flag');
  });

  it('ignores results that are within range', () => {
    expect(deriveQuestions({ ...EMPTY, labs: [lab({ resultId: 'r1', flag: 'normal' })] }).questions).toHaveLength(0);
    expect(deriveQuestions({ ...EMPTY, labs: [lab({ resultId: 'r1', flag: null })] }).questions).toHaveLength(0);
  });

  it('orders by what is hardest to raise later, not by how interesting it is', () => {
    const { questions } = deriveQuestions({
      ...EMPTY,
      labs: [lab({ resultId: 'ordinary' }), lab({ resultId: 'critical', flag: 'critical_low' })],
      sideEffects: [
        {
          sideEffectId: 's1',
          effect: 'dry mouth',
          medicationLabel: 'Venlafaxine XR 150 mg',
          onsetAt: '2026-08-01T00:00:00.000Z',
          reportedToPrescriber: false,
        },
      ],
      symptoms: [{ name: 'Headache', count: 4, since: '2026-08-01T00:00:00.000Z' }],
      adherence: [
        { medicationId: 'm1', label: 'Escitalopram 10 mg', daysTaken: 22, daysExpected: 30, windowDays: 30 },
      ],
    });

    expect(questions.map((question) => question.source)).toEqual([
      'lab',
      'side_effect',
      'lab',
      'adherence',
      'symptom',
    ]);
  });

  it('leaves a reported side effect off the list', () => {
    const { questions } = deriveQuestions({
      ...EMPTY,
      sideEffects: [
        {
          sideEffectId: 's1',
          effect: 'dry mouth',
          medicationLabel: null,
          onsetAt: null,
          reportedToPrescriber: true,
        },
      ],
    });
    expect(questions).toHaveLength(0);
  });

  it('states adherence as a count and says what an absent day means', () => {
    const { questions } = deriveQuestions({
      ...EMPTY,
      adherence: [{ medicationId: 'm1', label: 'Venlafaxine XR', daysTaken: 22, daysExpected: 30, windowDays: 30 }],
    });
    expect(questions[0]?.question).toContain('22 of the last 30 days');
    expect(questions[0]?.evidence).toContain('unknown, not as missed');
  });

  it('does not mention adherence that is essentially complete', () => {
    const { questions } = deriveQuestions({
      ...EMPTY,
      adherence: [{ medicationId: 'm1', label: 'Venlafaxine XR', daysTaken: 29, daysExpected: 30, windowDays: 30 }],
    });
    expect(questions).toHaveLength(0);
  });

  it('raises a diagnosis that has been suspected for a season, and not one from last week', () => {
    const stale = deriveQuestions({
      ...EMPTY,
      conditions: [
        { conditionId: 'c1', name: 'Iron deficiency', status: 'suspected', recordedFrom: '2026-05-01T00:00:00.000Z' },
      ],
    });
    expect(stale.questions).toHaveLength(1);
    expect(stale.questions[0]?.question).toContain('suspected since 1 May 2026');

    const fresh = deriveQuestions({
      ...EMPTY,
      conditions: [
        { conditionId: 'c1', name: 'Iron deficiency', status: 'suspected', recordedFrom: '2026-09-28T00:00:00.000Z' },
      ],
    });
    expect(fresh.questions).toHaveLength(0);
  });

  it('caps the list and reports what it left off', () => {
    const many = Array.from({ length: MAX_QUESTIONS + 3 }, (_, index) => lab({ resultId: `r${String(index)}` }));
    const result = deriveQuestions({ ...EMPTY, labs: many });
    expect(result.questions).toHaveLength(MAX_QUESTIONS);
    expect(result.omitted).toBe(3);
  });

  /** The id is derived from the source row, so re-deriving does not duplicate. */
  it('produces stable ids across runs', () => {
    const first = deriveQuestions({ ...EMPTY, labs: [lab({ resultId: 'r1' })] });
    const second = deriveQuestions({ ...EMPTY, labs: [lab({ resultId: 'r1' })] });
    expect(first.questions[0]?.id).toBe(second.questions[0]?.id);
    expect(first.questions[0]?.id).toBe('lab:r1');
  });
});

describe('merging with what is already saved', () => {
  const saved = [{ id: 'manual:1', question: 'Can I train on this?', evidence: '', source: 'manual' as const, sourceId: null }];

  it('keeps manual questions and appends new derivations after them', () => {
    const derived = deriveQuestions({ ...EMPTY, labs: [lab({ resultId: 'r1' })] }).questions;
    const merged = mergeQuestions(saved, derived);
    expect(merged.map((question) => question.id)).toEqual(['manual:1', 'lab:r1']);
  });

  it('does not re-add a question already on the list', () => {
    const derived = deriveQuestions({ ...EMPTY, labs: [lab({ resultId: 'r1' })] }).questions;
    const once = mergeQuestions(saved, derived);
    expect(mergeQuestions(once, derived)).toHaveLength(2);
  });
});

describe('appointment reads', () => {
  const appointment = (overrides: Partial<Appointment> & Pick<Appointment, 'id'>): Appointment => ({
    medicalEventId: `event-${overrides.id}`,
    title: 'Psychiatry review',
    provider: null,
    specialty: null,
    location: null,
    scheduledFor: null,
    zone: null,
    attendedAt: null,
    preVisitQuestions: [],
    postVisitNotes: null,
    outcome: null,
    followUpDue: null,
    ...overrides,
  });

  it('finds the soonest upcoming appointment', () => {
    const next = nextAppointment(
      [
        appointment({ id: 'far', scheduledFor: '2026-12-01T00:00:00.000Z' }),
        appointment({ id: 'near', scheduledFor: '2026-10-20T00:00:00.000Z' }),
        appointment({ id: 'past', scheduledFor: '2026-09-01T00:00:00.000Z' }),
      ],
      NOW,
    );
    expect(next?.id).toBe('near');
  });

  it('lists appointments that happened and have no notes', () => {
    const waiting = awaitingNotes(
      [
        appointment({ id: 'noted', scheduledFor: '2026-09-01T00:00:00.000Z', postVisitNotes: 'Dose unchanged.' }),
        appointment({ id: 'blank', scheduledFor: '2026-09-02T00:00:00.000Z', postVisitNotes: '   ' }),
        appointment({ id: 'future', scheduledFor: '2026-11-01T00:00:00.000Z' }),
      ],
      NOW,
    );
    expect(waiting.map((entry) => entry.id)).toEqual(['blank']);
  });

  it('describes when, in both directions', () => {
    expect(describeWhen(appointment({ id: 'a', scheduledFor: '2026-10-04T18:00:00.000Z' }), NOW)).toBe('today');
    expect(describeWhen(appointment({ id: 'b', scheduledFor: '2026-10-07T09:00:00.000Z' }), NOW)).toBe('in 3 days');
    expect(describeWhen(appointment({ id: 'c', scheduledFor: '2026-09-28T09:00:00.000Z' }), NOW)).toBe('6 days ago');
    expect(describeWhen(appointment({ id: 'd' }), NOW)).toBeNull();
  });
});

describe('formatting a day', () => {
  /** These strings get read aloud in a consulting room. `09/12` will not do. */
  it('is unabbreviated and unambiguous', () => {
    expect(formatDay('2026-09-12T00:00:00.000Z')).toBe('12 September 2026');
    expect(formatDay('not a date')).toBeNull();
  });
});
