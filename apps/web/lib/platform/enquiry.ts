/**
 * Saved lines of enquiry, assembled — §3.2's `/ask/:threadId`.
 *
 * ## Answers are re-rendered on every read, never cached
 *
 * A stored turn holds what the model produced — templates and reference ids —
 * and the figures are resolved against the log each time the thread is opened.
 * That is the point of the indirection rather than an inefficiency: §9.1 makes
 * a correction a supersession, so an answer written in March renders March's
 * figure until that observation is corrected, and then renders the correction
 * with a note saying so. Caching the rendered prose would freeze a number that
 * the record no longer agrees with.
 *
 * ## An unparseable stored answer is shown as unreadable, not skipped
 *
 * `ask_turn.answer` is `jsonb` and a row from 2031 may predate whatever
 * `answerSchema` looks like then. Parsing is attempted and a failure produces a
 * turn marked unreadable, with its question intact — because the question is
 * the operator's and is legible forever, while the answer was the model's.
 * Dropping the turn would make a thread look like it was never pursued.
 */

import 'server-only';

import type { Result } from '@naitikos/shared';
import { ok } from '@naitikos/shared';
import type { DomainError } from '@naitikos/core';
import type { Answer, Narration } from '@naitikos/ai';
import { answerSchema } from '@naitikos/ai';
import type { AskThreadRow, Database } from '@naitikos/db';
import { createEnquiryRepository } from '@naitikos/db';

import type { RenderedParagraph } from './references';
import { renderNarrations } from './references';

export type ThreadTurn = {
  readonly id: string;
  readonly question: string;
  readonly kind: string;
  readonly windowDays: number;
  readonly askedAt: string;
  readonly omitted: string | null;
  readonly problem: string | null;
  /** Empty when the turn produced no answer, or when the stored one is unreadable. */
  readonly paragraphs: readonly RenderedParagraph[];
  readonly answerable: boolean;
  /** True when the stored answer no longer parses against the current schema. */
  readonly unreadable: boolean;
  readonly unresolvedReferences: number;
};

export type ThreadDetail = {
  readonly thread: AskThreadRow;
  /** Newest first, as the repository returns them. */
  readonly turns: readonly ThreadTurn[];
};

export type EnquiryBoard = {
  readonly threads: readonly AskThreadRow[];
};

export async function loadThreads(db: Database): Promise<Result<EnquiryBoard, DomainError>> {
  const threads = await createEnquiryRepository(db).threads();
  if (!threads.ok) return threads;
  return ok({ threads: threads.value });
}

export async function loadThread(db: Database, threadId: string): Promise<Result<ThreadDetail | null, DomainError>> {
  const enquiry = createEnquiryRepository(db);

  const thread = await enquiry.thread(threadId);
  if (!thread.ok) return thread;
  if (thread.value === null) return ok(null);

  const rows = await enquiry.turns(threadId);
  if (!rows.ok) return rows;

  const turns: ThreadTurn[] = [];
  for (const row of rows.value) {
    const parsed = row.answer === null ? null : answerSchema.safeParse(row.answer);

    if (parsed !== null && !parsed.success) {
      turns.push({
        id: row.id,
        question: row.question,
        kind: row.kind,
        windowDays: row.windowDays,
        askedAt: row.askedAt,
        omitted: row.omitted,
        problem: row.problem,
        paragraphs: [],
        answerable: false,
        unreadable: true,
        unresolvedReferences: 0,
      });
      continue;
    }

    const answer: Answer | null = parsed === null ? null : parsed.data;
    const narrations: readonly Narration[] = answer === null ? [] : answer.paragraphs;

    /*
     * Rendered per turn rather than once for the thread.
     *
     * Batching every turn's references into one lookup would be fewer queries
     * and would also mean a thread's oldest answer sharing a resolution pass
     * with its newest — harmless today, and the kind of coupling that makes
     * "why did this paragraph change" unanswerable later. A thread holds a
     * handful of turns; the loop is the honest shape.
     */
    const rendered = await renderNarrations(db, narrations);
    if (!rendered.ok) return rendered;

    turns.push({
      id: row.id,
      question: row.question,
      kind: row.kind,
      windowDays: row.windowDays,
      askedAt: row.askedAt,
      omitted: row.omitted,
      problem: row.problem,
      paragraphs: rendered.value,
      answerable: answer?.answerable ?? false,
      unreadable: false,
      unresolvedReferences: rendered.value.reduce(
        (total, entry) => total + entry.rendered.unresolved.length + entry.rendered.orphanSlots.length,
        0,
      ),
    });
  }

  return ok({ thread: thread.value, turns });
}
