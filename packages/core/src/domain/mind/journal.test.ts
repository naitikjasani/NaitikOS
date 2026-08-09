import { describe, expect, it } from 'vitest';

import type { JournalEntry, JournalEntryInput, JournalPrompt } from './journal';
import {
  MAX_JOURNAL_CHARACTERS,
  journalListItem,
  planJournalEntry,
  promptForDay,
  wordCount,
} from './journal';

function input(overrides: Partial<JournalEntryInput> = {}): JournalEntryInput {
  return {
    id: 'je-1',
    writtenAt: '2026-08-24T21:30:00.000Z',
    zone: 'Asia/Kolkata',
    content: 'A quiet day. Nothing much to report.',
    ...overrides,
  };
}

function unwrap(result: ReturnType<typeof planJournalEntry>): JournalEntry {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}`);
  return result.value;
}

describe('planJournalEntry', () => {
  it('defaults consent to none — nothing is shareable by accident', () => {
    expect(unwrap(planJournalEntry(input())).aiConsent).toBe('none');
  });

  it('permits the journal scope explicitly', () => {
    expect(unwrap(planJournalEntry(input({ aiConsent: 'journal' }))).aiConsent).toBe('journal');
  });

  it('refuses a broader scope before the database has to', () => {
    const result = planJournalEntry(input({ aiConsent: 'clinical' as never }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('journal_consent_scope');
  });

  it('treats a whitespace-only title as no title', () => {
    expect(unwrap(planJournalEntry(input({ title: '  ' }))).title).toBeNull();
  });

  it.each([
    ['journal_written_at_invalid', input({ writtenAt: 'last night' })],
    ['journal_zone_invalid', input({ zone: 'IST' })],
    ['journal_content_empty', input({ content: '   \n ' })],
    ['journal_mood_range', input({ moodAtWriting: 0 })],
    ['journal_content_too_long', input({ content: 'x'.repeat(MAX_JOURNAL_CHARACTERS + 1) })],
  ])('rejects with %s', (code, candidate) => {
    const result = planJournalEntry(candidate);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(code);
  });
});

describe('journalListItem', () => {
  const entry = unwrap(
    planJournalEntry(input({ content: 'The thing I have not told anyone about this week.' })),
  );

  it('carries no prose at all', () => {
    const item = journalListItem(entry);
    const serialised = JSON.stringify(item);
    expect(serialised).not.toContain('not told anyone');
    expect(Object.keys(item)).not.toContain('excerpt');
    expect(Object.keys(item)).not.toContain('content');
  });

  it('falls back to a word count rather than to the first words', () => {
    expect(journalListItem(entry).heading).toBe('10 words');
  });

  it('uses the operator’s title when there is one', () => {
    const titled = unwrap(planJournalEntry(input({ title: 'Tuesday' })));
    expect(journalListItem(titled).heading).toBe('Tuesday');
  });

  it('singularises a one-word entry', () => {
    const short = unwrap(planJournalEntry(input({ content: 'Fine.' })));
    expect(journalListItem(short).heading).toBe('1 word');
  });

  it('resolves the day in the entry’s own zone', () => {
    // 21:30 UTC is already the 25th in Kolkata (+05:30).
    expect(journalListItem(entry).dayKey).toBe('2026-08-25');
  });
});

describe('wordCount', () => {
  it('is zero for empty and whitespace', () => {
    expect(wordCount('')).toBe(0);
    expect(wordCount('   \n\t ')).toBe(0);
  });

  it('collapses runs of whitespace', () => {
    expect(wordCount('one   two\n\nthree')).toBe(3);
  });
});

describe('promptForDay', () => {
  const prompts: JournalPrompt[] = [
    { id: 'p1', prompt: 'What went well?', category: null, isActive: true },
    { id: 'p2', prompt: 'What is unresolved?', category: null, isActive: true },
    { id: 'p3', prompt: 'Retired', category: null, isActive: false },
  ];

  it('is stable for the same day', () => {
    expect(promptForDay(prompts, '2026-08-24')).toBe(promptForDay(prompts, '2026-08-24'));
  });

  it('advances on consecutive days rather than repeating', () => {
    expect(promptForDay(prompts, '2026-08-24')?.id).not.toBe(promptForDay(prompts, '2026-08-25')?.id);
  });

  it('never offers an inactive prompt', () => {
    const ids = new Set<string>();
    for (let day = 1; day <= 28; day += 1) {
      const chosen = promptForDay(prompts, `2026-08-${String(day).padStart(2, '0')}`);
      if (chosen !== null) ids.add(chosen.id);
    }
    expect(ids.has('p3')).toBe(false);
  });

  it('is null when there is nothing active', () => {
    expect(promptForDay([{ ...prompts[2] } as JournalPrompt], '2026-08-24')).toBeNull();
    expect(promptForDay([], '2026-08-24')).toBeNull();
  });

  it('falls back to the first prompt for a malformed day key', () => {
    expect(promptForDay(prompts, 'not-a-day')?.id).toBe('p1');
  });
});
