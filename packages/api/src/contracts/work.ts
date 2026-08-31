/**
 * Work contracts — §4.8.
 *
 * ## Nothing here accepts a completion day key
 *
 * A task is closed by the server, which owns the clock and the zone. A client
 * that supplied both halves of the completion pair could supply them
 * inconsistently — a `completedAt` in one day and a `completedDayKey` in
 * another — and every per-day join §4.8 exists for would then disagree with the
 * instant it was derived from. The server writes both from one instant.
 *
 * ## The task shape is small, and the smallness is the contract
 *
 * §4.8: "deliberately minimal. Not a competitor to a dedicated task manager."
 * There is no priority, no estimate and no recurrence field here because
 * accepting one would mean storing one, and a field that exists gets filled in.
 */

import { z } from 'zod';

import { dayKeySchema, instantSchema, uuidSchema, zoneSchema } from './timeline';

export const taskStatusSchema = z.enum(['open', 'done', 'dropped']);

export const projectStatusSchema = z.enum(['active', 'shipped', 'paused', 'abandoned']);

export const careerEntryKindSchema = z.enum([
  'shipped',
  'artifact',
  'feedback',
  'recognition',
  'review',
  'role_change',
  'incident',
]);

export const createProjectRequestSchema = z.object({
  id: uuidSchema,
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullish(),
  startedAt: instantSchema.nullish(),
  endedAt: instantSchema.nullish(),
  /** Employer, client, or oneself. Free text — this pillar is not a CRM. */
  context: z.string().max(200).nullish(),
  goalId: uuidSchema.nullish(),
});

export const setProjectStatusRequestSchema = z.object({
  id: uuidSchema,
  status: projectStatusSchema,
});

export const createTaskRequestSchema = z
  .object({
    id: uuidSchema,
    title: z.string().min(1).max(300),
    note: z.string().max(2000).nullish(),
    projectId: uuidSchema.nullish(),
    goalId: uuidSchema.nullish(),
    linkedEntityType: z.string().max(60).nullish(),
    linkedEntityId: uuidSchema.nullish(),
    dueDayKey: dayKeySchema.nullish(),
  })
  .refine(
    (task) => ((task.linkedEntityType ?? null) === null) === ((task.linkedEntityId ?? null) === null),
    {
      message: 'A linked entity needs both a type and an id, or neither.',
      path: ['linkedEntityId'],
    },
  );

export const closeTaskRequestSchema = z.object({
  id: uuidSchema,
  /** `open` is not a close. Reopening is its own kind below. */
  status: z.enum(['done', 'dropped']),
  /** The zone the close happened in. The server derives the day key from it. */
  zone: zoneSchema,
  droppedReason: z.string().max(500).nullish(),
});

export const careerEntryRequestSchema = z
  .object({
    id: uuidSchema,
    kind: careerEntryKindSchema,
    title: z.string().min(1).max(300),
    detail: z.string().max(5000).nullish(),
    /** The day it happened, never the day it was typed (§4.8). */
    occurredAt: instantSchema,
    zone: zoneSchema,
    projectId: uuidSchema.nullish(),
    attributedTo: z.string().max(200).nullish(),
    artifactUrl: z.string().url().max(2000).nullish(),
    isVisibleToLeadership: z.boolean().nullish(),
    skills: z.array(z.string().min(1).max(60)).max(12).optional(),
  })
  .refine(
    (entry) =>
      (entry.kind !== 'feedback' && entry.kind !== 'recognition') ||
      (entry.attributedTo ?? '').trim() !== '',
    {
      message: 'Feedback and recognition need a source. Unattributed praise is not evidence.',
      path: ['attributedTo'],
    },
  );

export const workWriteSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('project'), project: createProjectRequestSchema }),
  z.object({ kind: z.literal('project_status'), status: setProjectStatusRequestSchema }),
  z.object({ kind: z.literal('task'), task: createTaskRequestSchema }),
  z.object({ kind: z.literal('task_close'), close: closeTaskRequestSchema }),
  z.object({ kind: z.literal('task_reopen'), reopen: z.object({ id: uuidSchema }) }),
  z.object({ kind: z.literal('career'), entry: careerEntryRequestSchema }),
]);

export type WorkWriteRequest = z.infer<typeof workWriteSchema>;
export type CreateTaskRequest = z.infer<typeof createTaskRequestSchema>;
export type CareerEntryRequest = z.infer<typeof careerEntryRequestSchema>;
