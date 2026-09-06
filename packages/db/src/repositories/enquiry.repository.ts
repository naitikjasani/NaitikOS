/**
 * Saved lines of enquiry, persisted — §3.2's `/ask/:threadId`.
 *
 * ## `lastAskedAt` is written by the same statement that adds a turn
 *
 * Denormalised onto the thread because the list orders by it, and the
 * alternative is a correlated subquery over `ask_turn` on every page load. The
 * two writes share a transaction, so a thread can never claim a turn that was
 * not stored — which would be worse than a stale ordering, because the list
 * would show activity that did not happen.
 *
 * ## The answer comes back as `unknown`
 *
 * `ask_turn.answer` is `jsonb` holding `answerSchema`'s shape, and that schema
 * lives in `@naitikos/ai`, which sits *above* `db` in §5.0's layering. So this
 * returns the column untyped and the app layer parses it. That is not a
 * limitation being worked around: a row read back in 2031 may predate the
 * current schema, and forcing it through today's type on the way out of the
 * database would make an old turn unreadable rather than merely old.
 */

import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Result } from '@naitikos/shared';
import { ok } from '@naitikos/shared';
import type { DomainError } from '@naitikos/core';
import { notFoundError, parseSqlTimestamp } from '@naitikos/core';

import type { Database } from '../client';
import { askThread, askTurn } from '../schema/enquiry';

export type AskThreadRow = {
  readonly id: string;
  readonly title: string;
  readonly note: string | null;
  readonly lastAskedAt: string | null;
  readonly createdAt: string;
  /** How many turns it holds, for the list. */
  readonly turnCount: number;
};

export type AskTurnRow = {
  readonly id: string;
  readonly threadId: string;
  readonly question: string;
  readonly kind: string;
  readonly windowDays: number;
  /** `answerSchema`'s shape, unparsed. See the header. */
  readonly answer: unknown;
  readonly omitted: string | null;
  readonly problem: string | null;
  readonly interactionId: string | null;
  readonly askedAt: string;
};

export type ThreadInput = {
  readonly id: string;
  readonly title: string;
  readonly note: string | null;
};

export type TurnInput = {
  readonly id: string;
  readonly threadId: string;
  readonly question: string;
  readonly kind: string;
  readonly windowDays: number;
  readonly answer: unknown;
  readonly omitted: string | null;
  readonly problem: string | null;
  readonly interactionId: string | null;
  readonly askedAt: string;
};

export type EnquiryRepository = {
  /** Every live thread, most recently asked first. */
  threads(): Promise<Result<readonly AskThreadRow[], DomainError>>;
  thread(id: string): Promise<Result<AskThreadRow | null, DomainError>>;
  saveThread(input: ThreadInput): Promise<Result<AskThreadRow, DomainError>>;
  deleteThread(id: string, reason: string | null, at: string): Promise<Result<void, DomainError>>;

  /** One thread's turns, newest first. */
  turns(threadId: string): Promise<Result<readonly AskTurnRow[], DomainError>>;
  /** Adds a turn and stamps the thread's `lastAskedAt`, in one transaction. */
  addTurn(input: TurnInput): Promise<Result<AskTurnRow, DomainError>>;
  deleteTurn(id: string, reason: string | null, at: string): Promise<Result<void, DomainError>>;
};

function toTurn(row: typeof askTurn.$inferSelect): AskTurnRow {
  return {
    id: row.id,
    threadId: row.threadId,
    question: row.question,
    kind: row.kind,
    windowDays: row.windowDays,
    answer: row.answer,
    omitted: row.omitted,
    problem: row.problem,
    interactionId: row.interactionId,
    askedAt: row.askedAt,
  };
}

export function createEnquiryRepository(db: Database): EnquiryRepository {
  return {
    async threads() {
      /*
       * `NULLS LAST` on the ordering, and it is the whole of the list's
       * behaviour. A thread created as a placeholder and never asked has a null
       * `last_asked_at`; Postgres sorts nulls first under `DESC` by default,
       * which would put an empty thread from six months ago above a live
       * enquiry answered this morning.
       */
      const rows = await db.execute(sql`
        select t.id,
               t.title,
               t.note,
               t.last_asked_at,
               t.created_at,
               coalesce(c.total, 0) as turn_count
          from ask_thread t
          left join lateral (
            select count(*)::int as total
              from ask_turn u
             where u.thread_id = t.id and u.deleted_at is null
          ) c on true
         where t.deleted_at is null
         order by t.last_asked_at desc nulls last, t.created_at desc
      `);

      const typed = rows as unknown as readonly {
        id: string;
        title: string;
        note: string | null;
        last_asked_at: string | null;
        created_at: string;
        turn_count: number | null;
      }[];

      /*
       * `parseSqlTimestamp`, because this query is raw.
       *
       * Drizzle's `instant()` mapping normalises `timestamptz` on the way out
       * of a *composed* query; `db.execute` returns whatever the driver hands
       * back, which is Postgres's own text form — `2026-09-06 10:00:00+00`,
       * with a space and a two-digit offset. That is not ISO 8601, `Date`
       * rejects it in V8, and it would have reached the client as a string
       * rendering as "Invalid Date". Caught by a test comparing against an
       * instant rather than against itself.
       */
      return ok(
        typed.map((row) => ({
          id: row.id,
          title: row.title,
          note: row.note,
          lastAskedAt: row.last_asked_at === null ? null : parseSqlTimestamp(row.last_asked_at),
          createdAt: parseSqlTimestamp(row.created_at) ?? row.created_at,
          turnCount: Number(row.turn_count ?? 0),
        })),
      );
    },

    async thread(id) {
      const all = await this.threads();
      if (!all.ok) return all;
      return ok(all.value.find((row) => row.id === id) ?? null);
    },

    async saveThread(input) {
      const rows = await db
        .insert(askThread)
        .values({ id: input.id, title: input.title, note: input.note })
        .onConflictDoUpdate({
          target: askThread.id,
          set: {
            title: input.title,
            note: input.note,
            updatedAt: sql`now()`,
            version: sql`${askThread.version} + 1`,
          },
        })
        .returning();

      const row = rows[0];
      if (row === undefined) return { ok: false, error: notFoundError('ask_thread', input.id) };

      return ok({
        id: row.id,
        title: row.title,
        note: row.note,
        lastAskedAt: row.lastAskedAt,
        createdAt: row.createdAt,
        /* An upsert cannot know the count without a second read, and the caller
         * that just saved a title does not need one. The list query is where
         * the count is authoritative. */
        turnCount: 0,
      });
    },

    async deleteThread(id, reason, at) {
      const rows = await db
        .update(askThread)
        .set({ deletedAt: at, deleteReason: reason, updatedAt: at })
        .where(and(eq(askThread.id, id), isNull(askThread.deletedAt)))
        .returning({ id: askThread.id });

      if (rows[0] === undefined) return { ok: false, error: notFoundError('ask_thread', id) };
      return ok(undefined);
    },

    async turns(threadId) {
      const rows = await db
        .select()
        .from(askTurn)
        .where(and(eq(askTurn.threadId, threadId), isNull(askTurn.deletedAt)))
        .orderBy(desc(askTurn.askedAt));

      return ok(rows.map(toTurn));
    },

    async addTurn(input) {
      /*
       * One transaction, because the denormalised `last_asked_at` is only safe
       * while it cannot outrun the turn it describes. A thread claiming
       * activity that was rolled back would show a line of enquiry as pursued
       * when nothing was asked.
       */
      const written = await db.transaction(async (tx) => {
        const rows = await tx
          .insert(askTurn)
          .values({
            id: input.id,
            threadId: input.threadId,
            question: input.question,
            kind: input.kind,
            windowDays: input.windowDays,
            answer: input.answer ?? null,
            omitted: input.omitted,
            problem: input.problem,
            interactionId: input.interactionId,
            askedAt: input.askedAt,
          })
          .returning();

        /*
         * `greatest`, not an assignment.
         *
         * Backfilling an old question is legitimate — the operator remembers
         * having asked something in March and records it — and it must not make
         * a live enquiry look stale. The stamp answers "when was this last
         * pursued", so adding a record *of* March does not mean March was more
         * recent. `greatest` ignores nulls, so the first turn on a fresh thread
         * still sets it.
         */
        await tx
          .update(askThread)
          .set({
            lastAskedAt: sql`greatest(${askThread.lastAskedAt}, ${input.askedAt}::timestamptz)`,
            updatedAt: input.askedAt,
          })
          .where(eq(askThread.id, input.threadId));

        return rows[0];
      });

      if (written === undefined) return { ok: false, error: notFoundError('ask_turn', input.id) };
      return ok(toTurn(written));
    },

    async deleteTurn(id, reason, at) {
      const rows = await db
        .update(askTurn)
        .set({ deletedAt: at, deleteReason: reason, updatedAt: at })
        .where(and(eq(askTurn.id, id), isNull(askTurn.deletedAt)))
        .returning({ id: askTurn.id });

      if (rows[0] === undefined) return { ok: false, error: notFoundError('ask_turn', id) };
      return ok(undefined);
    },
  };
}
