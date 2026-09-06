/**
 * Saved lines of enquiry — §3.2's `/ask/:threadId`.
 *
 * ## A thread is not a conversation, and this schema is what enforces that
 *
 * §2.5 makes Ask "deliberately not the primary interface", and §4.13 puts its
 * value in "the question you cannot express as a filter". A chat surface would
 * invert both: every affordance that makes something feel conversational is an
 * invitation to spend time in it, and §1.4 counts time in app as a
 * counter-metric rather than a success.
 *
 * So what §3.2 asks for is a *line of enquiry* — a question the operator
 * returns to over months, with its answers kept side by side — and the two
 * tables below are shaped for that rather than for a chat log:
 *
 *   - **A thread is created deliberately.** There is no implicit thread that
 *     every question falls into. Saving is an act; an auto-thread would make
 *     the surface stateful without anybody choosing that.
 *   - **{@link askTurn.answer} stores what the model said, not what was shown.**
 *     Templates and references, exactly as they came back. The figures are
 *     resolved at read time against the log, which is what makes a saved answer
 *     age correctly: §9.1's supersession means a correction changes what the
 *     answer renders without rewriting what the model asserted.
 *
 * ## Prior turns are never sent back to the model
 *
 * The tempting feature, and the one this schema deliberately does not enable.
 * There is no column for a conversation transcript and no ordering the context
 * builder reads, because feeding a model its own prior output makes it reason
 * over its own assertions rather than over the record — which is exactly what
 * §10.0 forbids: "the model never computes, discovers, or asserts."
 *
 * Each question is answered from a freshly assembled context pack. The thread
 * exists for the operator's continuity, not the model's.
 *
 * ## Consent is recorded per turn and never re-applied
 *
 * `ai_interaction` already keeps what was granted at the moment of a call
 * (§9.2). {@link askTurn.interactionId} points at that row, so a turn from
 * March can be read against March's consent rather than today's. Revoking a
 * scope does not retroactively make an old answer illegitimate, and it does not
 * make it legitimate either — the ledger says which.
 */

import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';

import { aiInteraction } from './ai';
import { entityColumns, instant, reference, searchVector } from './columns';

/**
 * A line of enquiry.
 *
 * Soft-deleted like every entity (§9.4). The turns point at it, and a turn
 * without its thread is a question with no reason for having been asked.
 */
export const askThread = pgTable(
  'ask_thread',
  {
    ...entityColumns,

    /**
     * What the operator is trying to find out, in their words.
     *
     * Typed, not generated from the first question. A title derived from a
     * question would describe the *asking* rather than the enquiry, and the
     * whole point of a saved line is that it outlives any one phrasing.
     */
    title: text().notNull(),

    /** Why this is worth returning to. Optional, and usually the real content. */
    note: text(),

    /**
     * When a turn was last added, denormalised.
     *
     * Stored rather than derived because the list orders by it and the
     * alternative is a correlated subquery over `ask_turn` on every page load.
     * Null until the first turn — a thread can exist as a question nobody has
     * asked yet, which is a legitimate way to use this.
     */
    lastAskedAt: instant(),

    searchVector: searchVector('title', 'note'),
  },
  (t) => [
    /* The list order. Threads never asked sort last rather than first: a
     * placeholder created months ago is not more urgent than a live enquiry. */
    index('ask_thread_recent_idx').on(t.lastAskedAt.desc()).where(sql`${t.deletedAt} IS NULL`),
    index('ask_thread_search_idx').using('gin', t.searchVector),
  ],
);

/**
 * One question and the answer it produced.
 *
 * Append-only in spirit and not by trigger: a turn is a record of an exchange
 * that happened, and editing one is rewriting what was asked. `entityColumns`
 * carries `version` and the soft-delete pair so a turn logged against the wrong
 * thread can be removed, which is a different act from pretending it was never
 * asked.
 */
export const askTurn = pgTable(
  'ask_turn',
  {
    ...entityColumns,

    threadId: reference()
      .notNull()
      .references(() => askThread.id),

    /** Exactly what was typed. Never normalised — the phrasing is the record. */
    question: text().notNull(),

    /**
     * §10.4's classification, as text rather than a `pgEnum`.
     *
     * The one place in this schema that stores a vocabulary without pinning it,
     * and the reason is that this is a *record of what the classifier decided*
     * rather than a field the operator chose. If `QUESTION_KINDS` ever gains or
     * loses a member, an enum column would make every historical turn either
     * unreadable or silently re-interpreted; text keeps a turn from March
     * saying what March's classifier said.
     */
    kind: text().notNull(),

    /** How far back the context pack reached, so an old answer is legible. */
    windowDays: integer().notNull(),

    /**
     * The answer as the model produced it — templates, references, `omitted`,
     * `answerable`.
     *
     * `jsonb`, and deliberately not decomposed into columns. The shape is
     * `answerSchema`'s and it belongs to `@naitikos/ai`; mirroring it in the
     * database would create two definitions of one thing and guarantee they
     * drift. Nothing queries inside it — the surface reads a turn whole.
     *
     * Null when no answer was produced. A refused or failed ask is still a turn
     * worth keeping: "I asked this and the layer was off" is part of the line
     * of enquiry, and dropping it would make the thread look like it was never
     * pursued.
     */
    answer: jsonb(),

    /** What the pack did not include (§10.4). Stored beside the answer it qualifies. */
    omitted: text(),

    /** Set when no answer was produced. The sentence the operator saw. */
    problem: text(),

    /**
     * The ledger row for the call that produced this (§9.2).
     *
     * Nullable, because a turn can exist without a call ever having been made —
     * the AI layer being off is the common case. When it is set, it is what
     * makes the consent in force at the time recoverable years later.
     */
    interactionId: reference().references(() => aiInteraction.id),

    askedAt: instant().notNull().default(sql`now()`),

    searchVector: searchVector('question'),
  },
  (t) => [
    index('ask_turn_thread_idx').on(t.threadId, t.askedAt.desc()).where(sql`${t.deletedAt} IS NULL`),
    index('ask_turn_search_idx').using('gin', t.searchVector),
    /*
     * An answer and a problem are mutually exclusive, and one of them is
     * required. A turn with neither is a row that says an exchange happened and
     * refuses to say what came of it; a turn with both is two accounts of the
     * same moment. Enforced here rather than by convention because the surface
     * branches on exactly this.
     */
    check('ask_turn_outcome', sql`(${t.answer} IS NULL) <> (${t.problem} IS NULL)`),
    check('ask_turn_window_positive', sql`${t.windowDays} > 0`),
  ],
);
