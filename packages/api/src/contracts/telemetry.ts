/**
 * The telemetry contract — §5.11's privacy guarantee, at the wire.
 *
 * > "Event names and numeric measurements only. **No payloads, ever.** The
 * > schema cannot represent user content, which makes leakage impossible rather
 * > than prohibited."
 *
 * This schema is the second half of that sentence. There is no `payload`, no
 * `properties`, no `metadata` — nothing that accepts an arbitrary object — so a
 * caller *cannot* send content even by accident, and a future contributor
 * cannot add one without editing this file and reading this comment.
 *
 * ## The name is a closed enum, not a string
 *
 * A free-text event name is a payload with extra steps: `capture.latency.mood_2`
 * is user content in a name field. `telemetryNameSchema` is the same closed list
 * `core/observability/ports.ts` declares, restated here because a Zod enum is
 * what actually rejects the request.
 *
 * ## The route is a pattern, never a path
 *
 * `/mind/journal/:id` and never `/mind/journal/018f…`. A populated path is an
 * identifier, an identifier is a join key, and a join key in a telemetry table
 * is the thing §5.11 is written to prevent.
 */

import { z } from 'zod';

/**
 * The permitted event names.
 *
 * Kept in step with `METRIC_NAMES` by a test in `core`, not by discipline —
 * the two lists disagreeing means a client emits an event the server silently
 * drops, which is a metric that reads as zero rather than as broken.
 */
export const telemetryNameSchema = z.enum([
  'capture.latency',
  'daily_close.started',
  'daily_close.submitted',
  'daily_close.duration',
  'observation.written',
  'event.published',
  'event.handler.duration',
  'event.dead_lettered',
  'timeline.query.duration',
  'media.upload.duration',
  'media.upload.bytes',
  'media.duplicate_detected',
  'job.run.duration',
  'job.step.duration',
  'job.step.failed',
  'sync.outbox.depth',
  'sync.outbox.oldest_age_seconds',
  'sync.failed',
  'api.request.duration',
  'api.request.failed',
  'route.transition',
  'nutrition.log.duration',
]);

export type TelemetryName = z.infer<typeof telemetryNameSchema>;

/**
 * A route *pattern*. Rejects anything containing a UUID.
 *
 * Belt and braces over the client's own templating: the check is cheap and the
 * failure it prevents — an entity id in the telemetry table — is permanent.
 */
const UUID_IN_PATH = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu;

export const routePatternSchema = z
  .string()
  .max(120)
  .refine((value) => !UUID_IN_PATH.test(value), {
    message: 'Route must be a pattern (/mind/journal/:id), never a populated path (§5.11).',
  });

export const telemetryEventSchema = z.object({
  name: telemetryNameSchema,
  /**
   * One number. Milliseconds, bytes, a count — the unit is fixed per name.
   *
   * Bounded on both sides: a negative duration is a clock going backwards and a
   * value past a day in milliseconds is a tab that was left open over a weekend.
   * Neither is a measurement, and both would poison a median.
   */
  value: z.number().int().min(0).max(86_400_000).nullish(),
  route: routePatternSchema.nullish(),
  /** The client's instant. The server records its own `occurred_at` regardless. */
  at: z.string().datetime({ offset: true }).nullish(),
  deviceClass: z.enum(['phone', 'tablet', 'desktop']).nullish(),
});

export type TelemetryEvent = z.infer<typeof telemetryEventSchema>;

/**
 * A batch.
 *
 * Batched because the alternative is a network request per route transition,
 * which would make the counter-metric worse by measuring it — §1.4's "time in
 * app" rising because telemetry is chatty is the funniest possible way to fail
 * this phase, and it is a real one.
 */
export const telemetryBatchSchema = z.object({
  events: z.array(telemetryEventSchema).min(1).max(50),
  zone: z.string().max(64).nullish(),
});

export type TelemetryBatch = z.infer<typeof telemetryBatchSchema>;
