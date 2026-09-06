/**
 * Saved lines of enquiry at the wire — §3.2's `/ask/:threadId`.
 *
 * ## Asking is one endpoint, with an optional thread
 *
 * `/api/ask` already takes a question and returns an answer. Adding a thread id
 * to it is the whole of this feature at the wire, and the alternative — a
 * second endpoint that asks *and* saves — would be two paths to one behaviour,
 * differing only in whether a row is written afterwards.
 *
 * ## Nothing here accepts an answer
 *
 * A client cannot post a turn carrying an answer it composed. The answer is
 * produced server-side by the same call that stores it, which is what keeps
 * §10.10's guarantee intact end to end: a client able to write an answer could
 * write one containing a number, and every structural control in
 * `schemas/references.ts` would be bypassed by a POST.
 *
 * That is why there is no `turn` write kind below. A turn comes into existence
 * exactly one way — by asking.
 */

import { z } from 'zod';

import { uuidSchema } from './timeline';

export const threadRequestSchema = z.object({
  id: uuidSchema,
  /** Typed, never generated from a question. See the schema file. */
  title: z.string().min(1).max(200),
  note: z.string().max(2000).nullish(),
});

/**
 * Removing a thread or a turn.
 *
 * `reason` is optional, for the reason §9.4 gives everywhere else: the point is
 * to *ask* why, not to refuse the deletion without an answer. A mandatory field
 * becomes "x" within a week and the audit log records nothing.
 */
export const enquiryDeleteSchema = z.object({
  id: uuidSchema,
  reason: z.string().max(500).nullish(),
});

export const enquiryWriteSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('thread'), thread: threadRequestSchema }),
  z.object({ kind: z.literal('thread_delete'), delete: enquiryDeleteSchema }),
  z.object({ kind: z.literal('turn_delete'), delete: enquiryDeleteSchema }),
]);

export type EnquiryWriteRequest = z.infer<typeof enquiryWriteSchema>;
