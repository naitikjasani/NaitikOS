/**
 * The Consultation Pack's selection logic.
 *
 * The tests that matter assert what the pack **does not** do: it does not drop
 * a record because a keyword list did not recognise it, and it does not report
 * an adherence figure it did not observe. Both failures would be invisible in
 * the document and expensive in the room.
 */

import { describe, expect, it } from 'vitest';

import { adherenceNote, isRelevantTo, leadCount, orderSection, specialtyFor } from './consultation-pack';

describe('specialty relevance', () => {
  it('recognises a psychiatric record for psychiatry', () => {
    expect(isRelevantTo('psychiatry', 'Generalised anxiety disorder')).toBe(true);
    expect(isRelevantTo('psychiatry', 'Venlafaxine XR')).toBe(true);
  });

  it('does not lead with an unrelated record — but does not drop it either', () => {
    /*
     * The asymmetry the whole design rests on. `isRelevantTo` decides what
     * *leads*; the caller keeps everything. The cost of burying a record is a
     * clinician reading one more line, and the cost of omitting it is a drug
     * interaction nobody mentioned. Those are not comparable.
     */
    expect(isRelevantTo('dentistry', 'Generalised anxiety disorder')).toBe(false);
  });

  it('treats general as a real choice rather than a filter that passes', () => {
    expect(isRelevantTo('general', 'anything at all')).toBe(true);
    expect(isRelevantTo('general', null)).toBe(true);
  });

  it('resolves an unrecognised specialty to general rather than to nothing', () => {
    /* An empty pack is the worst possible outcome of a typo. */
    expect(specialtyFor('rheumatology')).toBe('general');
    expect(specialtyFor('  Psychiatry ')).toBe('psychiatry');
  });

  it('matches across several fields, because relevance is not in one column', () => {
    expect(isRelevantTo('dermatology', 'Course of treatment', null, 'isotretinoin, 20mg')).toBe(true);
  });
});

describe('orderSection', () => {
  const rows = [
    { id: 'a', lead: false, at: '2026-11-01' },
    { id: 'b', lead: true, at: '2026-01-01' },
    { id: 'c', lead: true, at: '2026-06-01' },
    { id: 'd', lead: false, at: null },
  ];

  it('leads with relevant rows even when they are older', () => {
    const ordered = orderSection(rows, (row) => row.at);
    expect(ordered.map((row) => row.id)).toEqual(['c', 'b', 'a', 'd']);
  });

  it('keeps every row', () => {
    expect(orderSection(rows, (row) => row.at)).toHaveLength(rows.length);
  });

  it('sorts undated rows last, because unknown is not recent', () => {
    const ordered = orderSection(rows, (row) => row.at);
    expect(ordered.at(-1)?.id).toBe('d');
  });

  it('is stable, so the screen and the printout agree', () => {
    /* A pack that reordered itself between the two would be confusing in
     * exactly the setting where confusion is expensive. */
    const first = orderSection(rows, (row) => row.at).map((row) => row.id);
    const second = orderSection(rows, (row) => row.at).map((row) => row.id);
    expect(first).toEqual(second);
  });
});

describe('adherenceNote', () => {
  it('reports logging, not behaviour', () => {
    /*
     * "84% of 62 scheduled doses were logged" is a fact. "84% adherence" is a
     * claim about behaviour, and it is what a prescriber will hear unless it is
     * said the other way. §4.7's rule that an unlogged day is not a missed dose
     * matters most here, where the reader can act on it.
     */
    const note = adherenceNote({ logged: 52, scheduled: 62, asNeeded: false });
    expect(note).toContain('were logged');
    expect(note).toContain('may be a dose taken and not recorded');
  });

  it('refuses to compute a figure for an as-needed medication', () => {
    const note = adherenceNote({ logged: 3, scheduled: 0, asNeeded: true });
    expect(note).toContain('no schedule to compare against');
    expect(note).not.toContain('%');
  });

  it('says nothing was scheduled rather than reporting zero percent', () => {
    /* 0/0 is not 0%. A denominator invented to avoid a blank would be the
     * system reporting non-adherence it did not observe. */
    const note = adherenceNote({ logged: 0, scheduled: 0, asNeeded: false });
    expect(note).not.toContain('0%');
  });
});

describe('leadCount', () => {
  it('returns zero for a general pack, so no divider is drawn', () => {
    /* Everything leads under `general`, and a divider there would imply a
     * distinction nobody made. */
    expect(leadCount([{ lead: true }, { lead: true }])).toBe(2);
    expect(leadCount([{ lead: false }])).toBe(0);
  });
});
