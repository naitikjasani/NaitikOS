-- People and Places — the last two [V3] routes in §3.2 with no schema behind them.
--
-- `person` and `interaction` answer one question: who have I not spoken to.
-- `place`, `trip` and `visit` answer a different one, and it is the more
-- load-bearing of the two — a trip is the explanation for a simultaneous
-- discontinuity in sleep, weight, skin and training, and §10.6's detectors have
-- no way to know that unless it is written down.
--
-- The schema file records why these tables are as small as they are. The short
-- version: this stores facts about the operator's *contact* with people, not
-- facts about the people. No contact details, no closeness score, no year of
-- birth, and no record of what was said.

CREATE TYPE "public"."interaction_kind" AS ENUM('in_person', 'call', 'video', 'message', 'other');--> statement-breakpoint
CREATE TYPE "public"."place_kind" AS ENUM('home', 'city', 'country', 'venue', 'workplace', 'other');--> statement-breakpoint
CREATE TYPE "public"."relationship_kind" AS ENUM('family', 'friend', 'colleague', 'professional', 'acquaintance', 'other');--> statement-breakpoint
CREATE TYPE "public"."trip_purpose" AS ENUM('leisure', 'work', 'family', 'medical', 'other');--> statement-breakpoint
CREATE TABLE "interaction" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"person_id" uuid NOT NULL,
	"kind" "interaction_kind" NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"zone" text NOT NULL,
	"day_key" text NOT NULL,
	"note" text,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce(note, ''))) STORED
);
--> statement-breakpoint
CREATE TABLE "person" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"name" text NOT NULL,
	"relationship" "relationship_kind" NOT NULL,
	"context" text,
	"birthday" text,
	"cadence_days" integer,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce(name, '') || ' ' || coalesce(context, ''))) STORED,
	CONSTRAINT "person_cadence_positive" CHECK ("person"."cadence_days" IS NULL OR "person"."cadence_days" > 0),
	CONSTRAINT "person_birthday_partial_date" CHECK ("person"."birthday" IS NULL OR "person"."birthday" ~ '^--[0-1][0-9]-[0-3][0-9]$')
);
--> statement-breakpoint
CREATE TABLE "place" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"name" text NOT NULL,
	"kind" "place_kind" NOT NULL,
	"country_code" text,
	"zone" text,
	"latitude" text,
	"longitude" text,
	"notes" text,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce(name, '') || ' ' || coalesce(notes, ''))) STORED,
	CONSTRAINT "place_country_code" CHECK ("place"."country_code" IS NULL OR "place"."country_code" ~ '^[A-Z]{2}$')
);
--> statement-breakpoint
CREATE TABLE "trip" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"title" text NOT NULL,
	"purpose" "trip_purpose" NOT NULL,
	"started_on" text NOT NULL,
	"ended_on" text,
	"notes" text,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(notes, ''))) STORED,
	CONSTRAINT "trip_ordered" CHECK ("trip"."ended_on" IS NULL OR "trip"."started_on" <= "trip"."ended_on")
);
--> statement-breakpoint
CREATE TABLE "visit" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"place_id" uuid NOT NULL,
	"trip_id" uuid,
	"arrived_on" text NOT NULL,
	"departed_on" text,
	"notes" text,
	CONSTRAINT "visit_ordered" CHECK ("visit"."departed_on" IS NULL OR "visit"."arrived_on" <= "visit"."departed_on")
);
--> statement-breakpoint
ALTER TABLE "interaction" ADD CONSTRAINT "interaction_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit" ADD CONSTRAINT "visit_place_id_place_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."place"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit" ADD CONSTRAINT "visit_trip_id_trip_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trip"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "interaction_person_idx" ON "interaction" USING btree ("person_id","occurred_at" DESC NULLS LAST) WHERE "interaction"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "interaction_day_idx" ON "interaction" USING btree ("day_key") WHERE "interaction"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "interaction_search_idx" ON "interaction" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "person_relationship_idx" ON "person" USING btree ("relationship","name") WHERE "person"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "person_search_idx" ON "person" USING gin ("search_vector");--> statement-breakpoint
CREATE UNIQUE INDEX "place_name_unique" ON "place" USING btree ("name") WHERE "place"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "place_kind_idx" ON "place" USING btree ("kind","name") WHERE "place"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "place_search_idx" ON "place" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "trip_started_idx" ON "trip" USING btree ("started_on" DESC NULLS LAST) WHERE "trip"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "trip_search_idx" ON "trip" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "visit_arrived_idx" ON "visit" USING btree ("arrived_on" DESC NULLS LAST) WHERE "visit"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "visit_place_idx" ON "visit" USING btree ("place_id","arrived_on" DESC NULLS LAST) WHERE "visit"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "visit_trip_idx" ON "visit" USING btree ("trip_id") WHERE "visit"."deleted_at" IS NULL;
--> statement-breakpoint

-- §5.4's RLS posture, applied to the five tables above. Same block as every
-- migration that has added a table: enabled, FORCEd, and no policies at all, so
-- the PostgREST path returns nothing even if the anon key leaks. `rls.test.ts`
-- is the standing guarantee; this is today's application of it.
DO $$
DECLARE
  target regclass;
BEGIN
  FOR target IN
    SELECT c.oid::regclass
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p')
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
