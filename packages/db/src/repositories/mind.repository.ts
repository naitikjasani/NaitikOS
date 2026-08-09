/**
 * Mind, persisted — episodes, journal, practices, and the crisis plan.
 *
 * `core/domain/mind` decides what these mean; this writes them. Two things this
 * file decides on its own:
 *
 * **Atomicity, the same way `workout.repository.ts` does it.** An episode is an
 * entity row *and* an anxiety observation; a practice is a row *and* a duration
 * observation. A write that landed one without the other would leave the record
 * disagreeing with itself, and the entity row is the idempotency anchor for the
 * observations it carries — because the observations are re-planned with fresh
 * ids on every replay and `append` would not recognise them.
 *
 * **Reads never return journal prose in a list.** {@link MindRepository.journalList}
 * selects the columns a list needs and *not* `content`. That is not an
 * optimisation. §4.7 calls journal content the most sensitive data in the
 * system, and a list endpoint that returns it puts every entry into any log,
 * cache or error report that touches the response.
 */

import { and, desc, eq, gte, isNull, lt, ne, sql } from 'drizzle-orm';
import type { Result } from '@naitikos/shared';
import { err, ok } from '@naitikos/shared';
import type {
  AnxietyEpisode,
  CrisisContact,
  CrisisPlan,
  DomainError,
  EpisodeSeverity,
  JournalConsent,
  JournalEntry,
  JournalListItem,
  JournalPrompt,
  Observation,
  PlannedEpisode,
  PlannedPractice,
  PracticeKind,
  PracticeSession,
} from '@naitikos/core';
import {
  conflictError,
  dayKeyInZone,
  isDomainError,
  parseContacts,
  prepareObservations,
  wordCount,
} from '@naitikos/core';

import type { Database } from '../client';
import { crisisPlan } from '../schema/identity';
import { anxietyEpisode, journalEntry, journalPrompt, practiceSession } from '../schema/mind';
import { createObservationRepository } from './observation.repository';
import type { WriteContext } from './workout.repository';

/** Carries a domain error out through a rolled-back transaction (§5.12). */
class TransactionAbort extends Error {
  readonly domainError: DomainError;

  constructor(domainError: DomainError) {
    super(domainError.message);
    this.name = 'TransactionAbort';
    this.domainError = domainError;
  }
}

function fromAbort(error: unknown): DomainError | null {
  if (error instanceof TransactionAbort) return error.domainError;
  return isDomainError(error) ? error : null;
}

/* -------------------------------------------------------------------------
 * Row mapping
 * ---------------------------------------------------------------------- */

function toEpisode(row: typeof anxietyEpisode.$inferSelect): AnxietyEpisode {
  return {
    id: row.id,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    zone: row.zone,
    intensity: row.intensity,
    severity: row.severity as EpisodeSeverity | null,
    physicalSymptoms: row.physicalSymptoms,
    trigger: row.trigger,
    copingResponse: row.copingResponse,
    outcome: row.outcome,
    note: row.note,
  };
}

function toPractice(row: typeof practiceSession.$inferSelect): PracticeSession {
  return {
    id: row.id,
    kind: row.kind as PracticeKind,
    startedAt: row.startedAt,
    zone: row.zone,
    durationMinutes: row.durationMinutes === null ? null : Number(row.durationMinutes),
    method: row.method,
    stateBefore: row.stateBefore,
    stateAfter: row.stateAfter,
    note: row.note,
  };
}

function toEntry(row: typeof journalEntry.$inferSelect): JournalEntry {
  return {
    id: row.id,
    writtenAt: row.writtenAt,
    zone: row.zone,
    title: row.title,
    content: row.content,
    promptId: row.promptId,
    moodAtWriting: row.moodAtWriting,
    // The check constraint permits only these two, but the column is an enum
    // with wider values; narrowing here keeps the type honest either way.
    aiConsent: row.aiConsent === 'journal' ? 'journal' : ('none' as JournalConsent),
  };
}

/* -------------------------------------------------------------------------
 * The repository
 * ---------------------------------------------------------------------- */

export type EpisodeWritten = {
  readonly episode: AnxietyEpisode;
  readonly hlc: string | null;
  readonly written: boolean;
};

export type PracticeWritten = {
  readonly practice: PracticeSession;
  readonly hlc: string | null;
  readonly written: boolean;
};

export type MindRepository = {
  logEpisode(planned: PlannedEpisode, context: WriteContext): Promise<Result<EpisodeWritten, DomainError>>;
  /** Episodes started in `[from, until)`, newest first. */
  episodesBetween(from: string, until: string): Promise<Result<readonly AnxietyEpisode[], DomainError>>;
  recentEpisodes(limit?: number): Promise<Result<readonly AnxietyEpisode[], DomainError>>;
  /** Close an open episode. Idempotent: a closed episode keeps its end time. */
  closeEpisode(id: string, endedAt: string): Promise<Result<AnxietyEpisode | null, DomainError>>;

  writeJournalEntry(entry: JournalEntry): Promise<Result<JournalEntry, DomainError>>;
  /** Headings and counts only — never prose. See the file header. */
  journalList(limit?: number): Promise<Result<readonly JournalListItem[], DomainError>>;
  journalEntryById(id: string): Promise<Result<JournalEntry | null, DomainError>>;
  prompts(): Promise<Result<readonly JournalPrompt[], DomainError>>;

  logPractice(planned: PlannedPractice, context: WriteContext): Promise<Result<PracticeWritten, DomainError>>;
  recentPractices(limit?: number): Promise<Result<readonly PracticeSession[], DomainError>>;

  activeCrisisPlan(): Promise<Result<CrisisPlan | null, DomainError>>;
};

export function createMindRepository(db: Database): MindRepository {
  return {
    async logEpisode(planned, context) {
      const observations = createObservationRepository(db);
      const sourceId = await observations.manualSourceId();
      if (!sourceId.ok) return sourceId;

      const prepared = prepareObservations(planned.observations, context.hlcState, {
        registry: context.registry,
        sourceId: sourceId.value as Observation['sourceId'],
        newId: context.newId,
        recordedAt: context.recordedAt,
        physicalMillis: context.physicalMillis,
      });
      if (!prepared.ok) return err(prepared.error);

      try {
        return await db.transaction(async (tx) => {
          const inserted = await tx
            .insert(anxietyEpisode)
            .values({
              id: planned.episode.id,
              startedAt: planned.episode.startedAt,
              endedAt: planned.episode.endedAt,
              zone: planned.episode.zone,
              intensity: planned.episode.intensity,
              severity: planned.episode.severity,
              physicalSymptoms: planned.episode.physicalSymptoms,
              trigger: planned.episode.trigger,
              copingResponse: planned.episode.copingResponse,
              outcome: planned.episode.outcome,
              note: planned.episode.note,
            })
            .onConflictDoNothing({ target: anxietyEpisode.id })
            .returning({ id: anxietyEpisode.id });

          const rows = await tx
            .select()
            .from(anxietyEpisode)
            .where(eq(anxietyEpisode.id, planned.episode.id))
            .limit(1);
          const row = rows[0];
          if (row === undefined) {
            throw new TransactionAbort(
              conflictError('anxiety_episode', 'invalid_state', {
                code: 'anxiety_episode_not_written',
                message: 'The episode could not be recorded.',
              }),
            );
          }

          // Replay: the row is the anchor, so nothing further is written.
          if (inserted.length === 0) return ok({ episode: toEpisode(row), hlc: null, written: false });

          if (prepared.value.observations.length > 0) {
            const appended = await createObservationRepository(tx).append(prepared.value.observations);
            if (!appended.ok) throw new TransactionAbort(appended.error);
          }

          return ok({
            episode: toEpisode(row),
            hlc: prepared.value.observations.at(-1)?.hlc ?? null,
            written: true,
          });
        });
      } catch (error) {
        const domainError = fromAbort(error);
        if (domainError === null) throw error;
        return err(domainError);
      }
    },

    async episodesBetween(from, until) {
      const rows = await db
        .select()
        .from(anxietyEpisode)
        .where(
          and(
            gte(anxietyEpisode.startedAt, from),
            lt(anxietyEpisode.startedAt, until),
            isNull(anxietyEpisode.deletedAt),
          ),
        )
        .orderBy(desc(anxietyEpisode.startedAt));
      return ok(rows.map(toEpisode));
    },

    async recentEpisodes(limit = 50) {
      const rows = await db
        .select()
        .from(anxietyEpisode)
        .where(isNull(anxietyEpisode.deletedAt))
        .orderBy(desc(anxietyEpisode.startedAt))
        .limit(limit);
      return ok(rows.map(toEpisode));
    },

    async closeEpisode(id, endedAt) {
      /*
       * Guarded by `ended_at IS NULL`, the same idempotency shape as closing a
       * workout session. A replayed close leaves the original end time alone;
       * without the guard, a retry an hour later would lengthen the episode by
       * exactly the sync delay.
       */
      const updated = await db
        .update(anxietyEpisode)
        .set({ endedAt, updatedAt: sql`now()`, version: sql`${anxietyEpisode.version} + 1` })
        .where(and(eq(anxietyEpisode.id, id), isNull(anxietyEpisode.endedAt)))
        .returning();

      if (updated[0] !== undefined) return ok(toEpisode(updated[0]));

      const rows = await db.select().from(anxietyEpisode).where(eq(anxietyEpisode.id, id)).limit(1);
      return ok(rows[0] === undefined ? null : toEpisode(rows[0]));
    },

    async writeJournalEntry(entry) {
      await db
        .insert(journalEntry)
        .values({
          id: entry.id,
          writtenAt: entry.writtenAt,
          zone: entry.zone,
          title: entry.title,
          content: entry.content,
          promptId: entry.promptId,
          moodAtWriting: entry.moodAtWriting,
          aiConsent: entry.aiConsent,
        })
        /*
         * `DO UPDATE`, unlike every other write in this package.
         *
         * A journal entry is prose the operator edits — they open yesterday's
         * entry, add a paragraph, and save. That is an update to the same id,
         * not a replay, and `DO NOTHING` would silently discard the paragraph.
         * The audit trail (§9.4) keeps the previous text.
         */
        .onConflictDoUpdate({
          target: journalEntry.id,
          set: {
            title: entry.title,
            content: entry.content,
            moodAtWriting: entry.moodAtWriting,
            aiConsent: entry.aiConsent,
            updatedAt: sql`now()`,
            version: sql`${journalEntry.version} + 1`,
          },
        });

      const rows = await db.select().from(journalEntry).where(eq(journalEntry.id, entry.id)).limit(1);
      const row = rows[0];
      if (row === undefined) {
        return err(
          conflictError('journal_entry', 'invalid_state', {
            code: 'journal_entry_not_written',
            message: 'The entry could not be saved.',
          }),
        );
      }
      return ok(toEntry(row));
    },

    async journalList(limit = 60) {
      const rows = await db
        .select({
          id: journalEntry.id,
          writtenAt: journalEntry.writtenAt,
          zone: journalEntry.zone,
          title: journalEntry.title,
          moodAtWriting: journalEntry.moodAtWriting,
          promptId: journalEntry.promptId,
          /*
           * The word count is computed in SQL so `content` never enters the
           * result set. `regexp_split_to_array` on whitespace, minus the empty
           * trailing element a trailing space produces.
           */
          words: sql<number>`
            coalesce(
              array_length(
                regexp_split_to_array(btrim(${journalEntry.content}), '\\s+'),
                1
              ),
              0
            )::int
          `,
        })
        .from(journalEntry)
        .where(isNull(journalEntry.deletedAt))
        .orderBy(desc(journalEntry.writtenAt))
        .limit(limit);

      return ok(
        rows.map((row) => ({
          id: row.id,
          dayKey: dayKeyInZone(row.writtenAt, row.zone),
          writtenAt: row.writtenAt,
          heading: row.title ?? `${String(row.words)} ${row.words === 1 ? 'word' : 'words'}`,
          wordCount: row.words,
          moodAtWriting: row.moodAtWriting,
          hasPrompt: row.promptId !== null,
        })),
      );
    },

    async journalEntryById(id) {
      const rows = await db
        .select()
        .from(journalEntry)
        .where(and(eq(journalEntry.id, id), isNull(journalEntry.deletedAt)))
        .limit(1);
      return ok(rows[0] === undefined ? null : toEntry(rows[0]));
    },

    async prompts() {
      const rows = await db
        .select()
        .from(journalPrompt)
        .where(isNull(journalPrompt.deletedAt))
        .orderBy(journalPrompt.createdAt);
      return ok(
        rows.map((row) => ({
          id: row.id,
          prompt: row.prompt,
          category: row.category,
          isActive: row.isActive,
        })),
      );
    },

    async logPractice(planned, context) {
      const observations = createObservationRepository(db);
      const sourceId = await observations.manualSourceId();
      if (!sourceId.ok) return sourceId;

      const prepared = prepareObservations(planned.observations, context.hlcState, {
        registry: context.registry,
        sourceId: sourceId.value as Observation['sourceId'],
        newId: context.newId,
        recordedAt: context.recordedAt,
        physicalMillis: context.physicalMillis,
      });
      if (!prepared.ok) return err(prepared.error);

      try {
        return await db.transaction(async (tx) => {
          const inserted = await tx
            .insert(practiceSession)
            .values({
              id: planned.practice.id,
              kind: planned.practice.kind,
              startedAt: planned.practice.startedAt,
              zone: planned.practice.zone,
              durationMinutes:
                planned.practice.durationMinutes === null
                  ? null
                  : planned.practice.durationMinutes.toString(),
              method: planned.practice.method,
              stateBefore: planned.practice.stateBefore,
              stateAfter: planned.practice.stateAfter,
              note: planned.practice.note,
            })
            .onConflictDoNothing({ target: practiceSession.id })
            .returning({ id: practiceSession.id });

          const rows = await tx
            .select()
            .from(practiceSession)
            .where(eq(practiceSession.id, planned.practice.id))
            .limit(1);
          const row = rows[0];
          if (row === undefined) {
            throw new TransactionAbort(
              conflictError('practice_session', 'invalid_state', {
                code: 'practice_session_not_written',
                message: 'The practice could not be recorded.',
              }),
            );
          }

          if (inserted.length === 0) return ok({ practice: toPractice(row), hlc: null, written: false });

          if (prepared.value.observations.length > 0) {
            const appended = await createObservationRepository(tx).append(prepared.value.observations);
            if (!appended.ok) throw new TransactionAbort(appended.error);
          }

          return ok({
            practice: toPractice(row),
            hlc: prepared.value.observations.at(-1)?.hlc ?? null,
            written: true,
          });
        });
      } catch (error) {
        const domainError = fromAbort(error);
        if (domainError === null) throw error;
        return err(domainError);
      }
    },

    async recentPractices(limit = 30) {
      const rows = await db
        .select()
        .from(practiceSession)
        .where(isNull(practiceSession.deletedAt))
        .orderBy(desc(practiceSession.startedAt))
        .limit(limit);
      return ok(rows.map(toPractice));
    },

    async activeCrisisPlan() {
      const rows = await db
        .select()
        .from(crisisPlan)
        .where(and(eq(crisisPlan.isActive, true), isNull(crisisPlan.deletedAt)))
        .limit(1);

      const row = rows[0];
      if (row === undefined) return ok(null);

      return ok({
        id: row.id,
        isActive: row.isActive,
        warningSigns: row.warningSigns,
        copingStrategies: row.copingStrategies,
        reasonsToLive: row.reasonsToLive,
        contacts: parseContacts(row.contacts),
        professionalContacts: parseContacts(row.professionalContacts),
        lastReviewedAt: row.lastReviewedAt,
      });
    },
  };
}

/** Exported for the test that asserts SQL and TypeScript agree about counting. */
export const journalWordCount = wordCount;

/* -------------------------------------------------------------------------
 * The crisis plan — §2.1's "no manual database intervention required"
 * ---------------------------------------------------------------------- */

export type CrisisPlanInput = {
  readonly id: string;
  readonly warningSigns: string | null;
  readonly copingStrategies: string | null;
  readonly reasonsToLive: string | null;
  readonly contacts: readonly CrisisContact[];
  readonly professionalContacts: readonly CrisisContact[];
  readonly reviewedAt: string;
};

/**
 * Write the crisis plan.
 *
 * ## Exactly one plan is active, and the old one is retained
 *
 * `crisis_plan_one_active` is a partial unique index, so activating a new plan
 * requires deactivating the current one in the same transaction. The old row is
 * **kept** rather than deleted — the schema comment says why: "a superseded plan
 * is replaced by a newer active one, so there is always something to show."
 *
 * The history matters for a second reason §4.7 implies. A plan is written when
 * well and read when not; being able to see what a previous version said is the
 * difference between "I have written this before" and "I have to start again".
 *
 * ## `aiConsent` is never passed in
 *
 * It is not a parameter, it is not in the contract, and the check constraint
 * pins it to `none`. §10.10's strictest scope, made structural in three places
 * rather than promised in one.
 */
export async function writeCrisisPlan(
  db: Database,
  input: CrisisPlanInput,
): Promise<Result<CrisisPlan, DomainError>> {
  return db.transaction(async (tx) => {
    /*
     * Deactivate first, and *exclude the row being written* — otherwise an edit
     * to the active plan deactivates itself a statement before it is upserted,
     * and a crash between the two would leave the operator with no active plan
     * at all. That is the one failure this table must never have.
     */
    await tx
      .update(crisisPlan)
      .set({ isActive: false, updatedAt: sql`now()` })
      .where(and(eq(crisisPlan.isActive, true), ne(crisisPlan.id, input.id)));

    await tx
      .insert(crisisPlan)
      .values({
        id: input.id,
        isActive: true,
        warningSigns: input.warningSigns,
        copingStrategies: input.copingStrategies,
        reasonsToLive: input.reasonsToLive,
        contacts: [...input.contacts],
        professionalContacts: [...input.professionalContacts],
        lastReviewedAt: input.reviewedAt,
      })
      .onConflictDoUpdate({
        target: crisisPlan.id,
        set: {
          isActive: true,
          warningSigns: input.warningSigns,
          copingStrategies: input.copingStrategies,
          reasonsToLive: input.reasonsToLive,
          contacts: [...input.contacts],
          professionalContacts: [...input.professionalContacts],
          lastReviewedAt: input.reviewedAt,
          updatedAt: sql`now()`,
          version: sql`${crisisPlan.version} + 1`,
        },
      });

    const rows = await tx.select().from(crisisPlan).where(eq(crisisPlan.id, input.id)).limit(1);
    const row = rows[0];
    if (row === undefined) throw new Error('crisis_plan_not_written');

    return ok({
      id: row.id,
      isActive: row.isActive,
      warningSigns: row.warningSigns,
      copingStrategies: row.copingStrategies,
      reasonsToLive: row.reasonsToLive,
      contacts: parseContacts(row.contacts),
      professionalContacts: parseContacts(row.professionalContacts),
      lastReviewedAt: row.lastReviewedAt,
    });
  });
}
