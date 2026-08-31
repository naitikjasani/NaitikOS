/**
 * Learning, the calendar import, and focus sessions — §4.8.
 *
 * ## The import takes a document, not a URL
 *
 * `calendar_import` carries the body of the `.ics` file. Accepting a webcal URL
 * and fetching it server-side would be shorter to type and would turn this
 * endpoint into a proxy for arbitrary outbound requests — anything the server
 * can reach, aimed by whoever holds a session, with the response shape leaking
 * back through the parse. The operator exported the file to get the URL in the
 * first place; asking for the file costs them nothing and costs the server its
 * entire outbound surface.
 *
 * ## Four megabytes, because a calendar is not four megabytes
 *
 * A decade of a busy calendar exports at a few hundred kilobytes. The cap sits
 * an order of magnitude above the largest honest input, which is the point:
 * anything past it is a mistake — the wrong file, an archive, a paste that ran
 * away — rather than a calendar, and saying so at the wire is cheaper than
 * discovering it halfway through the parser.
 *
 * ## Nothing here accepts a computed load figure
 *
 * There is no meeting-minutes total, no load score and no per-day rollup in
 * this file. Load is derived from the events on read, and a client that could
 * write it would be a second source of truth for a number the server already
 * computes — the drift §9.3(4) forbids.
 */

import { z } from 'zod';

import { dayKeySchema, instantSchema, uuidSchema, zoneSchema } from './timeline';

/** Mirrors the `learning_kind` pgEnum. */
export const learningKindSchema = z.enum(['book', 'paper', 'course', 'talk', 'article', 'other']);

/** Mirrors the `learning_status` pgEnum. `abandoned` is an outcome, not a failure. */
export const learningStatusSchema = z.enum(['queued', 'in_progress', 'finished', 'abandoned']);

export const learningItemRequestSchema = z.object({
  id: uuidSchema,
  kind: learningKindSchema,
  title: z.string().min(1).max(300),
  author: z.string().max(200).nullish(),
  url: z.string().url().max(2000).nullish(),
  /**
   * A self-declared total, in whatever the thing counts in. Absent means no
   * fraction is shown at all — §10.9's "insufficient data" rather than a zero.
   */
  totalUnits: z.number().int().positive().nullish(),
  unitLabel: z.string().max(40).nullish(),
  skills: z.array(z.string().min(1).max(60)).max(12).optional(),
});

export const learningProgressRequestSchema = z.object({
  id: uuidSchema,
  status: learningStatusSchema,
  completedUnits: z.number().int().min(0).nullish(),
  synthesis: z.string().max(5000).nullish(),
  abandonedReason: z.string().max(500).nullish(),
});

export const learningNoteRequestSchema = z.object({
  id: uuidSchema,
  learningItemId: uuidSchema,
  content: z.string().min(1).max(10_000),
});

export const focusStartRequestSchema = z.object({
  id: uuidSchema,
  startedAt: instantSchema,
  zone: zoneSchema,
  dayKey: dayKeySchema,
  projectId: uuidSchema.nullish(),
  taskId: uuidSchema.nullish(),
  label: z.string().max(200).nullish(),
});

export const focusEndRequestSchema = z.object({
  id: uuidSchema,
  /** 1–5, the Daily Close scale. Typed in afterwards, never detected. */
  quality: z.number().int().min(1).max(5).nullish(),
  interruptions: z.number().int().min(0).nullish(),
});

export const calendarImportRequestSchema = z.object({
  /** One source in V3. §4.8 makes the import read-only, and ICS is what exports. */
  source: z.literal('ics'),
  content: z.string().min(1).max(4_000_000),
  /** The zone the calendar's floating times are read in. */
  zone: zoneSchema,
});

export const calendarTravelRequestSchema = z.object({
  id: uuidSchema,
  isTravel: z.boolean(),
});

export const learningWriteSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('learning_item'), item: learningItemRequestSchema }),
  z.object({ kind: z.literal('learning_progress'), progress: learningProgressRequestSchema }),
  z.object({ kind: z.literal('learning_note'), note: learningNoteRequestSchema }),
  z.object({ kind: z.literal('focus_start'), session: focusStartRequestSchema }),
  z.object({ kind: z.literal('focus_end'), end: focusEndRequestSchema }),
  z.object({ kind: z.literal('calendar_import'), import: calendarImportRequestSchema }),
  z.object({ kind: z.literal('calendar_travel'), travel: calendarTravelRequestSchema }),
]);

export type LearningWriteRequest = z.infer<typeof learningWriteSchema>;
export type LearningItemRequest = z.infer<typeof learningItemRequestSchema>;
export type CalendarImportRequest = z.infer<typeof calendarImportRequestSchema>;
