import { describe, expect, it } from 'vitest';

import type { Medication, MedicationEvent, MedicationSchedule } from './adherence';
import {
  dayAdherence,
  expectedDosesPerDay,
  medicationAnnotations,
  medicationLabel,
  scheduleOn,
  windowAdherence,
} from './adherence';

const ZONE = 'Asia/Kolkata';

const venlafaxine: Medication = {
  id: 'med-ven',
  substance: 'Venlafaxine',
  brandName: 'Venlafaxine XR',
  strength: '150',
  strengthUnit: 'mg',
  startedAt: '2026-02-01T04:00:00.000Z',
  stoppedAt: null,
  stopReason: null,
  isPsychiatric: true,
};

function schedule(overrides: Partial<MedicationSchedule> = {}): MedicationSchedule {
  return {
    id: 'sch-1',
    medicationId: 'med-ven',
    dose: '150',
    doseUnit: 'mg',
    frequency: 'daily',
    times: ['08:00'],
    validFrom: '2026-02-01T04:00:00.000Z',
    validTo: null,
    ...overrides,
  };
}

function event(dayKey: string, kind: MedicationEvent['kind'] = 'taken', id = dayKey): MedicationEvent {
  return {
    id,
    medicationId: 'med-ven',
    scheduleId: 'sch-1',
    kind,
    scheduledFor: `${dayKey}T02:30:00.000Z`,
    takenAt: kind === 'skipped' ? null : `${dayKey}T02:35:00.000Z`,
    zone: ZONE,
  };
}

describe('medicationLabel', () => {
  it('prefers the brand name and includes the strength', () => {
    expect(medicationLabel(venlafaxine)).toBe('Venlafaxine XR 150 mg');
  });

  it('falls back to the substance and omits an absent strength', () => {
    expect(
      medicationLabel({ ...venlafaxine, brandName: null, strength: null, strengthUnit: null }),
    ).toBe('Venlafaxine');
  });
});

describe('expectedDosesPerDay', () => {
  it('counts explicit times first', () => {
    expect(expectedDosesPerDay({ frequency: 'daily', times: ['08:00', '20:00'] })).toBe(2);
  });

  it('falls back to the frequency word', () => {
    expect(expectedDosesPerDay({ frequency: 'daily', times: [] })).toBe(1);
    expect(expectedDosesPerDay({ frequency: 'twice_daily', times: [] })).toBe(2);
    expect(expectedDosesPerDay({ frequency: 'three_times_daily', times: [] })).toBe(3);
    expect(expectedDosesPerDay({ frequency: 'four_times_daily', times: [] })).toBe(4);
  });

  it('refuses a daily denominator for as-needed and weekly', () => {
    expect(expectedDosesPerDay({ frequency: 'as_needed', times: [] })).toBeNull();
    expect(expectedDosesPerDay({ frequency: 'weekly', times: [] })).toBeNull();
  });
});

describe('scheduleOn', () => {
  const first = schedule({ id: 'a', dose: '75', validFrom: '2026-02-01T04:00:00.000Z', validTo: '2026-05-01T04:00:00.000Z' });
  const second = schedule({ id: 'b', dose: '150', validFrom: '2026-05-01T04:00:00.000Z' });

  it('picks the schedule in force', () => {
    expect(scheduleOn([first, second], 'med-ven', '2026-03-01', ZONE)?.id).toBe('a');
    expect(scheduleOn([first, second], 'med-ven', '2026-06-01', ZONE)?.id).toBe('b');
  });

  it('treats validTo as exclusive on the changeover day', () => {
    expect(scheduleOn([first, second], 'med-ven', '2026-05-01', ZONE)?.id).toBe('b');
  });

  it('is null before anything was prescribed and for another medication', () => {
    expect(scheduleOn([first], 'med-ven', '2026-01-01', ZONE)).toBeNull();
    expect(scheduleOn([first], 'med-other', '2026-03-01', ZONE)).toBeNull();
  });
});

describe('dayAdherence', () => {
  it('counts a delayed dose as taken', () => {
    const day = dayAdherence('med-ven', '2026-08-24', ZONE, [event('2026-08-24', 'delayed')], 1);
    expect(day.taken).toBe(1);
    expect(day.ratio).toBe(1);
  });

  it('clamps a double dose at 1 while keeping the count', () => {
    const day = dayAdherence(
      'med-ven',
      '2026-08-24',
      ZONE,
      [event('2026-08-24', 'taken', 'a'), event('2026-08-24', 'taken', 'b')],
      1,
    );
    expect(day.taken).toBe(2);
    expect(day.ratio).toBe(1);
  });

  it('has no ratio on a day with no record', () => {
    const day = dayAdherence('med-ven', '2026-08-24', ZONE, [], 1);
    expect(day.recorded).toBe(false);
    expect(day.ratio).toBeNull();
  });

  it('has no ratio when the schedule has no denominator', () => {
    expect(dayAdherence('med-ven', '2026-08-24', ZONE, [event('2026-08-24')], null).ratio).toBeNull();
  });

  it('resolves the day in the event’s own zone', () => {
    // 20:00 UTC on the 23rd is already the 24th in Kolkata.
    const late: MedicationEvent = {
      ...event('2026-08-23'),
      takenAt: '2026-08-23T20:00:00.000Z',
      scheduledFor: '2026-08-23T20:00:00.000Z',
    };
    expect(dayAdherence('med-ven', '2026-08-24', ZONE, [late], 1).taken).toBe(1);
  });

  it('ignores an event with no timestamp at all', () => {
    const undated: MedicationEvent = { ...event('2026-08-24'), takenAt: null, scheduledFor: null };
    expect(dayAdherence('med-ven', '2026-08-24', ZONE, [undated], 1).recorded).toBe(false);
  });
});

describe('windowAdherence', () => {
  const dayKeys = Array.from({ length: 10 }, (_, index) => `2026-08-${String(index + 1).padStart(2, '0')}`);

  it('never counts an unrecorded day as a miss', () => {
    const events = dayKeys.slice(0, 4).map((day) => event(day));
    const result = windowAdherence(venlafaxine, [schedule()], events, dayKeys, ZONE);

    expect(result.recordedDays).toBe(4);
    expect(result.unrecordedDays).toBe(6);
    expect(result.dosesExpected).toBe(4);
    expect(result.ratio).toBe(1);
    expect(result.sentence).toContain('6 days have no record either way');
  });

  it('reports the shortfall when doses were skipped', () => {
    const events = [
      ...dayKeys.slice(0, 3).map((day) => event(day)),
      event(dayKeys[3] ?? '', 'skipped'),
    ];
    const result = windowAdherence(venlafaxine, [schedule()], events, dayKeys, ZONE);
    expect(result.dosesTaken).toBe(3);
    expect(result.dosesSkipped).toBe(1);
    expect(result.ratio).toBe(0.75);
  });

  it('has no ratio and says so when nothing was recorded', () => {
    const result = windowAdherence(venlafaxine, [schedule()], [], dayKeys, ZONE);
    expect(result.ratio).toBeNull();
    expect(result.sentence).toBe('No doses recorded for Venlafaxine XR 150 mg in the last 10 days.');
  });

  it('says so when every day has a record', () => {
    const events = dayKeys.map((day) => event(day));
    expect(windowAdherence(venlafaxine, [schedule()], events, dayKeys, ZONE).sentence).toContain(
      'Every day in the window has a record',
    );
  });
});

describe('medicationAnnotations', () => {
  it('marks starts, stops and dose changes', () => {
    const escitalopram: Medication = {
      id: 'med-esc',
      substance: 'Escitalopram',
      brandName: null,
      strength: '10',
      strengthUnit: 'mg',
      startedAt: '2026-03-15T04:00:00.000Z',
      stoppedAt: '2026-07-01T04:00:00.000Z',
      stopReason: 'completed',
      isPsychiatric: true,
    };

    const annotations = medicationAnnotations(
      [venlafaxine, escitalopram],
      [
        schedule({ id: 'a', dose: '75', validTo: '2026-05-01T04:00:00.000Z' }),
        schedule({ id: 'b', dose: '150', validFrom: '2026-05-01T04:00:00.000Z' }),
      ],
      ZONE,
    );

    expect(annotations.map((item) => `${item.dayKey} ${item.kind}`)).toEqual([
      '2026-02-01 started',
      '2026-03-15 started',
      '2026-05-01 dose_changed',
      '2026-07-01 stopped',
    ]);
    expect(annotations[2]?.label).toBe('Venlafaxine XR → 150 mg');
  });

  it('does not emit a phantom marker for 10 versus 10.0', () => {
    const annotations = medicationAnnotations(
      [{ ...venlafaxine, startedAt: null }],
      [
        schedule({ id: 'a', dose: '150', validTo: '2026-05-01T04:00:00.000Z' }),
        schedule({ id: 'b', dose: '150.00', validFrom: '2026-05-01T04:00:00.000Z' }),
      ],
      ZONE,
    );
    expect(annotations).toEqual([]);
  });

  it('treats a change of frequency at the same dose as a change', () => {
    const annotations = medicationAnnotations(
      [{ ...venlafaxine, startedAt: null }],
      [
        schedule({ id: 'a', validTo: '2026-05-01T04:00:00.000Z' }),
        schedule({ id: 'b', frequency: 'twice_daily', validFrom: '2026-05-01T04:00:00.000Z' }),
      ],
      ZONE,
    );
    expect(annotations).toHaveLength(1);
    expect(annotations[0]?.kind).toBe('dose_changed');
  });

  it('falls back to a string comparison for an unparseable dose', () => {
    const annotations = medicationAnnotations(
      [{ ...venlafaxine, startedAt: null }],
      [
        schedule({ id: 'a', dose: 'one tablet', validTo: '2026-05-01T04:00:00.000Z' }),
        schedule({ id: 'b', dose: 'two tablets', validFrom: '2026-05-01T04:00:00.000Z' }),
      ],
      ZONE,
    );
    expect(annotations).toHaveLength(1);
  });
});
