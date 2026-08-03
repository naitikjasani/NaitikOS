/**
 * Mind — §4.7, §9.2.
 *
 * §4.7 opens by saying this module "carries the highest duty of care in the
 * system, and its design principles differ from every other module." Three of
 * those principles are structural and are encoded here rather than left to the
 * UI:
 *
 *   - **Journal content is the most sensitive data in the system** and is
 *     "subject to the strictest AI consent scope (§10.10)". Every table here
 *     carries an explicit consent column; nothing defaults to shareable.
 *   - **Therapy content is user-authored only** — §4.7: "nothing here is ever
 *     model-generated." The `isModelGenerated` guard makes that checkable.
 *   - **No causal claims about mental state.** The system records what the user
 *     believed triggered an episode; it never fills that column itself.
 *
 * §9.2's dividing line applies as everywhere else: "Mood, energy, and anxiety
 * *levels* are plain observations. Only things with internal structure become
 * entities." So there is no `mood` table — mood is `mind.mood` in the registry.
 */

import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';

import { consentScope, practiceKind, severity } from './enums';
import {
  entityColumns,
  ianaZone,
  instant,
  quantity,
  reference,
  searchVector,
} from './columns';

/**
 * An anxiety episode.
 *
 * An entity rather than an observation because it has duration, a trigger, a
 * coping response and an outcome — §9.2's "internal structure" test. Intensity
 * is *also* written as an observation so it trends against sleep, training and
 * medication like anything else.
 *
 * `trigger` and `copingResponse` are user-authored. §4.7 forbids the system
 * from asserting either: "'Your mood is low because you skipped the gym' is a
 * claim the system is not entitled to make."
 */
export const anxietyEpisode = pgTable(
  'anxiety_episode',
  {
    ...entityColumns,

    startedAt: instant().notNull(),
    endedAt: instant(),
    zone: ianaZone().notNull(),

    /** 1–5, matching the Daily Close scale (§4.0). */
    intensity: integer(),
    severity: severity(),
    /** Physical symptoms, as the user describes them. */
    physicalSymptoms: text(),

    /** What the user believes set it off. Never inferred. */
    trigger: text(),
    /** What they did. Feeds "what has actually helped before" in the crisis plan. */
    copingResponse: text(),
    /** Did the coping response help? User's judgement, not the system's. */
    outcome: text(),

    note: text(),

    /**
     * Episodes are clinical context, not journal prose. Defaulting to
     * `non_clinical` would be wrong; defaulting to `none` makes sharing a
     * deliberate act (§10.10).
     */
    aiConsent: consentScope().notNull().default('none'),
  },
  (t) => [
    index('anxiety_episode_started_idx').on(t.startedAt.desc()),
    check('anxiety_episode_ordered', sql`${t.endedAt} IS NULL OR ${t.startedAt} <= ${t.endedAt}`),
  ],
);

/**
 * Journal entries — **the most sensitive data in the system** (§4.7).
 *
 * P7 governs this table more than any other: "This database will contain
 * psychiatric medication history, body photographs, and therapy notes. There is
 * no privacy policy that makes third-party analytics acceptable here."
 *
 * Two protections are structural. `aiConsent` defaults to `none` and the check
 * constraint permits only `none` or `journal` — so an entry can never be
 * swept into a broader scope by a bulk update that was reasoning about
 * non-clinical data. And the full-text index is local Postgres (§9.6), which is
 * what lets search work without any content leaving the database.
 */
export const journalEntry = pgTable(
  'journal_entry',
  {
    ...entityColumns,

    writtenAt: instant().notNull(),
    zone: ianaZone().notNull(),

    title: text(),
    content: text().notNull(),

    /** Set when written against a guided prompt (§3.2 `/mind/journal/prompts`). */
    promptId: reference(),
    /** Mood at the time of writing — context the words alone do not carry. */
    moodAtWriting: integer(),

    /** §9.6: "Full-text over journal and documents — generated tsvector with GIN." */
    searchVector: searchVector('title', 'content'),

    aiConsent: consentScope().notNull().default('none'),
  },
  (t) => [
    index('journal_entry_written_idx').on(t.writtenAt.desc()),
    index('journal_entry_search_idx').using('gin', t.searchVector),
    check('journal_entry_consent_restricted', sql`${t.aiConsent} IN ('none', 'journal')`),
  ],
);

/** A guided journal prompt (§3.2). Reference data, not user content. */
export const journalPrompt = pgTable('journal_prompt', {
  ...entityColumns,
  prompt: text().notNull(),
  category: text(),
  isActive: boolean().notNull().default(true),
});

/** Meditation, breathwork, grounding (§4.7). */
export const practiceSession = pgTable(
  'practice_session',
  {
    ...entityColumns,

    kind: practiceKind().notNull(),
    startedAt: instant().notNull(),
    zone: ianaZone().notNull(),
    /** Minutes. Also written as an observation for adherence work. */
    durationMinutes: quantity(),

    /** Guided, unguided, which app — free text, this is not worth a vocabulary. */
    method: text(),
    /** 1–5 before and after. The only honest measure of whether it helped. */
    stateBefore: integer(),
    stateAfter: integer(),
    note: text(),

    aiConsent: consentScope().notNull().default('none'),
  },
  (t) => [index('practice_session_started_idx').on(t.kind, t.startedAt.desc())],
);

/**
 * Therapy sessions — user-authored only.
 *
 * §4.7: "Content is user-authored only; nothing here is ever model-generated."
 * `isModelGenerated` exists so that rule is *checkable* rather than merely
 * stated, and the check constraint pins it false. If a future feature ever
 * wants to draft a summary here, it will have to change a migration — which is
 * exactly the amount of friction that decision deserves.
 */
export const therapySession = pgTable(
  'therapy_session',
  {
    ...entityColumns,

    occurredAt: instant().notNull(),
    zone: ianaZone().notNull(),
    therapist: text(),
    modality: text(),

    /** What was discussed. The user's words. */
    themes: text(),
    /** `[{ text, dueAt, completedAt }]` — between-session commitments. */
    actionItems: jsonb().notNull().default(sql`'[]'::jsonb`),
    followUpAt: instant(),
    note: text(),

    searchVector: searchVector('themes', 'note'),

    /** Pinned false by the constraint below. See the note above. */
    isModelGenerated: boolean().notNull().default(false),
    aiConsent: consentScope().notNull().default('none'),
  },
  (t) => [
    index('therapy_session_occurred_idx').on(t.occurredAt.desc()),
    index('therapy_session_search_idx').using('gin', t.searchVector),
    check('therapy_session_user_authored', sql`${t.isModelGenerated} IS FALSE`),
    check('therapy_session_consent_restricted', sql`${t.aiConsent} IN ('none', 'journal')`),
  ],
);
