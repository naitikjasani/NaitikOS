CREATE TYPE "public"."life_span_kind" AS ENUM('era', 'chapter');--> statement-breakpoint
CREATE TYPE "public"."prediction_kind" AS ENUM('goal_trajectory', 'bodyweight_projection', 'load_progression', 'adherence_risk');--> statement-breakpoint
CREATE TYPE "public"."prediction_method" AS ENUM('linear_trend', 'loess_trend', 'seasonal_decomposition', 'adherence_state_model');--> statement-breakpoint
CREATE TABLE "life_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"title" text NOT NULL,
	"description" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"span_id" uuid,
	"significance" integer,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(description, ''))) STORED,
	CONSTRAINT "life_event_significance_range" CHECK ("life_event"."significance" IS NULL OR "life_event"."significance" BETWEEN 1 AND 5)
);
--> statement-breakpoint
CREATE TABLE "life_span" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"kind" "life_span_kind" NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"parent_id" uuid,
	"slot" integer,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(description, ''))) STORED,
	CONSTRAINT "life_span_ordered" CHECK ("life_span"."ended_at" IS NULL OR "life_span"."started_at" <= "life_span"."ended_at"),
	CONSTRAINT "life_span_slot_range" CHECK ("life_span"."slot" IS NULL OR "life_span"."slot" BETWEEN 1 AND 8)
);
--> statement-breakpoint
CREATE TABLE "prediction" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"kind" "prediction_kind" NOT NULL,
	"metric_key" text NOT NULL,
	"subject_type" text,
	"subject_id" uuid,
	"made_at" timestamp with time zone NOT NULL,
	"horizon_day_key" text NOT NULL,
	"predicted_value" numeric(20, 6) NOT NULL,
	"interval_low" numeric(20, 6) NOT NULL,
	"interval_high" numeric(20, 6) NOT NULL,
	"unit" text NOT NULL,
	"method" "prediction_method" NOT NULL,
	"observation_count" integer NOT NULL,
	"fit_confidence" numeric(5, 4),
	"assumptions" text NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_value" numeric(20, 6),
	"was_within_interval" boolean,
	"unresolvable_reason" text,
	CONSTRAINT "prediction_interval_ordered" CHECK ("prediction"."interval_low" <= "prediction"."predicted_value" AND "prediction"."predicted_value" <= "prediction"."interval_high"),
	CONSTRAINT "prediction_resolution_complete" CHECK (("prediction"."resolved_at" IS NULL AND "prediction"."resolved_value" IS NULL AND "prediction"."was_within_interval" IS NULL)
          OR ("prediction"."resolved_at" IS NOT NULL AND "prediction"."resolved_value" IS NOT NULL AND "prediction"."was_within_interval" IS NOT NULL)
          OR ("prediction"."resolved_at" IS NOT NULL AND "prediction"."unresolvable_reason" IS NOT NULL)),
	CONSTRAINT "prediction_observation_count" CHECK ("prediction"."observation_count" >= 0)
);
--> statement-breakpoint
CREATE INDEX "life_event_occurred_idx" ON "life_event" USING btree ("occurred_at" DESC NULLS LAST) WHERE "life_event"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "life_event_search_idx" ON "life_event" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "life_span_started_idx" ON "life_span" USING btree ("started_at") WHERE "life_span"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "life_span_kind_idx" ON "life_span" USING btree ("kind","started_at");--> statement-breakpoint
CREATE INDEX "life_span_search_idx" ON "life_span" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "prediction_horizon_idx" ON "prediction" USING btree ("horizon_day_key") WHERE "prediction"."resolved_at" IS NULL AND "prediction"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "prediction_metric_idx" ON "prediction" USING btree ("metric_key","made_at" DESC NULLS LAST);--> statement-breakpoint

-- §5.4's RLS posture, extended to the three tables above.
--
-- Same block as 0004, 0007, 0011, 0012 and 0013, for the same reason: none of
-- them can cover a table added afterwards, Postgres never complains about the
-- gap, and `rls.test.ts` is what actually holds the line.
--
-- `life_span` and `life_event` are worth naming. §10.8 calls the Life Timeline
-- "the only place a person can see their own life as a shape". The rows are
-- few, hand-written, and between them they are a biography — which makes this
-- the smallest table in the schema with the largest disclosure per row.
DO $$
DECLARE
  target regclass;
BEGIN
  FOR target IN
    SELECT c.oid::regclass
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind = 'r'
       AND NOT c.relrowsecurity
       AND c.relname <> '__drizzle_migrations'
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', target);
  END LOOP;
END;
$$;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM authenticated;
  END IF;
END;
$$;
