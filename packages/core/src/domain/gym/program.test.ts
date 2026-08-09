import { describe, expect, it } from 'vitest';

import { nextBlock, parsePrescription, programAdherence, type ProgramBlock } from './program';

describe('parsePrescription', () => {
  it('reads a well-formed prescription', () => {
    expect(
      parsePrescription([
        { exerciseId: 'ex-bench', sets: 3, repRange: '8-12', targetRpe: '8', notes: 'pause at the chest' },
      ]),
    ).toEqual([
      { exerciseId: 'ex-bench', sets: 3, repRange: '8-12', targetRpe: '8', notes: 'pause at the chest' },
    ]);
  });

  /**
   * Total by construction. A block whose JSON has drifted yields what it can
   * rather than making the session screen unreachable — a prescription is
   * guidance, and losing a line of it is a smaller harm than losing the session.
   */
  it('keeps what it can read and drops what it cannot', () => {
    const parsed = parsePrescription([
      { exerciseId: 'ex-bench', sets: 3 },
      { sets: 3 },
      null,
      'not an object',
      { exerciseId: '' },
      { exerciseId: 'ex-row', sets: 'three', repRange: 5 },
    ]);

    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({ exerciseId: 'ex-bench', sets: 3, repRange: null, targetRpe: null, notes: null });
    // A non-numeric set count becomes absent, not zero.
    expect(parsed[1]).toEqual({ exerciseId: 'ex-row', sets: null, repRange: null, targetRpe: null, notes: null });
  });

  it('reads a non-array as an empty prescription', () => {
    expect(parsePrescription(null)).toEqual([]);
    expect(parsePrescription({ exerciseId: 'ex-bench' })).toEqual([]);
    expect(parsePrescription(undefined)).toEqual([]);
  });
});

describe('programAdherence', () => {
  const window = { fromDayKey: '2026-08-03', toDayKey: '2026-08-16' } as const;

  it('measures performed against intended over the window', () => {
    const adherence = programAdherence(
      { targetFrequency: 3 },
      ['2026-08-03', '2026-08-05', '2026-08-07', '2026-08-10', '2026-08-12'],
      window,
    );

    expect(adherence.windowDays).toBe(14);
    expect(adherence.sessionsPerformed).toBe(5);
    expect(adherence.sessionsIntended).toBe(6);
    expect(adherence.ratio).toBeCloseTo(5 / 6, 10);
  });

  /**
   * Two sessions in one day is one training day. Counting it as two would let a
   * double day paper over a missed one — the substitution a frequency target
   * exists to discourage.
   */
  it('counts training days, not sessions', () => {
    const adherence = programAdherence({ targetFrequency: 3 }, ['2026-08-03', '2026-08-03'], window);
    expect(adherence.sessionsPerformed).toBe(1);
  });

  it('ignores sessions outside the window', () => {
    const adherence = programAdherence({ targetFrequency: 3 }, ['2026-07-01', '2026-09-01'], window);
    expect(adherence.sessionsPerformed).toBe(0);
  });

  /**
   * Uncapped upwards on purpose: training more than planned is the usual
   * prelude to the injury a deload was supposed to prevent, and clamping to 1
   * would hide it.
   */
  it('reports more than one when the operator trains more than planned', () => {
    const adherence = programAdherence(
      { targetFrequency: 2 },
      ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07', '2026-08-10'],
      window,
    );
    expect(adherence.ratio ?? 0).toBeGreaterThan(1);
  });

  it('says nothing about adherence when the program sets no target', () => {
    const adherence = programAdherence({ targetFrequency: null }, ['2026-08-03'], window);
    expect(adherence.sessionsIntended).toBeNull();
    expect(adherence.ratio).toBeNull();
    expect(adherence.sessionsPerformed).toBe(1);
  });

  it('handles a malformed window without dividing by zero', () => {
    const adherence = programAdherence({ targetFrequency: 3 }, [], {
      fromDayKey: 'nonsense',
      toDayKey: '2026-08-16',
    });
    expect(adherence.windowDays).toBe(0);
    expect(adherence.ratio).toBeNull();
  });
});

describe('nextBlock', () => {
  const blocks: ProgramBlock[] = [
    { id: 'b1', programId: 'p1', name: 'Push A', orderIndex: 0, prescription: [], notes: null },
    { id: 'b2', programId: 'p1', name: 'Pull A', orderIndex: 1, prescription: [], notes: null },
    { id: 'b3', programId: 'p1', name: 'Legs A', orderIndex: 2, prescription: [], notes: null },
  ];

  it('starts at the beginning and cycles', () => {
    expect(nextBlock(blocks, null)?.name).toBe('Push A');
    expect(nextBlock(blocks, 'b1')?.name).toBe('Pull A');
    expect(nextBlock(blocks, 'b3')?.name).toBe('Push A');
  });

  it('respects order rather than array position', () => {
    const shuffled = [blocks[2], blocks[0], blocks[1]].filter((block) => block !== undefined);
    expect(nextBlock(shuffled, 'b1')?.name).toBe('Pull A');
  });

  it('restarts rather than stalling when the last block was deleted', () => {
    expect(nextBlock(blocks, 'deleted')?.name).toBe('Push A');
  });

  it('returns nothing for a program with no blocks', () => {
    expect(nextBlock([], null)).toBeNull();
  });
});
