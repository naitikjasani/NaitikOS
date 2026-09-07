-- The three telemetry dimensions `app_event` had no columns for.
--
-- `MetricDimensions` in `@naitikos/core` declares five — `route`,
-- `deviceClass`, `eventType`, `stepName`, `outcome` — and this table held two.
-- `createPostgresMetrics` accepted all five and silently persisted two, which
-- did not merely coarsen the data; it made two metrics unable to say the thing
-- they exist to say.
--
--   `job.step.duration` and `job.step.failed` carried no step name, so a
--   seventeen-step nightly pipeline recorded one undifferentiated counter.
--
--   `Metrics.time()` sets `outcome` deliberately, and its own comment gives the
--   reason: "measuring only the happy path hides the case where failures are
--   slow, which is the case worth knowing about." The value was dropped, so the
--   distinction could not be drawn.
--
-- Three nullable `text` columns, no backfill and no default. Every existing row
-- keeps NULL, which is the honest value: those measurements were taken by a
-- writer that never captured these dimensions, and inventing one retroactively
-- would be worse than the gap.
--
-- §13.2 keeps this migration separate from the writer that fills the columns.
-- Applied first, it is a no-op for the running application; the writer follows
-- in its own commit and finds the columns already there. That ordering is
-- §5.15's forward-compatibility discipline, and it is the reason a deploy
-- cannot land an application ahead of its database.
--
-- `text` rather than an enum, matching `deviceClass`. §5.11 gives this table a
-- ninety-day retention and calls telemetry the least important data in the
-- system; an enum would make adding an outcome a migration, which is a poor
-- price for a column whose rows expire in a quarter.

ALTER TABLE "app_event" ADD COLUMN "event_type" text;--> statement-breakpoint
ALTER TABLE "app_event" ADD COLUMN "step_name" text;--> statement-breakpoint
ALTER TABLE "app_event" ADD COLUMN "outcome" text;