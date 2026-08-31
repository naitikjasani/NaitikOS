CREATE TYPE "public"."sleep_disturbance" AS ENUM('noise', 'light', 'temperature', 'pain', 'anxiety', 'bathroom', 'illness', 'device', 'other');--> statement-breakpoint
CREATE TABLE "sleep_night" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"day_key" text NOT NULL,
	"zone" text NOT NULL,
	"bed_at" timestamp with time zone,
	"woke_at" timestamp with time zone,
	"duration_hours" numeric(20, 6),
	"quality" integer,
	"latency_minutes" integer,
	"wakings" integer,
	"disturbance" "sleep_disturbance",
	"disturbance_note" text,
	"note" text,
	CONSTRAINT "sleep_night_ordered" CHECK ("sleep_night"."woke_at" IS NULL OR "sleep_night"."bed_at" IS NULL OR "sleep_night"."bed_at" < "sleep_night"."woke_at"),
	CONSTRAINT "sleep_night_quality_range" CHECK ("sleep_night"."quality" IS NULL OR "sleep_night"."quality" BETWEEN 1 AND 5),
	CONSTRAINT "sleep_night_duration_range" CHECK ("sleep_night"."duration_hours" IS NULL OR ("sleep_night"."duration_hours" >= 0 AND "sleep_night"."duration_hours" <= 24)),
	CONSTRAINT "sleep_night_latency_range" CHECK ("sleep_night"."latency_minutes" IS NULL OR ("sleep_night"."latency_minutes" >= 0 AND "sleep_night"."latency_minutes" <= 600)),
	CONSTRAINT "sleep_night_wakings_range" CHECK ("sleep_night"."wakings" IS NULL OR "sleep_night"."wakings" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "sleep_night_day_unique" ON "sleep_night" USING btree ("day_key") WHERE "sleep_night"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "sleep_night_day_idx" ON "sleep_night" USING btree ("day_key" DESC NULLS LAST) WHERE "sleep_night"."deleted_at" IS NULL;--> statement-breakpoint

-- §5.4's RLS posture, extended to `sleep_night`.
--
-- Same block as 0004, 0007 and 0011, for the same reason: neither of those can
-- cover a table added afterwards, Postgres never complains about the gap, and
-- `rls.test.ts` is what actually holds the line. Enabled, FORCEd, no policies —
-- so the PostgREST path reaches a database that returns nothing even holding
-- the anon key that ships in the browser bundle.
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
