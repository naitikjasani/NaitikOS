/**
 * The journal — §4.7's "most sensitive data in the system".
 *
 * ## Three rules, all structural
 *
 * **1. Consent can only ever be `none` or `journal`.** The schema pins it with
 * a check constraint; {@link planJournalEntry} refuses the write before it gets
 * there, so a caller learns about it as a validation error rather than a 500.
 * The scope exists so a future bulk update reasoning about non-clinical data
 * cannot sweep journal prose into a broader AI consent (§10.10).
 *
 * **2. A list never renders prose.** {@link journalListItem} deliberately has no
 * `excerpt` field. The obvious design — date, first hundred and twenty
 * characters, chevron — means the darkest thing the operator has ever written
 * is on screen the moment they open the tab, on a train, at work. §4.7 calls
 * this the most sensitive data in the system; a list that leaks it by default
 * is a bad trade for a scanning convenience that a title already provides.
 *
 * **3. Mood at writing is not an observation.** It is a column, and the reason
 * is arithmetic. `mind.mood` aggregates as `mean`; if a journal entry wrote one,
 * then "mood on 12 August" would depend on *how many times the operator
 * journaled that day* — three entries on a rough evening would drag the day's
 * figure toward the rough evening. The Close's mood is one deliberate daily
 * judgement and stays the only thing that answers that question. The
 * mood-at-writing stays where it is useful: next to the words it accompanied.
 */

import type { Result } from '@naitikos/shared';
import { err, ok } from '@naitikos/shared';

import type { DomainError } from '../../errors/domain-error';
import { validationError } from '../../errors/domain-error';
import { parseInstant } from '../../temporal/instant';
import { isIanaZone } from '../../temporal/zone';
import { dayKeyInZone } from '../../timeline/grouping';

/** The only consent scopes a journal entry may carry (§10.10). */
export const JOURNAL_CONSENT_SCOPES = Object.freeze(['none', 'journal'] as const);
export type JournalConsent = (typeof JOURNAL_CONSENT_SCOPES)[number];

/**
 * The longest entry accepted in one row.
 *
 * Sixty-four thousand characters — roughly ten thousand words, far past any
 * plausible sitting. It is a paste-accident guard, not an editorial limit.
 */
export const MAX_JOURNAL_CHARACTERS = 64_000;

export type JournalEntry = {
  readonly id: string;
  readonly writtenAt: string;
  readonly zone: string;
  readonly title: string | null;
  readonly content: string;
  readonly promptId: string | null;
  readonly moodAtWriting: number | null;
  readonly aiConsent: JournalConsent;
};

export type JournalEntryInput = {
  readonly id: string;
  readonly writtenAt: string;
  readonly zone: string;
  readonly title?: string | null;
  readonly content: string;
  readonly promptId?: string | null;
  readonly moodAtWriting?: number | null;
  readonly aiConsent?: JournalConsent;
};

export function planJournalEntry(input: JournalEntryInput): Result<JournalEntry, DomainError> {
  if (parseInstant(input.writtenAt) === null) {
    return err(validationError('journal_written_at_invalid', 'writtenAt must be an ISO-8601 instant.'));
  }
  if (!isIanaZone(input.zone)) {
    return err(validationError('journal_zone_invalid', 'zone must be an IANA zone name (§5.3).'));
  }

  const content = input.content.trim();
  if (content.length === 0) {
    return err(validationError('journal_content_empty', 'An entry with no content is not an entry.'));
  }
  if (content.length > MAX_JOURNAL_CHARACTERS) {
    return err(
      validationError(
        'journal_content_too_long',
        `An entry may hold at most ${String(MAX_JOURNAL_CHARACTERS)} characters.`,
      ),
    );
  }

  const mood = input.moodAtWriting ?? null;
  if (mood !== null && (!Number.isInteger(mood) || mood < 1 || mood > 5)) {
    return err(validationError('journal_mood_range', 'moodAtWriting must be an integer from 1 to 5.'));
  }

  const consent = input.aiConsent ?? 'none';
  if (!JOURNAL_CONSENT_SCOPES.includes(consent)) {
    return err(
      validationError(
        'journal_consent_scope',
        "Journal entries may only carry the 'none' or 'journal' AI consent scope (§10.10).",
      ),
    );
  }

  const title = input.title?.trim() ?? '';

  return ok({
    id: input.id,
    writtenAt: input.writtenAt,
    zone: input.zone,
    title: title.length === 0 ? null : title,
    content,
    promptId: input.promptId ?? null,
    moodAtWriting: mood,
    aiConsent: consent,
  });
}

/* -------------------------------------------------------------------------
 * Listing, without leaking
 * ---------------------------------------------------------------------- */

export type JournalListItem = {
  readonly id: string;
  readonly dayKey: string;
  readonly writtenAt: string;
  /**
   * The operator's own title, or a neutral placeholder.
   *
   * The placeholder is *not* derived from the content — deriving it would be
   * an excerpt with a different name, and rule 2 above exists precisely to stop
   * that. It says how long the entry is and nothing about what is in it.
   */
  readonly heading: string;
  readonly wordCount: number;
  readonly moodAtWriting: number | null;
  readonly hasPrompt: boolean;
};

export function wordCount(content: string): number {
  const trimmed = content.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/u).length;
}

export function journalListItem(entry: JournalEntry): JournalListItem {
  const words = wordCount(entry.content);
  return {
    id: entry.id,
    dayKey: dayKeyInZone(entry.writtenAt, entry.zone),
    writtenAt: entry.writtenAt,
    heading: entry.title ?? `${String(words)} ${words === 1 ? 'word' : 'words'}`,
    wordCount: words,
    moodAtWriting: entry.moodAtWriting,
    hasPrompt: entry.promptId !== null,
  };
}

/* -------------------------------------------------------------------------
 * Guided prompts
 * ---------------------------------------------------------------------- */

export type JournalPrompt = {
  readonly id: string;
  readonly prompt: string;
  readonly category: string | null;
  readonly isActive: boolean;
};

/**
 * The prompt offered on a given day.
 *
 * Deterministic in the day key, for two reasons that both matter more than they
 * look. A random prompt changes on every re-render, so the operator loses the
 * one they were halfway through answering when the query refetches. And a
 * *stable* prompt means "today's prompt" is the same question on the phone and
 * on the laptop, which is what makes it feel like a prompt rather than a slot
 * machine.
 *
 * Rotation is by day index rather than by a hash, so consecutive days get
 * consecutive prompts and the operator is not handed the same one twice in a
 * week by coincidence.
 */
export function promptForDay(prompts: readonly JournalPrompt[], dayKey: string): JournalPrompt | null {
  const active = prompts.filter((prompt) => prompt.isActive);
  if (active.length === 0) return null;
  const ordinal = dayOrdinal(dayKey);
  if (ordinal === null) return active[0] ?? null;
  return active[ordinal % active.length] ?? null;
}

/**
 * A stable non-negative ordinal for a `YYYY-MM-DD` key.
 *
 * Digits only, so it needs no calendar arithmetic and no `Date` (§11.3). It is
 * not a day count and does not need to be — it only has to advance by one on
 * most days and never go backwards within a month, which `y*372 + m*31 + d`
 * does.
 */
function dayOrdinal(dayKey: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(dayKey);
  if (match === null) return null;
  const [, year, month, day] = match;
  if (year === undefined || month === undefined || day === undefined) return null;
  return Number(year) * 372 + Number(month) * 31 + Number(day);
}
